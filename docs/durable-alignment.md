# Pi Durable alignment

Position on `@earendil-works/pi-durable` (evaluated at 1.0.x), the durable agent harness that shipped with the Pi 1.0 line. It is marked **experimental** upstream ("the API changes without notice between releases"), is built on `pi-ai`/`chord` rather than the coding-agent extension API, and the extension's supported hosts start at pi-coding-agent 0.80.8. Decision: **do not migrate**; re-evaluate only on the triggers below. Migration is one option among several (others: platform-native run storage in the coding agent, session custom entries); this note exists so a future evaluation costs hours, not weeks.

## Primitive mapping

| Extension | pi-durable |
| --- | --- |
| Journal replay on resume (unchanged prefix returns journaled results) | Task resume: `harness.resume()` restarts the scheduler; interrupted work stays pending |
| `agent()` content-hash call identity | Nothing — see below |
| Durable `checkpoint({ kind, checkpointId, payload })` suspension | A task waiting on an externally committed response |
| Run-record head + hash-chained JSONL event log ([storage protocol](run-storage.md)) | Storage commit log; state committed before anything is shown |
| SharedStore per-agent write deltas, applied additively in callSeq order | `defineDoc` documents (chord) for user-owned state |
| Delivery markers | `requestId`-idempotent submissions (a retried submission returns the existing one) |
| Run lease + writer mutex | Single task scheduler per conversation; busy-conversation rules |

## What pi-durable does not provide (the non-migration rationale)

1. **Content-hash call identity with a replay cache.** On reopen, a tool call that died mid-execution re-runs only when declared `replay: "safe"`; otherwise the model receives `interrupted`. There is no notion of re-executing a deterministic script and returning journaled results for identity-matching calls, so the extension's edit-and-resume (changed suffix re-runs live, unchanged prefix replays) has no upstream counterpart.
2. **Fan-out gap shadowing.** The `prefix` vs `replay-completed` distinction — a never-completed gap ends replay for its sequential downstream but not for siblings dispatched concurrently in the same fan-out window — presupposes the replay cache of item 1 and has no upstream substrate. An upstream proposal must therefore be "content-addressed replay caching **plus** fan-out gap shadowing" as a package; proposing gap semantics alone is inactionable.
3. **Additive store deltas with undo-on-retry across replay** (a replayed call recommits nothing; a retried call's writes replace, not duplicate).
4. **Cumulative budget re-seeding across pause/resume** (`initialTokenUsage`), so a token ceiling holds across a cycle instead of resetting.

The mismatch is also architectural: pi-durable is a separate harness with its own conversations/tasks/documents, not a storage backend the in-process extension runtime could adopt without re-platforming.

## Re-evaluation triggers

- pi-durable drops the experimental banner.
- The extension's supported host floor reaches the Pi 1.x line.
- Upstream gains a content-addressed replay cache (item 1) — the precondition for any gap-shadowing proposal.

What stays true either way: the on-disk run store (the journal core and the persistence stack) exists solely because the platform lacks durable run storage, and it is the only slice a future migration could delete.
