"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, ListTodo, ArrowRight, ChevronUp, ChevronDown, X, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { getTodayPlan, mutateTodayPlan, undoTodayPlan } from "@/actions/todayPlan.actions";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { TODAY_PLAN_CHANGED_EVENT, type TodayPlanItemView, type TodayPlanView, type TodayPlanWriteInput } from "@/lib/todayPlan/types";

function PlanRow({ item, onWrite, editLabel, removeLabel, saveLabel, navLabel, onShift, first, last }: {
  item: TodayPlanItemView;
  onWrite: (input: TodayPlanWriteInput) => Promise<boolean>;
  editLabel: string; removeLabel: string; saveLabel: string; navLabel: string;
  onShift?: (dir: -1 | 1) => void; first: boolean; last: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);
  return <li className="group flex flex-wrap items-center gap-2 px-3 py-1.5">
    <button type="button" role="checkbox" aria-label={item.title} aria-checked={item.completed}
      onClick={() => void onWrite({ action: "toggle", selector: { itemId: item.id }, completed: !item.completed })}
      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-primary">
      {item.completed && <Check className="h-3 w-3" />}
    </button>
    {editing ? <form className="flex min-w-0 flex-1 gap-1" onSubmit={async e => {
      e.preventDefault();
      if (await onWrite({ action: "rename", selector: { itemId: item.id }, newTitle: title })) setEditing(false);
    }}><input autoFocus aria-label={editLabel} value={title} maxLength={200} onChange={e => setTitle(e.target.value)} className="min-w-0 flex-1 border" />
      <button type="submit" disabled={!title.trim()}>{saveLabel}</button></form>
      : <span title={item.title} className={cn("min-w-0 flex-1 truncate text-sm", item.completed && "text-muted-foreground line-through")}>{item.title}</span>}
    <Link href="/dashboard/tasks" aria-label={navLabel}><ArrowRight className="h-3.5 w-3.5" /></Link>
    <details className="text-xs"><summary>{editLabel}</summary><div className="flex flex-wrap items-center gap-2 py-1">
      <button type="button" aria-label={editLabel} onClick={() => { setTitle(item.title); setEditing(true); }}><Pencil className="h-3.5 w-3.5" /></button>
      {onShift && <><button type="button" aria-label="move up" disabled={first} onClick={() => onShift(-1)}><ChevronUp className="h-3.5 w-3.5" /></button>
        <button type="button" aria-label="move down" disabled={last} onClick={() => onShift(1)}><ChevronDown className="h-3.5 w-3.5" /></button></>}
      <button type="button" aria-label={removeLabel} title={removeLabel} onClick={() => void onWrite({ action: "remove", selector: { itemId: item.id } })}><X className="h-3.5 w-3.5" /></button>
    </div></details>
  </li>;
}

export function TodayPlanEntry({ variant = "ghost", className }: { variant?: "ghost" | "outline"; className?: string }) {
  const { t } = useI18n();
  const { conversationId, activeRole, ensureTodayPlanConversation } = useAgentChat();
  const scope = `${activeRole}:${conversationId ?? ""}`;
  const current = useRef({ scope, conversationId, epoch: 0 });
  if (current.current.scope !== scope) current.current = { scope, conversationId, epoch: current.current.epoch + 1 };
  const [loaded, setLoaded] = useState<TodayPlanView | null>(null);
  const view = loaded?.conversationId === conversationId ? loaded : null;
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [undo, setUndo] = useState<{ conversationId: string; operationId: string } | null>(null);
  const serial = useRef(0);
  const reload = useCallback(async () => {
    const request = ++serial.current;
    const epoch = current.current.epoch;
    if (!conversationId) { setLoaded(null); setLoading(false); return; }
    setLoading(true);
    try {
      const res = await getTodayPlan(conversationId);
      if (request !== serial.current || epoch !== current.current.epoch) return;
      if (res.success && res.data?.conversationId === conversationId) { setLoaded(res.data); setError(null); }
      else { setLoaded(null); setError(res.message ?? t("todayPlan.loadFailed")); }
    } catch {
      if (request === serial.current && epoch === current.current.epoch) { setLoaded(null); setError(t("todayPlan.loadFailed")); }
    } finally {
      if (request === serial.current && epoch === current.current.epoch) setLoading(false);
    }
  }, [conversationId, t]);
  useEffect(() => {
    const requestSerial = serial;
    setLoaded(null); setUndo(null); setError(null); setAdding(""); void reload();
    return () => { requestSerial.current++; };
  }, [scope, reload]);
  useEffect(() => {
    const changed = (e: Event) => { if ((e as CustomEvent).detail?.conversationId === conversationId) void reload(); };
    const visible = () => { if (document.visibilityState === "visible") void reload(); };
    window.addEventListener(TODAY_PLAN_CHANGED_EVENT, changed);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    const timer = setInterval(visible, 60_000);
    return () => { window.removeEventListener(TODAY_PLAN_CHANGED_EVENT, changed); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); clearInterval(timer); };
  }, [conversationId, reload]);
  const write = async (input: TodayPlanWriteInput) => {
    if (pendingRef.current) return false;
    pendingRef.current = true; setPending(true); setError(null);
    let cid = conversationId;
    let epoch = current.current.epoch;
    const originScope = current.current.scope;
    let created = false;
    const stillCurrent = () => current.current.epoch === epoch || (created && current.current.epoch === epoch + 1 && current.current.scope === `${activeRole}:${cid}`);
    try {
      if (!cid) {
        cid = await ensureTodayPlanConversation();
        created = true;
        if (!cid) { if (epoch === current.current.epoch) setError(t("todayPlan.createFailed")); return false; }
        if (!stillCurrent() || (current.current.scope !== originScope && current.current.scope !== `${activeRole}:${cid}`)) return false;
      }
      const res = await mutateTodayPlan({ conversationId: cid, operationKey: crypto.randomUUID(), write: input });
      window.dispatchEvent(new CustomEvent(TODAY_PLAN_CHANGED_EVENT, { detail: { conversationId: cid } }));
      if (!stillCurrent()) return false;
      if (!res.success || res.data?.status !== "ok") {
        setError(res.message ?? t(`todayPlan.status.${res.data?.status ?? "failed"}`, { title: "" })); return false;
      }
      if (res.data.undoable) setUndo({ conversationId: cid, operationId: res.data.operationId });
      if (conversationId === cid) await reload();
      return true;
    } catch { if (epoch === current.current.epoch) setError(t("todayPlan.status.failed")); return false; }
    finally { pendingRef.current = false; setPending(false); }
  };
  const section = (label: string, items: TodayPlanItemView[], target?: "today" | "tomorrow") => items.length > 0 && <section className="border-t py-1" key={label}>
    <h3 className="px-3 text-xs text-muted-foreground">{label}</h3><ul>{items.map((item, index) => <div key={item.id}>
      <PlanRow item={item} onWrite={write} editLabel={t("todayPlan.edit")} removeLabel={t("todayPlan.remove")} saveLabel={t("todayPlan.save")} navLabel={t("todayPlan.openTask")} first={index === 0} last={index === items.length - 1}
        onShift={target ? dir => { const ids = items.map(i => i.id); [ids[index], ids[index + dir]] = [ids[index + dir], ids[index]]; void write({ action: "reorder", target, itemIds: ids }); } : undefined} />
      <div className="flex gap-3 px-10 text-xs">
        <button type="button" disabled={pending || item.plannedOn === view?.today} onClick={() => void write({ action: "move", selector: { itemId: item.id }, target: "today" })}>{t("todayPlan.moveToday")}</button>
        <button type="button" disabled={pending || item.plannedOn === view?.tomorrow} onClick={() => void write({ action: "move", selector: { itemId: item.id }, target: "tomorrow" })}>{t("todayPlan.moveTomorrow")}</button>
      </div>
    </div>)}</ul>
  </section>;
  return <Popover onOpenChange={open => { if (open) void reload(); }}>
    <PopoverTrigger asChild><Button variant={variant} size="icon" className={cn("relative", className)} aria-label={t("todayPlan.triggerLabel")} title={t("todayPlan.triggerTooltip")}>
      <ListTodo className="h-4 w-4" />{view && view.buckets.today.length > 0 && <span className="absolute -right-1 -top-1 rounded-full bg-primary px-1 text-[10px] text-primary-foreground">{view.buckets.today.filter(i => i.completed).length}/{view.buckets.today.length}</span>}
    </Button></PopoverTrigger>
    <PopoverContent align="end" className="w-80 max-w-[calc(100vw-1rem)] p-0">
      <div className="max-h-96 overflow-y-auto">
        <div className="px-3 py-2 text-sm">{view?.conversationTitle ?? t("todayPlan.untitled")} {view?.today}</div>
        {loading && <p role="status" className="px-3">{t("todayPlan.loading")}</p>}
        {error && <div role="alert" className="px-3 text-sm text-destructive">{error}<button type="button" onClick={() => void reload()}>{t("todayPlan.retry")}</button></div>}
        {!conversationId && <p className="px-3 py-2 text-sm">{t("todayPlan.empty")}</p>}
        {view && <>{section(t("todayPlan.overdue"), view.buckets.overdue)}{section(t("todayPlan.today"), view.buckets.today, "today")}{section(t("todayPlan.tomorrow"), view.buckets.tomorrow, "tomorrow")}{section(t("todayPlan.later"), view.buckets.later)}{section(t("todayPlan.history"), view.buckets.history)}</>}
        <form className="flex gap-2 border-t px-3 py-2" onSubmit={async e => {
          e.preventDefault(); const title = adding.trim(); if (!title) return;
          const epoch = current.current.epoch;
          if (await write({ action: "add", titles: [title], target: "today" })) { if (epoch === current.current.epoch || !conversationId) setAdding(""); }
        }}>
          <input aria-label={t("todayPlan.addPlaceholder")} placeholder={t("todayPlan.addPlaceholder")} value={adding} maxLength={200} onChange={e => setAdding(e.target.value)} className="min-w-0 flex-1 bg-transparent text-sm" />
          <button type="submit" disabled={pending || !adding.trim()}>{t(conversationId ? "todayPlan.add" : "todayPlan.createAndAdd")}</button>
        </form>
        {undo?.conversationId === conversationId && <button type="button" className="px-3 py-2 text-xs" disabled={pending} onClick={async () => {
          const epoch = current.current.epoch;
          const res = await undoTodayPlan(undo);
          if (epoch !== current.current.epoch) return;
          if (res.success && res.data?.status === "ok") { setUndo(null); await reload(); if (res.data.skipped.length) setError(t("todayPlan.undoSkipped")); }
          else setError(t("todayPlan.status.failed"));
        }}>{t("todayPlan.undo")}</button>}
      </div>
    </PopoverContent>
  </Popover>;
}
