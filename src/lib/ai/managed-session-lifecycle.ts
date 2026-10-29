import "server-only";

type Lifecycle = { revision: number; tail: Promise<void> };
const KEY = Symbol.for("vocatrya.managedSessionLifecycle.v1");

// Next server bundles share this process-local state. Only a counter and a
// lock live here; credentials remain exclusively in the session provider.
export function managedSessionLifecycle(userId: string): Lifecycle {
  const scope = globalThis as unknown as Record<symbol, Map<string, Lifecycle> | undefined>;
  const states = scope[KEY] ?? (scope[KEY] = new Map());
  let state = states.get(userId);
  if (!state) {
    state = { revision: 0, tail: Promise.resolve() };
    states.set(userId, state);
  }
  return state;
}

export async function withManagedSessionLock<T>(userId: string, operation: (state: Lifecycle) => Promise<T>): Promise<T> {
  const state = managedSessionLifecycle(userId);
  const previous = state.tail;
  let release!: () => void;
  state.tail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await operation(state); }
  finally { release(); }
}
