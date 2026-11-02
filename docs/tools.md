# Jev tools, commands & the audit panel

## The judgment tools

Registered with `"tools": true` (default):

- **`jev_decide`** - one judgment state per call, with typed questions: noul (probability of yes), choice (pick among bounded options), score (rate against 2-10 ordered levels).
- **`jev_judge_many`** - the same question over many items in parallel, aggregated in code (weighted mean + low-confidence flags).
- **`jev_screen`** - on-demand junk/prompt-injection/secret-material screening of pasted or suspect content, complementing the automatic screen that fetched results already get (see [Screening](screening.md)).

Every judgment shows as its own tool row (`Running jev_decide…`) in the timeline, and the tool descriptions carry the when-to-call guidance - screening, claim verification, ranking, bounded choices, scoring, and self-contained classification questions - plus skip rules and confidence thresholds. No companion skill is needed.

### `jev_screen` input/output

Inputs: `summary` (one line naming what is screened), `content` (the untrusted text, verbatim), and an optional `source` (origin echoed in the report).

Output: `junk` and `injection` probabilities, a `verdict` (`pass` / `flagged` / `unsafe`), a plain-language `verdictText`, and the `scrubbedHits` count when the content contained secret-like tokens. Same cache as automatic screening: repeating the same content costs nothing.

## Cache

Replies for identical (endpoint, model, state, questions) are served from durable plugin storage; only answers are persisted, never the state text.

## Commands

| Command | What it does |
| --- | --- |
| `/jev-screen <url \| file>` | one-shot junk/injection/secret verdict for any URL or local file |
| `/jev-done-check` | completion self-check over the recent session transcript (see [Done-check](done-check.md)) |
| `/jev-compact` | compacts the session now with jev decisions only, never falling back to the built-in summarizer (see [Compaction](compaction.md)) |
| `/jev-approval-stats` | lists which command patterns trigger approvals and how they resolve, so recurring asks can become explicit permission rules (see [Approvals](approvals.md)) |
| `/jev-audit` | opens the audit side panel with every UI-only event |

## The audit panel (`/jev-audit`)

The panel carries every UI-only event - screen verdicts, errors, config faults, scrub hits, approvals - oldest first in a `TIME / KIND / SUBJECT / DECISION / DETAIL` table.

- `a`/`n`/`s`/`e`/`p`/`r`/`x` filter (all/anomalies/screen/errors/approvals/scrub/config)
- `j`/`k` select, `g`/`G` top/bottom
- `enter`/`space` expand, `y` copy the selected row, `c` copy all
- `d` deselect and resume following the newest, `f` fullscreen, `esc`/`q` close
- The panel opens at the newest row and follows it until you select one; long events are cropped to one row (click to select and expand). Filter chips are clickable too.
- Screen rows keep the redacted, capped call that triggered them (`Screened output of: <call>`); flagged/unsafe rows add a capped result preview. Passing screens store no content.
- Mouse selection is disabled in the panel; use `c`/`y` to copy.

## Skills

None needed, and none should be loaded on OpenCode with this plugin - the tool descriptions, hooks, and commands carry the whole job. For other agents (no plugin), the standalone `jev` CLI is the path, and the portable skills in [`atvari-eu/skills`](https://github.com/atvari-eu/skills) can drive it from any agent:

```console
$ skills add atvari-eu/skills@system-one -g
$ skills add atvari-eu/skills@auto-system-one -g
```
