# System One compaction

Opt-in with `"compaction": { "enabled": true }`. Replaces OpenCode's lossy summarizer with Jev verdicts per tool call (the approach is ported from [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)):

- Each non-pinned tool call gets two questions: does the call still matter, and does its result still need to stay verbatim?
- Result relevant → keep call and result. Call only → keep the call, truncate the result to its head plus a size note. Neither → drop both together.
- User and assistant text is never rewritten; the first (checkpoint) message and the newest `preserveRecentMessages` are pinned untouched.
- In `"mode": "replace"` (default) the plugin supplies the pruned transcript itself as the compaction summary, so no summarizer model call runs. `"summary": "report"` condenses it to a counts-only audit note; `"transcript"` replays the kept text verbatim with per-call verdicts.
- In `"mode": "clean"` the decisions are applied to the messages and OpenCode's built-in summarizer then runs over the cleaned history.
- OpenCode keeps its own recent window (`compaction.keep.tokens`, 15k by default) beside the summary. On OpenCode 2.2.5 the hook is handed the whole transcript before that window is split off, so calls inside it are judged but stay verbatim regardless - those judgments cost tokens without removing context.

Fail-closed: a missing key, a jev failure, a malformed answer, or a history that cannot be fitted leaves compaction entirely to OpenCode's built-in summarizer on the unmodified transcript. Decisions are never half-applied.

Running `/compact` again within a minute of a jev pass yields to the built-in summarizer (the jev summary ends with a reminder). `/jev-compact` (requires `enabled`) is the explicit jev-only ask: in `replace` mode the pruned summary applies with no summarizer call, in `clean` mode the kept message counts are announced before the summarizer, and "nothing stale", duplicate-pass, and failure cases abort visibly instead of silently rerouting.

Privacy: judging needs to see the conversation, so enabling compaction sends the transcript (scrubbed of known secret formats, with tool results replaced by short size notes) to your Jev endpoint. Verdicts are cached; the state text is never persisted.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Off unless explicitly enabled. |
| `mode` | `"replace"` | `"replace"` supplies the pruned transcript as the summary; `"clean"` only rewrites messages and keeps OpenCode's summarizer. |
| `summary` | `"report"` | Shape of the hook-supplied summary. `"report"` is a five-line counts-only audit note; `"transcript"` replays the kept user/assistant text verbatim (plus per-call verdicts). |
| `keepThreshold` | `0.5` | Verdict probability at which a call/result survives. |
| `preserveRecentMessages` | `6` | Newest messages pinned untouched. |
| `maxStateTokens` | `25000` | Judgment-state budget before fitting gives up (and compaction falls back). |
| `maxRequestTokens` | `30000` | Per-request budget (state + questions); splits into batches. |
| `maxBatchCalls` | `32` | Tool calls judged per request (two questions each = 64 - the largest count System One deployments document; lower it for stricter deployments). |
| `truncateHeadChars` | `300` | Head kept when a result is pruned. |
| `minReduction` | `0.25` | Required relative shrink before a hook-supplied summary replaces the built-in one. |
| `maxSummaryTokens` | half the model window | Cap on the hook-supplied summary (estimated tokens). |
| `auto` | `off` | Idle auto-compaction outside OpenCode's near-full trigger (see below); `true` = `{ "share": 0.5 }`. |
| `debug` | `false` | Logs one `idle-compaction: ~Ntok vs Mtok target` line per idle event, so "never fired" and "fired but skipped" are distinguishable. |

## Idle compaction (`auto`)

When set, the plugin posts the same compaction request `/compact` uses at session idle, once the active context passes the target. That context is what `session.context` returns - the last compaction's summary plus its kept recent window, then newer messages - so it tracks the request, not the stored history:

- `"auto": { "share": 0.5 }` compacts at that fraction of the session model's context window (follows model routing).
- `"auto": { "tokens": 60000 }` compacts at an absolute token count (wins over `share`).

It is a repeatable trigger, not a one-shot: after a successful pass the estimate drops to the summary and the watcher waits for the conversation to regrow past the target. Attempts are throttled - at most one pass per idle event, none within a minute of a previous pass, 120 s backoff after a failure. A pass that leaves the transcript over target (nothing stale enough, insufficient reduction, oversized summary) waits for real growth before retrying and surfaces each skip as a row. Tool-call-free transcripts can never be pruned enough by jev and keep reporting a skip instead of compacting.

If jev should be the only compactor, set `"compaction": { "auto": false }` in `opencode.jsonc` - OpenCode's own compaction starts at a percentage of the model window (default `compaction.buffer` of `"15%"`), independent of this plugin.
