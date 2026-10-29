"use client";
import { useState, type ReactNode } from "react";
import { DndContext, useDraggable, closestCenter, pointerWithin, PointerSensor, KeyboardSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { useSortable, SortableContext, verticalListSortingStrategy, sortableKeyboardCoordinates, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
export type BuilderDrop = { kind: "section" | "item" | "expression"; id: string; parentId: string; orderedIds: string[]; materialId?: string | null };
export type LibraryDrag = { kind: "material"; materialId: string; evidenceId?: string };
export function ResumeBuilderDnd({ children, disabled, onSort, onAttach }: { children: ReactNode; disabled: boolean; onSort: (target: BuilderDrop, ids: string[]) => Promise<void>; onAttach: (source: LibraryDrag, target: BuilderDrop) => Promise<void> }) {
  const candidatesFor = (source: BuilderDrop | LibraryDrag | undefined, target: BuilderDrop | undefined) => {
    if (!source || !target) return false;
    if (source.kind === "material") return target.kind === "section" || Boolean(source.evidenceId && target.kind === "item" && target.materialId === source.materialId);
    return target.kind === source.kind && target.parentId === source.parentId;
  };
  const keyboardCoordinates: typeof sortableKeyboardCoordinates = (event, args) => {
    const source = args.context.active?.data.current as BuilderDrop | LibraryDrag | undefined;
    if (source?.kind === "material" && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.code)) {
      event.preventDefault();
      const targets = args.context.droppableContainers.getEnabled().filter((c) => candidatesFor(source, c.data.current as BuilderDrop | undefined) && args.context.droppableRects.has(c.id));
      const current = targets.findIndex((c) => c.id === args.context.over?.id);
      const forward = event.code === "ArrowDown" || event.code === "ArrowRight";
      const index = current < 0 ? (forward ? 0 : targets.length - 1) : Math.max(0, Math.min(targets.length - 1, current + (forward ? 1 : -1)));
      const rect = targets[index] && args.context.droppableRects.get(targets[index].id);
      const active = args.context.collisionRect;
      if (rect && active) return { x: rect.left + (rect.width - active.width) / 2, y: rect.top + (rect.height - active.height) / 2 };
      return;
    }
    const containers = new Proxy(args.context.droppableContainers, {
      get(target, key) {
        if (key === "getEnabled") return () => target.getEnabled().filter((c) => candidatesFor(source, c.data.current as BuilderDrop | undefined));
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return sortableKeyboardCoordinates(event, { ...args, context: { ...args.context, droppableContainers: containers } });
  };
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }));
  const [busy, setBusy] = useState(false);
  const collision = (args: Parameters<typeof closestCenter>[0]) => {
    const source = args.active.data.current as BuilderDrop | LibraryDrag | undefined;
    const candidates = args.droppableContainers.filter((c) => candidatesFor(source, c.data.current as BuilderDrop | undefined));
    if (args.pointerCoordinates) {
      const underPointer = pointerWithin({ ...args, droppableContainers: candidates.filter((c) => c.id !== args.active.id) });
      if (underPointer.length) return underPointer;
    }
    return closestCenter({ ...args, droppableContainers: candidates });
  };
  const end = async ({ active, over }: DragEndEvent) => {
    if (disabled || busy || !over || active.id === over.id) return;
    const source = active.data.current as BuilderDrop | LibraryDrag | undefined;
    const target = over.data.current as BuilderDrop | undefined;
    if (!source || !target || !["section", "item", "expression"].includes(target.kind)) return;
    setBusy(true);
    try {
      if (source.kind === "material") await onAttach(source, target);
      else if (source.kind === target.kind && source.parentId === target.parentId) {
        const from = source.orderedIds.indexOf(source.id), to = source.orderedIds.indexOf(target.id);
        if (from >= 0 && to >= 0) await onSort(source, arrayMove(source.orderedIds, from, to));
      }
    } finally { setBusy(false); }
  };
  return <DndContext sensors={sensors} collisionDetection={collision} onDragEnd={(event) => void end(event)}><div aria-busy={busy}>{children}</div></DndContext>;
}
export function BuilderSortableGroup({ ids, children }: { ids: string[]; children: ReactNode }) {
  return <SortableContext items={ids} strategy={verticalListSortingStrategy}>{children}</SortableContext>;
}
export function BuilderSortable({ data, disabled, hidden, children }: { data: BuilderDrop; disabled: boolean; hidden?: boolean; children: ReactNode }) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isOver } = useSortable({ id: data.id, data, disabled });
  return <div data-resume-sortable={data.id} ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`relative min-w-0 ${hidden ? "opacity-60" : ""} ${isOver ? "ring-2 ring-primary" : ""}`}>
    {!disabled && <button ref={setActivatorNodeRef} type="button" {...attributes} {...listeners} aria-label={t("resumeBuilder.dragHandle")} className="absolute -left-1 top-1 z-10 rounded bg-background p-1 touch-none"><GripVertical className="h-4 w-4" /></button>}
    {children}
  </div>;
}
function LibraryEntry({ label, data, disabled, onAdd }: { label: string; data: LibraryDrag; disabled: boolean; onAdd: () => void }) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform } = useDraggable({ id: `library:${data.materialId}:${data.evidenceId ?? "all"}`, data, disabled });
  return <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform) }} className="flex items-start gap-1 rounded border bg-background p-2">
    <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners} disabled={disabled} aria-label={t("resumeBuilder.dragHandle")} className="touch-none"><GripVertical className="h-4 w-4" /></button>
    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs">{label}</span>
    <Button size="sm" variant="ghost" disabled={disabled} onClick={onAdd}>{t("resumeBuilder.add")}</Button>
  </div>;
}
export function ResumeMaterialLibrary({ materials, sections, disabled, onAdd }: {
  materials: { id: string; title: string; type: string; summary?: string; evidence: { id: string; content: string }[] }[];
  sections: { id: string; title: string }[]; disabled: boolean; onAdd: (source: LibraryDrag, sectionId: string) => void;
}) {
  const { t } = useI18n(); const [search, setSearch] = useState(""); const [target, setTarget] = useState("");
  const selected = sections.some((s) => s.id === target) ? target : sections[0]?.id ?? "";
  const matches = materials.filter((m) => `${m.title} ${m.evidence.map((e) => e.content).join(" ")}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const groups = [...new Set(matches.map((m) => m.type))];
  return <aside className="min-w-0 space-y-3 rounded-lg border p-3 xl:sticky xl:top-4 xl:max-h-[85vh] xl:overflow-y-auto" aria-label={t("resumeBuilder.library")}>
    <h2 className="font-medium">{t("resumeBuilder.library")}</h2>
    <p className="text-xs text-muted-foreground">{t("resumeBuilder.libraryHint")}</p>
    <Input aria-label={t("resumeBuilder.search")} placeholder={t("resumeBuilder.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
    <label className="block text-xs">{t("resumeBuilder.targetSection")}<select className="mt-1 w-full rounded border bg-background p-2" value={selected} disabled={disabled || !sections.length} onChange={(e) => setTarget(e.target.value)}>{sections.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
    {!matches.length && <p className="text-sm text-muted-foreground">{t("resumeVariants.materialPickerEmpty")}</p>}
    {groups.map((type) => <div key={type} className="space-y-2"><h3 className="text-sm font-medium">{t(`applicationProfile.materialType${type}`)}</h3>{matches.filter((m) => m.type === type).map((m) => <div key={m.id} className="space-y-1">
      <LibraryEntry label={m.summary || m.title} disabled={disabled || !selected} data={{ kind: "material", materialId: m.id }} onAdd={() => onAdd({ kind: "material", materialId: m.id }, selected)} />
      <details className="ml-3"><summary className="cursor-pointer text-xs">{t("resumeBuilder.evidence", { count: m.evidence.length })}</summary><div className="mt-1 space-y-1">{m.evidence.map((e) => <LibraryEntry key={e.id} label={e.content} disabled={disabled || !selected} data={{ kind: "material", materialId: m.id, evidenceId: e.id }} onAdd={() => onAdd({ kind: "material", materialId: m.id, evidenceId: e.id }, selected)} />)}</div></details>
    </div>)}</div>)}
  </aside>;
}
