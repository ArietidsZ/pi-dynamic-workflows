/**
 * In-memory key-value store scoped to a single workflow run.
 *
 * One `SharedStore` instance is created at run start and disposed when the run
 * ends. Two MCP-compatible tool definitions (`store_put` / `store_get`) are
 * injected into every agent's tool list so parallel agents can share
 * intermediate state without coordinating through the script itself.
 *
 * Journal integration: callers capture `store.commitDelta(deltaKey)` alongside
 * each agent result in the journal. On resume, `store.applyDelta(delta)` rebuilds
 * the store state additively in callSeq order, so parallel-agent writes are
 * replayed correctly without the last-complete-wins ordering bug that a
 * whole-Map restore() would cause.
 *
 * `deltaKey` must be unique across every run that shares this store instance,
 * not just within one run's callSeq. A nested `workflow()` call restarts its own
 * callSeq at 0 while inheriting the parent's store (so parent and nested-run
 * agents can share state), so a bare callIndex would collide between a parent
 * agent and a concurrently-running nested-run agent that both got index 0 —
 * whichever commits its delta last would clobber the other's entry in
 * `agentDeltas`. Callers compose `deltaKey` as `${runId}:${callIndex}`, and
 * since every run (including each nested run) gets its own distinct `runId`,
 * the composite key is unique across the whole store's lifetime.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export class SharedStore {
  private readonly map = new Map<string, unknown>();
  // Per-agent write deltas for delta-journaling; keyed by a run-unique
  // `${runId}:${callIndex}` string (see class doc) so nested workflow() runs
  // sharing this store can't collide on a bare callIndex.
  private readonly agentDeltas = new Map<string, Record<string, unknown>>();
  // Per-key write history implementing event-log undo semantics for
  // discardDelta (#208): each tracked write pushes an entry tagged with its
  // window; untracked put()/applyDelta() writes push untagged entries that no
  // discard can remove. Discarding a window removes ITS entries, and the
  // visible value recomputes as the last surviving write (or the captured
  // base). Value/stamp comparisons cannot express this: a sibling's overwrite
  // with an Object.is-equal value is still a write that must survive, and a
  // discarded window's shadow must never resurface — the log makes both
  // exact. Entries live until dispose(); the bound is the run's write count,
  // the same order as the journal itself.
  private readonly keyHistories = new Map<
    string,
    { base: { existed: boolean; value: unknown }; writes: Array<{ window?: string; value: unknown }> }
  >();

  private historyFor(key: string) {
    let history = this.keyHistories.get(key);
    if (!history) {
      history = {
        base: { existed: this.map.has(key), value: this.map.get(key) },
        writes: [],
      };
      this.keyHistories.set(key, history);
    }
    return history;
  }

  /** Recompute a key's visible value as its last surviving write (or its base). */
  private recompute(
    key: string,
    history: { base: { existed: boolean; value: unknown }; writes: Array<{ value: unknown }> },
  ): void {
    const top = history.writes.at(-1);
    if (top) this.map.set(key, top.value);
    else if (history.base.existed) this.map.set(key, history.base.value);
    else this.map.delete(key);
    // No live writes left: the base has been restored, so the log can go.
    if (history.writes.length === 0) this.keyHistories.delete(key);
  }

  /** Store a value under `key`. Overwrites any existing value. */
  put(key: string, value: unknown): void {
    // Untracked (script-level) write: survives every window discard.
    this.historyFor(key).writes.push({ value });
    this.map.set(key, value);
  }

  /**
   * Store a value and record the write in the per-agent delta for `deltaKey`
   * (a run-unique `${runId}:${callIndex}` string — see class doc). Used by
   * per-agent tools created via `createAgentStoreTools` so that each agent's
   * writes can be journaled and replayed independently.
   */
  trackPut(key: string, value: unknown, deltaKey: string): void {
    this.historyFor(key).writes.push({ window: deltaKey, value });
    this.map.set(key, value);
    let delta = this.agentDeltas.get(deltaKey);
    if (!delta) {
      delta = {};
      this.agentDeltas.set(deltaKey, delta);
    }
    delta[key] = value;
  }

  /** Retrieve the value for `key`, or `undefined` when absent. */
  get(key: string): unknown {
    return this.map.get(key);
  }

  /** Whether `key` is present in the store. */
  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Return a deep-copied plain-object snapshot of all entries. */
  snapshot(): Record<string, unknown> {
    return structuredClone(Object.fromEntries(this.map));
  }

  /**
   * Extract and clear the write delta accumulated for `deltaKey`.
   * Called after an agent completes to get the set of keys it wrote. The
   * window's write-log entries stay: a committed write is permanent history
   * that later discards must not remove (resume replay re-applies it). A
   * later discardDelta for the same key is a no-op — the delta bookkeeping
   * is gone — so committed entries are unreachable by rollbacks.
   */
  commitDelta(deltaKey: string): Record<string, unknown> {
    const delta = this.agentDeltas.get(deltaKey) ?? {};
    this.agentDeltas.delete(deltaKey);
    // Detach this window's surviving log entries (they are permanent history
    // now) so a LATER write under the same deltaKey starts a fresh generation:
    // a discard of that generation must never remove committed entries.
    for (const key of Object.keys(delta)) {
      const history = this.keyHistories.get(key);
      if (!history) continue;
      for (const write of history.writes) {
        if (write.window === deltaKey) write.window = undefined;
      }
    }
    return delta;
  }

  /**
   * Undo the writes recorded for `deltaKey` and discard its bookkeeping,
   * without touching any other key. Used when a retry attempt fails: that
   * attempt's writes must not remain visible in the live store (e.g. to a
   * concurrently-running sibling agent's store_get, or to script code reading
   * `store.get` directly) and must not merge into the delta eventually
   * recorded when a later attempt of the SAME call succeeds — otherwise a
   * failed attempt's mutations would silently survive into the run's live
   * state while being absent from the journaled delta that resume replay
   * reconstructs from, leaving live execution and replay permanently
   * inconsistent.
   *
   * Exact undo semantics (#208): the attempt's entries are removed from each
   * key's write log and the visible value recomputes as the last SURVIVING
   * write — a concurrent sibling's later write (even an Object.is-equal one)
   * survives, an untracked put()/replay applyDelta() survives, and a shadowed
   * write by an earlier window resurfaces only if that window itself is still
   * live or committed.
   *
   * A no-op if `deltaKey` never wrote anything (nothing to roll back).
   */
  discardDelta(deltaKey: string): void {
    const delta = this.agentDeltas.get(deltaKey);
    if (!delta) return;
    for (const key of Object.keys(delta)) {
      const history = this.keyHistories.get(key);
      if (!history) continue;
      history.writes = history.writes.filter((write) => write.window !== deltaKey);
      this.recompute(key, history);
    }
    this.agentDeltas.delete(deltaKey);
  }

  /**
   * Apply a write delta additively — sets each key without clearing others.
   * Used during resume replay so parallel-agent deltas applied in callSeq
   * order accumulate correctly regardless of original completion order.
   * Replay writes are untagged log entries: they belong to no live window and
   * no window's discard may remove them.
   */
  applyDelta(delta: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(delta)) {
      this.historyFor(k).writes.push({ value: v });
      this.map.set(k, v);
    }
  }

  /**
   * Replace all entries with a snapshot (for full resets).
   * Prefer `applyDelta` for resume replay — see journal integration above.
   */
  restore(snap: Record<string, unknown>): void {
    this.map.clear();
    this.keyHistories.clear();
    for (const [k, v] of Object.entries(snap)) {
      this.map.set(k, v);
    }
  }

  /** Clear all entries (called when the run ends). */
  dispose(): void {
    this.map.clear();
    this.agentDeltas.clear();
    this.keyHistories.clear();
  }
}

/**
 * Create per-agent store tools that attribute writes to `deltaKey`, a
 * run-unique `${runId}:${callIndex}` string (see the `SharedStore` class doc
 * for why the bare callIndex alone is not enough once a nested `workflow()`
 * call shares this store).
 * Used internally by `runWorkflow` so each agent's puts are tracked in the
 * store's delta journal and can be replayed additively on resume.
 */
export function createAgentStoreTools(store: SharedStore, deltaKey: string): ToolDefinition[] {
  const storePut = defineTool({
    name: "store_put",
    label: "Store Put",
    description:
      "Write a value to the shared run store. Any other agent in this workflow run can read it with store_get. Overwrites any existing value for the key. Note: when two parallel agents write the same key, the last write wins — no merge is performed.",
    promptSnippet: "Write a value to the shared store",
    parameters: Type.Object({
      key: Type.String({ description: "The key to store the value under." }),
      value: Type.Any({ description: "The value to store (any JSON-serializable value)." }),
    }),
    async execute(_id: string, params: { key: string; value: unknown }) {
      store.trackPut(params.key, params.value, deltaKey);
      return {
        content: [{ type: "text", text: `Stored value under key "${params.key}".` }],
        details: { key: params.key },
      };
    },
  }) as unknown as ToolDefinition;

  const storeGet = defineTool({
    name: "store_get",
    label: "Store Get",
    description:
      "Read a value from the shared run store previously written by store_put. Returns the stored value, or null when the key does not exist.",
    promptSnippet: "Read a value from the shared store",
    parameters: Type.Object({
      key: Type.String({ description: "The key to read." }),
    }),
    async execute(_id: string, params: { key: string }) {
      const found = store.has(params.key);
      const value = store.get(params.key);
      const text = found
        ? `Value for key "${params.key}": ${JSON.stringify(value)}`
        : `Key "${params.key}" not found in store.`;
      return {
        content: [{ type: "text", text }],
        details: { key: params.key, value: found ? value : null, found },
      };
    },
  }) as unknown as ToolDefinition;

  return [storePut, storeGet];
}
