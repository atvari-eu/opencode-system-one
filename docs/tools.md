# System One tools, commands & the audit panel

The `jev_` tool prefix and `/jev-` command prefix are historical: they are the same names whatever System One model judges, so the guidance below applies whether you run `jev-1.13` or another model in the family.

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
| `/jev-models [<id> \| reset]` | pins the System One judgment model for this session; every pick is ping-verified before it sticks (see [Provider](provider.md)) |
| `/jev-audit` | opens the audit side panel with every UI-only event |
| `/jev-status` | opens the status panel: decision model and candidates, routing pools, deployment health, enabled features, recent event severity |

## The audit panel (`/jev-audit`)

The panel carries every UI-only event - screen verdicts, errors, config faults, scrub hits, approvals - oldest first in a `TIME / KIND / SUBJECT / DECISION / DETAIL` table.

- `a`/`n`/`s`/`e`/`p`/`r`/`x` filter (all/anomalies/screen/errors/approvals/scrub/config)
- `j`/`k` select, `g`/`G` top/bottom
- `enter`/`space` expand, `y` copy the selected row, `c` copy all
- `d` deselect and resume following the newest, `f` fullscreen, `esc`/`q` close
- The panel opens at the newest row and follows it until you select one; long events are cropped to one row (click to select and expand). Filter chips are clickable too.
- Screen rows keep the redacted, capped call that triggered them (`Screened output of: <call>`); flagged/unsafe rows add a capped result preview. Passing screens store no content.
- Mouse selection is disabled in the panel; use `c`/`y` to copy.

## The status panel (`/jev-status`)

One read-only snapshot of the plugin, in sections:

- **decision model** - the model that actually judges this session (a `/jev-models` pin wins over the chain default), the provider, and the endpoint;
- **available decision models** - the picker candidates, with cached deployment faults (`✗ 401 unauthorized`) and a marker on the current one;
- **model pools** - every routing entry separately (`auto`, `auto-review`, and any custom meta model): how many candidates are usable, what the config declared, what the sources merged in, what review disjointness excluded, the fallback, and the default-pool shape when it applies;
- **health** - the cached init/pick deployment verdict (the panel never pings), the decision-catalog source (`live`/`snapshot`/`none`), and whether the `jev-config` event channel is available;
- **features** - every feature with its resolved options: screen mode/annotation/tools, scrub, tools, commands, cache, effort.mode, both routing entries, done-check, find, approvals policy, compaction mode;
- **recent events** - ok/warn/error/info counts and per-kind counts folded from the `/jev-audit` ring, plus the newest error.

`r` refreshes the snapshot, `c` copies it as text, `f` toggles fullscreen, `esc`/`q` closes, and running `/jev-status` again toggles the panel. Event statistics update live while the panel is open; the other sections refresh on `r` or the next open. Mouse selection is disabled in the panel.

## Event toasts (`toasts`)

Each UI-only event has a severity. `toasts` sets a **minimum severity** per event: the event toasts when its severity is at or above the floor. The default floor is `error`, so by default only error-severity events show a toast; `/jev-audit` still records every event either way.

| Event | Severity | Fires on |
| --- | --- | --- |
| `screen` | `warning` for flagged, `error` for unsafe/unavailable | a non-pass screen |
| `error` | `error` | a failed judged call (one per 60 s window per title) |
| `config` | `error` | one init deployment fault per changed config |
| `scrub` | `warning` | secret-like tokens removed from a prompt or tool input |
| `approval` | `error` for deny/gate, `warning` for a judgment failure | a refusal, gate hold, or failed judgment (allows/asks stay quiet) |

Severities are ordered `info` < `success` < `warning` < `error`. A floor is inclusive and upward: `"warning"` means warning **and** error toast; `"info"` means everything. `true` shows every severity, `false` never toasts that event. Omitted events keep the `error` floor; unknown events and invalid values are ignored.

```jsonc
{
  "toasts": {
    "screen": "warning", // also show flagged screens
    "scrub": "info",     // show every scrub hit
    "approval": false    // never toast approvals
  }
}
```

## Skills

None needed, and none should be loaded on OpenCode with this plugin - the tool descriptions, hooks, and commands carry the whole job. For other agents (no plugin), the standalone `jev` CLI is the path, and the portable skills in [`atvari-eu/skills`](https://github.com/atvari-eu/skills) can drive it from any agent:

```console
$ skills add atvari-eu/skills@system-one -g
$ skills add atvari-eu/skills@auto-system-one -g
```
