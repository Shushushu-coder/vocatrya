import { z } from "zod";

const state = z.object({ plannedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), position: z.number().int(), updatedAt: z.string().datetime() });
const taskState = z.object({ title: z.string(), status: z.string(), updatedAt: z.string().datetime() });
const entriesSchema = z.array(z.object({ taskId: z.string(), planItemId: z.string().nullable(), before: state.nullable(), after: state.nullable(), taskBefore: taskState.nullable(), taskAfter: taskState.nullable() }));

/** Only references to this backup's typed, same-conversation rows may survive.
 * Removed plan rows need no id; absent/malformed undo images are inert. */
export function restoreTodayPlanLedger(row: Record<string, unknown>, input: {
  operationId: string;
  mapId: (id: string) => string | undefined;
  taskIds: Set<string>;
  items: Map<string, { conversationId: string; taskId: string }>;
}) {
  const { mapId, taskIds, items, operationId } = input;
  let undoJson: string | null = null;
  let resultJson: string | null = null;
  try {
    const entries = entriesSchema.parse(JSON.parse(String(row.undoJson)));
    const safe = entries.flatMap(entry => {
      const taskId = taskIds.has(entry.taskId) ? mapId(entry.taskId) : undefined;
      const item = entry.planItemId ? items.get(entry.planItemId) : undefined;
      if (!taskId || (entry.after && (!item || item.conversationId !== row.conversationId || item.taskId !== entry.taskId))) return [];
      return [{ ...entry, taskId, planItemId: entry.after && entry.planItemId ? mapId(entry.planItemId)! : null }];
    });
    undoJson = JSON.stringify(safe);
  } catch { /* Untrusted backup strings must never grant undo authority. */ }
  try {
    const result = JSON.parse(String(row.resultJson));
    if (result?.status === "ok" && Array.isArray(result.changed)) {
      const changed = result.changed.flatMap((entry: Record<string, unknown>) => {
        const item = typeof entry.id === "string" ? items.get(entry.id) : undefined;
        if (!item || item.conversationId !== row.conversationId || item.taskId !== entry.taskId) return [];
        return [{ ...entry, id: mapId(String(entry.id)), taskId: mapId(item.taskId) }];
      });
      resultJson = JSON.stringify({ ...result, changed, operationId, undoable: Boolean(undoJson && JSON.parse(undoJson).length) });
    }
  } catch { /* Keep malformed receipts inert too. */ }
  return { undoJson, resultJson, operationKey: `restored:${operationId}` };
}
