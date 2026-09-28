import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkflowAgentSnapshot } from "../src/display.js";
import type { PersistedRunState } from "../src/run-persistence.js";
import { type ManagedRun, WorkflowManager } from "../src/workflow-manager.js";
import { installWorkflowProgress, type WorkflowProgress } from "../src/workflow-progress.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function run(runId = "run-1", sessionId = "session-1"): ManagedRun {
  return {
    runId,
    sessionId,
    status: "running",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    snapshot: {
      name: "Research",
      phases: [],
      logs: [],
      agents: [],
      agentCount: 0,
      runningCount: 0,
      doneCount: 0,
      errorCount: 0,
    },
  } as ManagedRun;
}

function agent(id: number): WorkflowAgentSnapshot {
  return { id, callId: "reused-call", label: "same label", prompt: "Find evidence", status: "running" };
}

function harness(initial: ManagedRun[] = [], persisted: PersistedRunState[] = []) {
  const emitter = new EventEmitter();
  const live = new Map(initial.map((value) => [value.runId, value]));
  const disk = new Map(persisted.map((value) => [value.runId, value]));
  const manager = Object.assign(emitter, {
    getRun: (id: string) => live.get(id),
    listLiveRuns: () => [...live.values()],
    listRuns: () => [...disk.values()],
    getCwd: () => "/project",
    getPersistence: () => ({ loadPreview: (id: string) => disk.get(id), load: (id: string) => disk.get(id) }),
  }) as unknown as WorkflowManager;
  const records: Array<WorkflowProgress | { version: 1; runId: string; deleted: true }> = [];
  const dispose = installWorkflowProgress(
    {
      appendEntry(type, value) {
        assert.equal(type, "pi-dynamic-workflows:progress");
        records.push(structuredClone(value) as WorkflowProgress);
      },
    },
    manager,
    "session-1",
  );
  return { manager, live, disk, records, dispose };
}

function progress(records: ReturnType<typeof harness>["records"]): WorkflowProgress[] {
  return records.filter((value): value is WorkflowProgress => !("deleted" in value));
}

test("initial snapshots include only this session's active runs and keep distinct snapshot identities", async () => {
  const own = run();
  own.snapshot.agents = [agent(1), agent(2)];
  own.parentSessionId = "original-session";
  const completed = run("past");
  completed.status = "completed";
  const h = harness([own, run("foreign", "session-2"), completed]);
  try {
    await flush();
    assert.equal(h.records.length, 1);
    const packet = progress(h.records)[0];
    assert.deepEqual(packet.agentIds, [1, 2]);
    assert.equal(packet.agents.length, 2);
    assert.equal(packet.runningCount, 2);
    assert.equal(packet.agentCount, 2);
    assert.equal(packet.cwd, "/project");
  } finally {
    h.dispose();
  }
});

test("token bursts coalesce, unchanged rows are omitted, and identical packets are deduplicated", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const current = run();
  current.snapshot.agents = [agent(1), agent(2)];
  const h = harness([current]);
  try {
    await flush();
    for (let tokens = 1; tokens <= 100; tokens++) {
      current.snapshot.agents[1].tokens = tokens;
      h.manager.emit("tokenUsage", { runId: current.runId });
    }
    assert.equal(h.records.length, 1);
    t.mock.timers.tick(999);
    assert.equal(h.records.length, 1);
    t.mock.timers.tick(1);
    assert.equal(h.records.length, 2);
    const packet = progress(h.records)[1];
    assert.deepEqual(packet.agentIds, [1, 2]);
    assert.deepEqual(
      packet.agents.map((row) => row.id),
      [2],
    );
    assert.equal(packet.agents[0].tokens, 100);
    h.manager.emit("tokenUsage", { runId: current.runId });
    t.mock.timers.tick(1000);
    assert.equal(h.records.length, 2);
  } finally {
    h.dispose();
  }
});

test("terminal publication waits for settlement and flushes pending progress immediately", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const current = run();
  current.snapshot.agents = [agent(1)];
  const h = harness([current]);
  try {
    await flush();
    h.manager.emit("agentUsage", { runId: current.runId });
    current.status = "completed";
    h.manager.emit("complete", { runId: current.runId });
    current.snapshot.agents[0].status = "done";
    current.snapshot.agents[0].resultPreview = "Found it";
    await flush();
    const final = progress(h.records).at(-1);
    assert.ok(final);
    assert.equal(final.status, "completed");
    assert.equal(final.agents[0].status, "done");
    assert.equal(final.agents[0].resultPreview, "Found it");
    t.mock.timers.tick(1000);
    assert.equal(h.records.length, 2);
  } finally {
    h.dispose();
  }
});

test("paused and aborted statuses retain raw child state for the host's display projection", async () => {
  const current = run();
  current.snapshot.agents = [agent(1)];
  const h = harness([current]);
  try {
    await flush();
    current.status = "paused";
    h.manager.emit("paused", { runId: current.runId });
    await flush();
    assert.equal(progress(h.records).at(-1)?.status, "paused");
    assert.deepEqual(progress(h.records).at(-1)?.agents, []);
    assert.equal(progress(h.records).at(-1)?.runningCount, 1);
    current.status = "aborted";
    h.manager.emit("stopped", { runId: current.runId });
    await flush();
    assert.equal(progress(h.records).at(-1)?.status, "aborted");
  } finally {
    h.dispose();
  }
});

test("terminal runs evicted before the microtask are read from persistence", async () => {
  const current = run();
  const h = harness([current]);
  try {
    await flush();
    h.disk.set(current.runId, {
      runId: current.runId,
      sessionId: current.sessionId,
      workflowName: "Research",
      status: "failed",
      error: "Provider unavailable",
      agents: [{ ...agent(1), status: "error" }],
      startedAt: current.startedAt.toISOString(),
      durationMs: 300,
    } as PersistedRunState);
    h.manager.emit("error", { runId: current.runId });
    h.live.delete(current.runId);
    await flush();
    const final = progress(h.records).at(-1);
    assert.ok(final);
    assert.equal(final.status, "failed");
    assert.equal(final.error, "Provider unavailable");
    assert.equal(final.durationMs, 300);
  } finally {
    h.dispose();
  }
});

test("preview payloads are bounded and exclude arbitrary results and child history", async () => {
  const current = run();
  const row = agent(1);
  row.prompt = "p".repeat(10000);
  row.result = { answer: "r".repeat(10000) };
  row.error = "e".repeat(10000);
  row.history = [{ role: "assistant", kind: "text", text: "private history" }];
  current.snapshot.agents = [row];
  const h = harness([current]);
  try {
    await flush();
    const emitted = progress(h.records)[0].agents[0];
    assert.ok(emitted.promptPreview && emitted.promptPreview.length <= 500);
    assert.ok(emitted.resultPreview && emitted.resultPreview.length <= 2000);
    assert.ok(emitted.error && emitted.error.length <= 2000);
    assert.ok(!("history" in emitted));
    assert.ok(!("result" in emitted));
    assert.ok(!JSON.stringify(h.records).includes("private history"));
  } finally {
    h.dispose();
  }
});

test("result previews preserve useful text without traversing structured results or invoking their getters", async () => {
  const current = run();
  let reads = 0;
  let enumerations = 0;
  const structured = new Proxy(
    { summary: "Large result" },
    {
      ownKeys() {
        enumerations++;
        return ["summary"];
      },
      get(target, key, receiver) {
        reads++;
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const array = new Array(1_000_000);
  Object.defineProperty(array, 999_999, {
    get() {
      reads++;
      return "Must not be read";
    },
  });
  const text = agent(1);
  text.result = "Useful result ".repeat(300);
  text.resultPreview = "Short";
  const summarized = agent(2);
  summarized.result = structured;
  summarized.resultPreview = "Existing structured summary";
  const unsummarized = agent(3);
  unsummarized.result = array;
  current.snapshot.agents = [text, summarized, unsummarized];
  current.result = { result: structured } as ManagedRun["result"];
  const h = harness([current]);
  try {
    await flush();
    const packet = progress(h.records)[0];
    assert.equal(packet.agents[0].resultPreview?.length, 2000);
    assert.ok(packet.agents[0].resultPreview?.startsWith("Useful result "));
    assert.equal(packet.agents[1].resultPreview, "Existing structured summary");
    assert.equal(packet.agents[2].resultPreview, "Structured result");
    assert.equal(packet.resultPreview, "Structured result");
    assert.equal(reads, 0);
    assert.equal(enumerations, 0);
  } finally {
    h.dispose();
  }
});

test("deletion emits one tombstone and disposal cancels queued publication and listeners", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const current = run();
  const h = harness([current]);
  await flush();
  h.live.delete(current.runId);
  h.manager.emit("deleted", { runId: current.runId });
  await flush();
  assert.deepEqual(h.records.at(-1), { version: 1, runId: current.runId, deleted: true });
  h.manager.emit("deleted", { runId: current.runId });
  h.manager.emit("deleted", { runId: "foreign" });
  await flush();
  assert.equal(h.records.length, 2);
  h.live.set("run-2", run("run-2"));
  h.manager.emit("started", { runId: "run-2" });
  h.dispose();
  await flush();
  t.mock.timers.tick(1000);
  assert.equal(h.records.length, 2);
  assert.equal(h.manager.eventNames().length, 0);
});

test("append failures do not escape lifecycle listeners or trigger automatic retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  h.dispose();
  let attempts = 0;
  const dispose = installWorkflowProgress(
    {
      appendEntry() {
        attempts++;
        throw new Error("Unavailable host");
      },
    },
    h.manager,
    "session-1",
  );
  try {
    h.live.set("run-1", run());
    h.manager.emit("started", { runId: "run-1" });
    await flush();
    t.mock.timers.tick(60000);
    assert.equal(attempts, 1);
    h.manager.emit("phase", { runId: "run-1" });
    t.mock.timers.tick(1000);
    assert.equal(attempts, 2);
  } finally {
    dispose();
  }
});

test("historical ownership supports deletion without hydrating completed agent history", async () => {
  let hydrations = 0;
  const historical = {
    runId: "historical",
    sessionId: "session-1",
    status: "completed",
    get agents() {
      hydrations++;
      return [];
    },
  } as unknown as PersistedRunState;
  const h = harness([], [historical]);
  try {
    await flush();
    assert.equal(h.records.length, 0);
    assert.equal(hydrations, 0);
    h.disk.delete(historical.runId);
    h.manager.emit("deleted", { runId: historical.runId });
    await flush();
    assert.deepEqual(h.records, [{ version: 1, runId: "historical", deleted: true }]);
  } finally {
    h.dispose();
  }
});

test("rebound active runs and completed runs awaiting delivery receive full snapshots", async () => {
  const active = run();
  active.snapshot.agents = [agent(1)];
  const pending = run("pending-delivery");
  pending.status = "completed";
  pending.pendingDelivery = { kind: "complete" };
  const h = harness([active, pending]);
  await flush();
  assert.equal(h.records.length, 2);
  h.dispose();
  const rebound: WorkflowProgress[] = [];
  const dispose = installWorkflowProgress(
    { appendEntry: (_type, data) => rebound.push(data as WorkflowProgress) },
    h.manager,
    "session-1",
  );
  try {
    await flush();
    assert.equal(rebound.length, 2);
    assert.deepEqual(
      rebound.find((packet) => packet.runId === active.runId)?.agents.map((row) => row.id),
      [1],
    );
  } finally {
    dispose();
  }
});

test("real manager publishes synchronous workflows and native child session links", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-progress-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "workflow-progress-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({
        cwd,
        agent: {
          async run(_prompt, options) {
            options?.onSessionCreated?.({ sessionId: "child", sessionFile: "/sessions/child.jsonl" });
            return "Done";
          },
        },
      });
      manager.setSessionId("session-1");
      const records: WorkflowProgress[] = [];
      const dispose = installWorkflowProgress(
        { appendEntry: (_type, data) => records.push(data as WorkflowProgress) },
        manager,
        "session-1",
      );
      try {
        const started: string[] = [];
        const sessions: string[] = [];
        manager.on("started", ({ runId }) => started.push(runId));
        manager.on("agentSession", ({ sessionFile }) => sessions.push(sessionFile));
        await manager.runSync("export const meta = { name: 'empty', description: 'Empty workflow' }; return 'ok'");
        await manager.runSync(
          "export const meta = { name: 'child', description: 'Child workflow' }; return await agent('Work')",
        );
        await flush();
        assert.equal(started.length, 2);
        assert.deepEqual(sessions, ["/sessions/child.jsonl"]);
        const final = records.filter((packet) => packet.name === "child").at(-1);
        assert.ok(final);
        assert.equal(final.status, "completed");
        assert.equal(final.agents[0].sessionFile, "/sessions/child.jsonl");
        assert.equal(final.resultPreview, "Done");
      } finally {
        dispose();
      }
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
