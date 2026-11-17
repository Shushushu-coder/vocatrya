"use client";
import { useEffect, useRef, useState } from "react";
import { CircleHelp } from "lucide-react";
import { useI18n } from "@/i18n";
import { getAgentPreferences, saveAgentPreferences } from "@/actions/agentPreferences.actions";
import { AUTO_ARCHIVE_DAYS, PERSONAL_INSTRUCTIONS_MAX, DEFAULT_AGENT_PREFERENCES, type AgentPreferences } from "@/lib/agent/preferences";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";

export const permissionLabels = {
  "zh-CN": { ask: "请求审批", rules: "帮我审批", full: "完全访问" },
  en: { ask: "Ask for approval", rules: "Approve by rules", full: "Full access" },
};
export function PermissionHelp({ english }: { english: boolean }) {
  const labels = permissionLabels[english ? "en" : "zh-CN"];
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = () => { clearTimeout(timer.current); setOpen(true); };
  const hide = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), 180); };
  useEffect(() => () => clearTimeout(timer.current), []);
  return <Popover open={open} onOpenChange={setOpen}><PopoverAnchor asChild><button type="button" onClick={show} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} aria-label={english ? "Permission modes" : "权限模式说明"} title={english ? "Compare permission modes" : "查看三种权限的区别"} className="rounded p-1 text-muted-foreground"><CircleHelp className="size-4" /></button></PopoverAnchor>
    <PopoverContent onOpenAutoFocus={e => e.preventDefault()} onInteractOutside={e => e.preventDefault()} onMouseEnter={show} onMouseLeave={hide} onFocusCapture={show} onBlurCapture={hide} className="w-[min(34rem,calc(100vw-2rem))] text-xs" align="start"><table className="w-full text-left"><caption className="mb-2 text-left font-medium">{english ? "Business tool permissions" : "业务工具的三档权限"}</caption><tbody>
      <tr><th className="p-2 align-top">{labels.ask}</th><td className="p-2">{english ? "Ask before tools that require approval; reads and analysis remain available." : "需要批准的写入和操作先请示；已授权读取与分析不反复询问。"}</td></tr>
      <tr><th className="p-2 align-top">{labels.rules}</th><td className="p-2">{english ? "Automatically allow local additions and versioned outputs. External writes and irreversible changes still require approval." : "本地新增和保留版本的结果自动执行；外部写入及不可逆操作仍需批准。"}</td></tr>
      <tr><th className="p-2 align-top">{labels.full}</th><td className="p-2">{english ? "Allow supported business tools in the granted scope without per-tool prompts. Does not grant missing account or native runtime permissions." : "已授权范围内的受支持业务工具不逐项打断；不会获得缺失的账号权限或原生运行时权限。"}</td></tr>
    </tbody></table></PopoverContent></Popover>;
}

export default function AgentPreferencesSettings() {
  const { locale } = useI18n();
  const en = locale === "en";
  const [value, setValue] = useState<AgentPreferences>(DEFAULT_AGENT_PREFERENCES);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  useEffect(() => { let live = true; void getAgentPreferences().then(v => { if (live) { setValue(v); setLoaded(true); } }).catch(() => { if (live) setStatus(en ? "Unable to load preferences. Reopen settings to retry." : "设置加载失败，请重新打开设置重试。"); }); return () => { live = false; }; }, [en]);
  const count = Array.from(value.personalInstructions).length;
  const change = <K extends keyof AgentPreferences>(key: K, next: AgentPreferences[K]) => { setValue(v => ({ ...v, [key]: next })); setStatus(""); };
  const save = async () => {
    setSaving(true); setStatus("");
    try { const r = await saveAgentPreferences(value); setStatus(r?.success ? (en ? "Saved" : "已保存") : (en ? "Save failed. Please retry." : "保存失败，请重试。")); }
    catch { setStatus(en ? "Save failed. Please retry." : "保存失败，请重试。"); }
    finally { setSaving(false); }
  };
  return <fieldset disabled={!loaded || saving} className="min-w-0 space-y-5 border-t pt-5" data-testid="agent-preferences-settings">
    <legend className="text-base font-medium">{en ? "Chat history and Agent preferences" : "聊天记录与 Agent 偏好"}</legend>
    <div className="space-y-2"><label htmlFor="auto-archive-days" className="text-sm font-medium">{en ? "Automatically archive inactive chats" : "自动归档不活跃的聊天"}</label>
      <p className="text-sm text-muted-foreground">{en ? "Archived chats are hidden from the Agent until restored. Active tasks and pending approvals are excluded." : "归档后 Agent 不再读取其内容，恢复后可继续。执行中、待审批及关联未完成任务的聊天不自动归档。"}</p>
      <select id="auto-archive-days" value={value.autoArchiveDays} onChange={e => change("autoArchiveDays", Number(e.target.value) as AgentPreferences["autoArchiveDays"])} className="rounded-md border bg-background p-2 text-sm">{AUTO_ARCHIVE_DAYS.map(d => <option key={d} value={d}>{d === 0 ? (en ? "Never" : "永不") : (en ? `${d} days` : `${d} 天`)}</option>)}</select>
    </div>
    <div className="flex items-start justify-between gap-4"><div className="space-y-2"><label htmlFor="compress-chat-history" className="text-sm font-medium">{en ? "Compress local chat history" : "压缩本地保存的聊天历史记录"}</label><p className="text-sm text-muted-foreground">{en ? "Losslessly compress records older than 7 days while the app runs. Original messages remain readable and restorable. Turning off stops future compression." : "应用运行时无损压缩超过 7 天的历史，保留完整消息与工具记录，不影响恢复。关闭后停止后续压缩，已有压缩记录仍可读取。"}</p></div><Switch id="compress-chat-history" checked={value.compressHistory} onCheckedChange={v => change("compressHistory", v)} /></div>
    <div className="space-y-2"><label htmlFor="personal-instructions" className="text-sm font-medium">{en ? "Custom instructions" : "自定义提示词"}</label><p id="personal-instructions-hint" className="text-sm text-muted-foreground">{en ? "Personal instructions for every Agent conversation. Empty disables them. Changes apply on the next message; background parsing and summaries are excluded. Application and runtime rules still apply." : "为每段 Agent 对话注入个人偏好，留空关闭。修改从下一条消息生效，不注入后台解析和摘要。应用与运行时规则仍然有效。"}</p>
      <Textarea id="personal-instructions" aria-describedby="personal-instructions-hint personal-instructions-count" value={value.personalInstructions} onChange={e => change("personalInstructions", e.target.value)} rows={5} />
      <p id="personal-instructions-count" className={count > PERSONAL_INSTRUCTIONS_MAX ? "text-sm text-destructive" : "text-xs text-muted-foreground"}>{count}/{PERSONAL_INSTRUCTIONS_MAX}{count > PERSONAL_INSTRUCTIONS_MAX ? (en ? " — shorten before saving" : "，请缩短后保存") : ""}</p>
    </div>
    <div className="space-y-2"><div className="flex items-center gap-1"><label htmlFor="default-agent-permission" className="text-sm font-medium">{en ? "Default permissions" : "默认权限"}</label><PermissionHelp english={en} /></div><p className="text-sm text-muted-foreground">{en ? "Initial business-tool permissions for new chats. Change them in the composer before starting. Existing chats keep their original mode." : "设置新会话的初始业务工具权限；开始前仍可在输入区更改，现有会话保持原权限。"}</p>
      <select id="default-agent-permission" value={value.defaultPermission} onChange={e => change("defaultPermission", e.target.value as AgentPreferences["defaultPermission"])} className="rounded-md border bg-background p-2 text-sm">{Object.entries(permissionLabels[en ? "en" : "zh-CN"]).map(([mode, label]) => <option key={mode} value={mode}>{label}{mode === "rules" ? (en ? " (recommended)" : "（推荐）") : ""}</option>)}</select>
    </div>
    <Button type="button" disabled={!loaded || saving || count > PERSONAL_INSTRUCTIONS_MAX} onClick={() => void save()}>{saving ? (en ? "Saving…" : "保存中…") : (en ? "Save preferences" : "保存偏好")}</Button>
    <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{status}</p>
  </fieldset>;
}
