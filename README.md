# OpenCode plugin for the System One decision layer

An [OpenCode](https://opencode.ai) plugin that wires System One (Jev)
judgments into OpenCode automatically: tool results are checked for junk and
prompt injection before they enter context (`webfetch` by default, every tool
optional), known secret formats are redacted from tool inputs and user
prompts, the agent gets `jev_decide` / `jev_judge_many` tools with caching,
each turn can have its model and reasoning effort picked by System One from
the prompt *(opt-in)*, a completion probe can run when the session goes idle
*(opt-in)*, `jev_find` offers jev-backed semantic code search *(opt-in)*,
permission requests can be vetted by System One *(opt-in)*, and context
compaction can be decided by System One instead of a lossy summary
*(opt-in)*.

## What it does

- **screen** - tool results are judged (junk? prompt injection?) before they
  enter context: `webfetch` by default, every tool with
  `"screen": { "tools": "all" }`. Mode `annotate` (default) prefixes the
  result with `jev-screen: junk=… injection=…` (plus `⚠ do-not-rely` over
  threshold); mode `redact` replaces unsafe **webfetch** content fail-closed
  (other tools are only annotated). Screened state is regex-scrubbed, sampled
  to 12 kB, and cached per (tool, url, content hash). The plugin's own
  judgment tools are never screened. Flagged results additionally surface as
  a visible `[jev-screen] ⚠ … do-not-rely` notice row in the timeline.
- **scrub** - deterministic redaction (pure regex, never a model call) of
  known secret formats in **tool inputs** and **user prompts**: PEM private
  keys, `sk-…` API keys, GitHub tokens (`ghp_`/`github_pat_`), AWS `AKIA…`,
  Slack `xox…`, GitLab `glpat-…`, age keys, `npm_…`, bearer tokens, JWTs.
  Replaced with `[REDACTED:<label>]`.
- **tools** - `jev_decide`: one request = one state + typed questions
  (noul/choice/score); `jev_judge_many`: one judgment per item, launched in
  parallel and aggregated in code (weighted mean + low-confidence flags).
  Every judgment shows as its own tool row (`Running jev_decide…`) in the
  timeline, and the tool descriptions carry the when-to-call guidance -
  screening, claim verification, ranking, bounded choices, scoring, and
  self-contained classification questions (nothing to read first) - plus the
  skip rules and confidence thresholds. No companion skill is needed.
- **cache** - replies for identical (endpoint, model, state, questions) are
  served from durable plugin storage; only answers are persisted, never the
  state text.
- **commands** - `/jev-screen <url>` gives a one-shot junk/injection verdict
  for any URL; `/jev-done-check` runs a completion self-check over the recent
  session transcript. Both answer without loading a skill.
- **route** (opt-in) - before each turn, jev picks which model runs the turn
  and/or how much reasoning effort it gets, in one judgment, applied through
  the same switch mechanism as the UI's model/effort picker. Fail closed to
  the base model on judge failure, and a manual pick always wins. See
  [Auto model routing](#auto-model-routing).
- **done-check** (opt-in) - after each turn goes idle, the completion probe
  of `/jev-done-check` runs on its own; it posts one notice per user
  message only when completion looks unlikely, and reports a repeating
  (looping) tail as such. See [Auto done-check](#auto-done-check).
- **find** (opt-in) - `jev_find`, a jev-backed semantic code-search cascade:
  lexical prefilter → path judgments → windowed passage judgments, ranked
  hits with line ranges. See [jev_find](#jev_find).
- **approvals** (opt-in) - permission requests are vetted by jev before
  they reach you: a verdict line is added to the prompt, and with
  `"mode": "auto"`, high-confidence routine operations are approved outright.
  Configured deny rules always win. See
  [jev-assisted approvals](#jev-assisted-approvals).
- **compaction** (opt-in) - replaces the lossy compaction summarizer with
  System One decisions: tool calls and results are dropped or truncated by
  jev verdicts, everything kept stays verbatim, no summarizing model call
  runs. See [System One compaction](#system-one-compaction).

## Requirements

- [OpenCode 2](https://opencode.ai/v2/docs)
- Access to a Jev endpoint. With the default OpenCode Console endpoint,
  credentials resolve per call: `TYPESAFE_API_KEY` / `OPENCODE_API_KEY` env
  → the CLI's own login (`opencode auth login` - an API key or your Console
  OAuth session) → the legacy auth store. Key and endpoint must come from
  the same deployment. Paid models bill the Console workspace - a call
  without funds comes back as 402 and is never silently retried elsewhere.

Nothing here depends on a specific model provider; the plugin only adds tools
and guards around your existing setup.

### Error popups

User-actionable jev failures - no credential, 401 key rejection, 402
insufficient funds, 403 endpoint gate, free-tier restriction ("only from
within OpenCode") - are surfaced twice: once as a `[jev-error] …` row in the
timeline, and once as a top-corner error popup, matching how OpenCode shows
its own errors. The bundled TUI half of the plugin (package export
`./tui`) renders those rows as toasts; at most one row per failure class per
minute, a stapled 4xx-only list by construction, so repeated tool failures
never toast-spam. Local tool noise (5xx, transport errors) stays
console-only.

## Install

Entries go into `plugins` in `opencode.json(c)` - global (`~/.config/opencode/opencode.jsonc`)
or per-project (`opencode.json(c)` / `.opencode/opencode.json(c)`).

### From GitHub (recommended)

```console
$ opencode plugin add github:atvari-eu/opencode-system-one
```

Installs the plugin globally under CLI management: `opencode plugin list` to
inspect, `opencode plugin update` to pull new commits (a bare spec tracks the
default branch). Pin a fixed revision by appending a full commit hash:

```console
$ opencode plugin add github:atvari-eu/opencode-system-one#<full-commit-hash>
```

If OpenCode was running, restart it (`opencode service restart`) so the
shared service picks the plugin up.

### Local checkout (also for development)

```jsonc
// opencode.json(c)
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "/absolute/path/to/opencode-system-one" }
  ],
}
```

Point `package` at the checkout root (the directory containing
`package.json`); OpenCode loads the entrypoint from its `exports`. If changes
to the checkout are not picked up, restart with `opencode service restart`.

### Nix / home-manager

Pin the repository and copy the entrypoint to a stable path, then configure
OpenCode to load that path:

```nix
# in your home-manager configuration (e.g. home.nix)
opencode-system-one = pkgs.fetchFromGitHub {
  owner = "atvari-eu";
  repo = "opencode-system-one";
  rev = "<pin>";
  hash = "<pin-hash>";
};

home.file.".config/opencode/jev-plugin/index.ts".source =
  "${opencode-system-one}/src/index.ts";
```

```jsonc
// opencode.json(c)
{
  "plugins": [
    { "package": "~/.config/opencode/jev-plugin" }
  ],
}
```

### Options

Everything is on by default except `route`, `effort.auto`, `doneCheck`,
`find`, `approvals`, and `compaction` (all opt-in); turn parts off with the
object form. The judgment-model override is the string form of `"model"`;
model-routing options live under their own `"route"` key so the two
meanings never share one ambiguous key:

```jsonc
{
  "plugins": [
    {
      "package": "github:atvari-eu/opencode-system-one",
      "options": {
        "screen": { "enabled": true, "mode": "annotate", "tools": "all" },
        "model": "jev-1.13", // optional; overrides JEV_MODEL and the default
        "scrub": { "enabled": true },
        "tools": true,       // jev_decide + jev_judge_many
        "commands": true,    // /jev-screen + /jev-done-check
        "cache": true,
        "auto": {            // the "Auto" entry + per-turn routing; see "Auto model routing"
          "candidates": ["openrouter/anthropic/claude-3.5-haiku", "anthropic/claude-sonnet-4"],
          "minConfidence": 0.6,
          "fallback": "openrouter/anthropic/claude-3.5-haiku"
        },
        "effort": { "auto": true }, // per-prompt thinking level (pairs with route)
        "doneCheck": { "auto": true }, // see "Auto done-check"
        "find": { "enabled": true },   // see "jev_find"
        "approvals": { "mode": "auto" }, // see "jev-assisted approvals"
        "compaction": {      // see "System One compaction"
          "enabled": true,
          "mode": "replace"  // or "clean"
        }
      },
    },
  ],
}
```

## Jev-first latency

OpenCode always runs the primary model on a prompt - a plugin cannot skip
that turn. When latency matters more than flexibility, use the zero-model
paths instead: `/jev-screen` answers with no model turn at all, and a
dedicated agent in `opencode.json` with a tool-first prompt can host
judgment-only turns.

## Auto model routing

Before every turn, jev can pick how the turn runs: the thinking level and,
optionally, the model. Two toggles, one judgment path:

- `"effort": { "auto": true }` routes only the *reasoning variant*
  (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` - the levels
  the UI's effort picker offers) of the session's current model.
- `"auto"` (enabled by default) routes the *model itself* from the
  candidate list you name - typically a cheap fast model alongside the
  expensive one. Candidates may be bare ids as `provider/model` strings,
  or `{ providerID, id }` objects.
- Instead of naming candidates, or on top of them, you can let the pool come
  from OpenCode's own state via `"sources"` (see below).
- **Auto only ever routes a session parked on the `opencode-system-one/auto`
  entry.** Pick `Auto` in the model picker and every turn from there is
  routed to a real `(model, level)` pair, returning to `auto` at idle. Pick
  any other model and auto never touches the session at all — no jev call,
  no switching — until you select `Auto` again.
- With effort routing also on, an auto-entry turn runs as one combined
  decision per prompt (a single `(model, level)` question over the
  candidates that support variants), not two competing ones.

How a turn is routed:

- Candidates are validated against OpenCode's catalog before they are ever
  offered; unusable ones are dropped whole (up to 12 options), and routing
  stays off when nothing usable remains. Price hints from the catalog are
  woven into the option criteria.
- Fail-safe: jev unreachable, timeout (8 s), or an uninterpretable answer
  reverts to the session's base model - a no-op unless a routed switch is
  already active. Low confidence keeps the current model, routed switch
  included (no revert).
- Between two plausible picks the question prefers the *lower/cheaper*
  one: a cheap turn can escalate later, wasted thinking cannot be taken
  back.
- Each real switch appends OpenCode's native `model-switched` message (a
  small status line in the timeline), so routing decisions are visible and
  auditable.

**Manual picks win.** Auto only routes a session parked on the auto entry,
so a manual pick needs no detection at all: selecting any real model in
the picker takes the session out of auto's reach until you (re-)select
`Auto`. Inside the auto loop the judged picks are all the plugin's own;
their pin records exist only to identify the loop for the resting reset.

**Judge failure reverts.** If routing picked a candidate but the model
cannot be resolved at turn time (bad catalog name, provider outage), the
session is switched back to the auto entry, and the candidate is not
offered again for that prompt.

**Resting point.** A routed turn parks the session on the judged pick. At
session idle the plugin pulls it back to the auto entry, so the picker
shows `Auto` again. Only plugin-made switches are reset: a manual pick of
another model stays selected (it is out of auto's reach anyway), and the
loop resumes the moment you select `Auto` again. Resets are best effort -
without a usable idle event subscription the session simply stays parked
until the next prompt re-routes it.

### The auto entry (`auto.enable`)

`auto` is on by default. It registers the pseudo-model
`opencode-system-one/auto` in the model picker as a normal entry. Selecting
it is the *only* way auto engages: the plugin is its only controller, the
entry is never actually invoked - each prompt while the session sits on it
is routed to a real `(model, level)` pair by the normal routing path, and
at idle the session returns to the auto entry, so the picker keeps showing
`auto`. On any other model the plugin leaves turns untouched. Set
`"auto": { "enable": false }` to drop the entry (and all routing).

The picker's search matches the model's display name and provider name
only (the model schema has no alias/tag field), so you can give the entry
search aliases through the name: `"auto": { "aliases": ["Jev"] }`
shows the entry as `Auto (Jev)` so typing `jev` finds it too; the default
displays just `Auto` (findable via `auto` and the `opencode-system-one`
provider name). `"auto": { "name": "Autopilot" }` selects a custom
display name.

- Mid-loop (session on a judged pick) the normal path applies: jev may
  keep or change the pick; judge failures keep the current pick rather
  than reverting to the not-runnable entry.
- `auto.fallback` names a real model (`provider/model`) switched to when an
  auto-entry turn cannot be routed (judge failure, no usable candidates) -
  the switch is pinned, so the loop continues from there. Without it the
  turn stays on the pseudo-entry and fails visibly when it runs; the
  closed-port base URL makes that failure immediate rather than hanging.
- Re-engaging is simply selecting `auto` in the picker again.

The judgment is cached per prompt - repeating the same prompt costs
nothing. Each new prompt costs one jev round-trip (capped by the 8 s
timeout); the payoff is that trivial prompts get a cheaper model and level
than OpenCode's static selection would give them.

**Candidate sources.** Besides the static `candidates` list, the pool may
draw from what the session itself knows:

- `"sources": { "favorites": true }` merges the models you starred in
  OpenCode's model picker (the TUI favorites it keeps in
  `~/.local/state/opencode/model.json`).
- `"sources": { "opencode": true }` merges OpenCode's own models, ranked by
  the last 30 days of *your own* session usage ("popular" - the default
  mode; top 10). The `plan` key picks which plan's models to rank:
  `"plan": "zen"` (default, the `opencode` provider) or `"plan": "go"`
  (the OpenCode Go subscription), and `"popular": <count>` sets how many
  (min 1, max 40). Note this ranks by your usage - OpenCode publishes no
  global most-used leaderboard, so that is the nearest ground truth a
  plugin can stand on.

Sources are off unless enabled, are additive to `candidates` (explicit
entries keep their position ahead of sourced ones, duplicates drop out),
and fail open: a missing favorites file or an unreadable database simply
yields no candidates from that source. Sources are fetched once per
server process (the usage ranking moves on a 30-day horizon), so freshly
starred favorites or new usage show up after a restart - each routed
prompt after that costs zero extra I/O. Everything sourced still goes
through the same pre-offer checks as a hand-named candidate: it must
exist in *this session's* catalog (provider connected, workspace-enabled)
and carry no disabled/deprecated marker - unknown catalog statuses fail
open, and a pick that still fails to resolve at turn time reverts rather
than failing the turn.

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `auto.enable` | `true` | Register the `opencode-system-one/auto` pseudo-model entry and enable per-turn routing. Auto engages only while the session sits on the entry; set `false` to drop the entry and all routing. |
| `auto.candidates` | `[]` | Models jev may route to (`provider/model` strings or `{ providerID, id }`). |
| `auto.sources.favorites` | `false` | Merge your TUI-favorite models into the routing pool. |
| `auto.sources.opencode` | `off` | Merge OpenCode's most-used models (30 d local usage, "popular" default): `true` or `{ "plan": "zen" \| "go", "popular": true \| count }`; plan defaults to `zen`, count to 10 (min 1, max 40). |
| `auto.minConfidence` | `0.45` | Minimum jev answer confidence required to switch model; clamped 0.25-0.99. Pair mode splits probability mass across many (model, level) options, so a pick needs a lower bar than you might expect. |
| `auto.fallback` | — | Real model (`provider/model`) switched to when an auto-entry turn cannot be routed; without it the turn fails visibly on the pseudo-model. |
| `auto.name` | `Auto` | Picker display name of the auto entry. |
| `auto.aliases` | `[]` | Extra search aliases, shown as a name suffix (`Auto (Jev)`). |
| `effort.auto` | `false` | Off unless explicitly enabled; routes the plain per-variant thinking level of any current model, and pairs with auto inside the loop. |
| `effort.minConfidence` | `0.45` | Minimum jev answer confidence required to switch the reasoning variant. |

The routing options live under `auto` instead of `model` because the
judgment-model override is the string form of `"model"` (see Options
above); sharing one key for a string and a routing object would be
ambiguous.

## Auto done-check

`"doneCheck": { "auto": true }` runs the completion self-check when your
session goes idle: was the last turn *genuinely* done, or did the agent
stop early? It is opt-in because it is the one place where the plugin
notices you unprompted - rules that keep it polite:

- Triggered by the session-idle event, never by model turns; the check
  runs while nothing else is executing.
- At most one notice per transcript change: the judged transcript tail is
  hashed, and an unchanged transcript is never judged twice. The tail
  excludes the plugin's own notices, so a notice can never re-trigger the
  check.
- At most one notice per user message: the agent's reply to a notice
  changes the tail hash, so the hash gate alone cannot stop a nudge loop.
  After a notice is posted, the checker stands down until a new user
  message arrives.
- Loop-aware: a run of identical rows in the tail (whitespace-normalized,
  own notices excluded) is reported as a loop - the notice says the
  session is repeating itself and asks you to interrupt or send a new
  instruction, instead of re-asking for "the remaining work".
- jev answers the same `noul` question as `/jev-done-check`
  (p(task complete), 0-1). One synthetic notice is posted only when
  completion looks unlikely - probability at or below `notifyBelow`
  (default `0.35`): a prompt to continue the remaining work or list it.
  When jev says done, you hear nothing.
- The judged tail is scrubbed (secret redaction) before leaving the
  process, and a notification is posted, not a model turn - no read
  receipt, no comment storm.

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `auto` | `false` | Off unless explicitly enabled. |
| `notifyBelow` | `0.35` | Post the incomplete-notice at or below this p(complete). |

## jev_find

`"find": { "enabled": true }` registers a `jev_find` tool: semantic
codebase search for questions grep cannot phrase - "where is this
*discussed*?", "which file decides how config X behaves?". The cascade:

1. Walk the workspace tree (respects .gitignore trimming and a secret-path
   skip list); a lexical prefilter ranks candidate files cheaply.
2. jev judges the ranked shortlist *by name* (one `noul` call) - which
   files could plausibly relate to the question.
3. Promising files are cut into windows; jev judges the windows by
   content (batched `noul` calls).
4. A final jev pass judges the surviving passages and the report ranks
   files with heat, line ranges and excerpts.

The report is a routing signal, not proof: it tells you which files to
*read*, not what they say - excerpts are cut mid-function and ranked by
relevance to the question, not by correctness. It costs several jev calls
and takes seconds, so it is a last resort after a failed grep, not a
default first try. Results reuse the normal cache key (same question on
the same tree costs nothing on repeat).

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Off unless explicitly enabled. |

## jev-assisted approvals

Permission requests (tool executions that would otherwise interrupt you) can
be vetted by jev before they reach you. The feature is opt-in and has three
modes:

- **Annotate** (enabled with `"approvals": { "mode": "annotate" }`): every
  `ask` verdict gets a one-line jev opinion added to the prompt you see -
  `[jev] likely safe (0.92)`, `[jev] uncertain (0.63) - review`,
  `[jev] likely risky (0.18) - review`. The decision stays entirely yours.
- **Auto** (`"approvals": { "mode": "auto" }`): the same judgment, and when it
  clears the confidence bar (default `0.85`, `minConfidence`), the request is
  approved programmatically and logged to the console. Only the allowlisted
  `actions` (default `bash`, `edit`) are candidates; `webfetch`, MCP calls,
  and everything else still prompt you.
- **Deny** (`"approvals": { "mode": "deny" }`): the mirror image - for the
  allowlisted `actions` only, a *likely risky* verdict (below 0.5) refuses
  the request programmatically (`effect: "deny"`, the reason rides back to
  the model as tool feedback so it can pick a different approach), and
  everything above that band still prompts you. Never auto-approves; gated
  and uncertain bands stay human prompts. Use it when you want the agent
  held back from obviously wrong operations but absolutely no automatic
  yes - useful while the account is on the Console free tier, where an
  unattended approve would fire billable work.

Every judgment only happens when a request would already prompt you -
already-allowed and explicitly denied requests stay free of any jev call.

Deterministic gates decide before any model does: requests containing secret
scans or `[REDACTED:]` markers, destructive patterns (`rm -rf`, `sudo`,
piped-to-shell, `git push --force`, `npm publish`, `DROP TABLE`, `dd of=`,
system paths, ...), or edits outside the project directory are **never**
auto-approved - they are annotated and left to you. The gate list is
deliberately a deny-the-shortcut list, not a security sandbox; a false
positive only costs automation, never safety - the human prompt remains.

The fail-closed ladder: jev unreachable, a timeout (8 s), or an
uninterpretable answer leaves the request exactly as OpenCode built it
(annotation aside), and low confidence never silently approves. Configured
deny rules and every "always allow" memory you made in the UI always rank
above the feature.

One framing matters: automatic decisions are an **explicit delegation you opt
into**, bounded by the deterministic gates above; `auto` never auto-denies and
`deny` never auto-approves, and every automatic decision is logged.

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `"annotate"` | `"annotate"` adds the verdict line to prompts; `"auto"` also auto-approves requests above `minConfidence`; `"deny"` also auto-denies allowlisted requests whose verdict falls below 0.5. Omit or `false` keeps the feature off. |
| `minConfidence` | `0.85` | `auto` threshold, clamped to 0.5-0.99. |
| `actions` | `["bash", "edit"]` | Actions eligible for `auto` and `deny`; annotations apply to every prompt-worthy request regardless. |

## System One compaction

Default OpenCode compaction asks a model to summarize older turns; a summary
is lossy. The `compaction` option swaps that for Jev decisions, porting the
approach of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
from Claude Code to the OpenCode plugin hook:

1. Tool calls are paired with their results by id. Calls in the first message
   of the compacted range (usually the previous checkpoint) or in the newest
   `preserveRecentMessages` messages are pinned and never touched. User and
   assistant text is never rewritten.
2. The judgment state is the whole transcript - oldest first, tool outputs
   replaced by short size notes (`ok, 4213 chars (omitted)`), inputs included
   - regex-scrubbed first, then fitted into `maxStateTokens` in stages
   (inputs truncated 1000→200→60 chars, old texts abridged, collapsed,
   one-lined, dropped, merged).
3. Every non-pinned call gets two `noul` questions: does the call still
   matter, does its result still need to stay verbatim? Questions are batched
   under `maxRequestTokens`; batches run concurrently and are cached like
   every other jev reply.
4. Decisions: result ≥ `keepThreshold` → keep both; else call ≥
   `keepThreshold` → keep the call, truncate the result to
   `truncateHeadChars` plus a note; else drop call and result together.
5. The hook then either **supplies the compaction summary itself** - the
   pruned transcript rendered verbatim, so no summarizer model call runs
   (`mode: "replace"`, the reference behavior) - or, when the guards don't
   allow that yet (mode `"clean"`, insufficient reduction, oversized
   summary), applies the decisions to the transcript and lets the built-in
   summarizer run over the cleaned history.

Host-injected `system` blocks (Code Mode tool-catalog updates and friends)
are excluded from both the judged state and the hook-supplied summary: the
host regenerates them every turn, so replaying them would only duplicate
what arrives fresh after compaction.

Being handed a block that is still too much? Run `/compact` again within
one minute of a previous compaction: the second pass yields to OpenCode's
built-in summarizer, which produces the default lossy summary instead. The
jev summary ends with a note reminding you of this.

Fail-closed: a missing key, a jev failure, a malformed answer, or a history
that cannot be fitted leaves compaction entirely to OpenCode's built-in
summarizer, on the unmodified transcript. Nothing is half-applied.

Privacy note: judging needs to see the conversation, so enabling compaction
sends the older transcript (scrubbed of known secret formats) to your Jev
endpoint - the same trade the reference makes. Verdicts are cached; the state
text is never persisted.

Options (all defaults mirror the reference):

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Off unless explicitly enabled. |
| `mode` | `"replace"` | `"replace"` supplies the pruned transcript as the summary; `"clean"` only rewrites messages and keeps OpenCode's summarizer. |
| `summary` | `"report"` | Shape of the hook-supplied summary. `"report"` collapses it to a five-line audit note - counts only: judged calls dropped vs kept-with-head, dropped calls grouped by tool type, nothing per-call and no text replay. `"transcript"` replays user/assistant text verbatim (plus per-call Jev verdicts) instead. |
| `keepThreshold` | `0.5` | Verdict probability at which call/result survive. |
| `preserveRecentMessages` | `6` | Newest messages pinned untouched. |
| `maxStateTokens` | `25000` | Judgment state budget before staged fitting gives up. |
| `maxRequestTokens` | `30000` | Per-request budget (state + questions); splits into batches. |
| `truncateHeadChars` | `300` | Head kept when a result is pruned. |
| `minReduction` | `0.25` | Required relative shrink before a hook-supplied summary replaces the built-in one. |
| `maxSummaryTokens` | half the model window | Cap on the hook-supplied summary (estimated tokens). |
| `auto` | off | Idle auto-compaction outside OpenCode's near-full trigger: at session idle, if the transcript (estimated ~chars/4) passes the target, the plugin posts the same compaction request `/compact` uses - which runs through the jev pass. Give the target as an object: `"auto": { "share": 0.5 }` compacts at that fraction of the session model's context window (follows model routing); `"auto": { "tokens": 60000 }` compacts at an absolute token count (wins over `share`). `"auto": true` is shorthand for `{ "share": 0.5 }`. Hysteresis is inherent: after a pass the transcript sits well below the target until the conversation regrows. |

## Skills

None needed, and none should be loaded on OpenCode with this plugin - the
tool descriptions, hooks, and commands carry the whole job. For other
agents (no plugin), the standalone `jev` CLI is the path, and the portable
skills in [`atvari-eu/skills`](https://github.com/atvari-eu/skills) can
drive it from any agent:

```console
$ skills add atvari-eu/skills@system-one -g
$ skills add atvari-eu/skills@auto-system-one -g
```

## Provider

Two jev deployments exist, picked with the `provider` plugin option; the
default stays `"opencode"`:

- **`"opencode"`** (default) - the OpenCode Console pay-as-you-go provider.
  Models: `jev-1.13` (bills Console credits) and `jev-1.13-free`
  (zero-cost, restricted by the Console to OpenCode clients).
- **`"opencode-go"`** - the OpenCode Go subscription provider. Useful when
  your Go key is entitled to the model you point at; the credential chain
  switches to the `OPENCODE_GO_API_KEY` env and the legacy store's
  `."opencode-go".key` entry (the CLI login level and the endpoint stay
  the Console ones).

```jsonc
{
  "plugins": [
    {
      "options": { "provider": "opencode-go" },
      "package": "github:atvari-eu/opencode-system-one"
    }
  ]
}
```

Unknown values log a warning and keep the default. The provider changes
which env key and legacy store entry are used - the CLI login level, the
endpoint, the request shape and the model catalog stay the Console's, and
billing is up to the deployment: today a paid jev call bills Console
credits, and an OpenCode Go subscription covers the chat model catalog,
not jev.

## Environment

Identical to the `jev` CLI (resolved fresh on every call; the key
is never logged or persisted):

1. `TYPESAFE_API_KEY` → `OPENCODE_API_KEY` env (opencode provider) or
   `OPENCODE_GO_API_KEY` env (opencode-go provider) - explicit override
2. The OpenCode CLI's credential store, read from `opencode auth export`:
   an API key or the active OAuth session (integration `opencode` - the V2
   CLI exposes only this one Console integration; the jev deployment is
   picked by the key↔endpoint pairing, not a separate CLI integration),
   which the CLI keeps refreshed. Consulted only against the default
   Console endpoint (so key and endpoint stay one deployment), cached per
   process, and re-read once if the endpoint rejects a cached session
   with 401.
3. Legacy opencode auth store (`~/.local/share/opencode/auth.json`) - the
   entry matching the provider (`."opencode".key` / `."opencode-go".key`);
   V1 installs and hand-planted keys; the V2 CLI no longer updates this
   file.

- `JEV_ENDPOINT` (default: OpenCode Console System One endpoint)
- `JEV_MODEL` (default: `jev-1.13-free`; the plugin's `model` option wins
  over this env, which wins over the default)

A missing key or failed call never produces a "successful" judgment: screen
marks `unavailable`, tools throw. Failures surface the endpoint's own
diagnostic: 401 reads as credential rejection (expired key or wrong
deployment), 402 as lack of funds on the Console inference account, 403 as
the pairing or free-tier gate. There is no provider degradation chain.

## Guarantees

- Secret scrubbing is **always deterministic regex** - never a Jev call -
  and applies to screening, tool inputs, prompts, and the compaction
  judgment state alike.
- Cached entries store **answers + usage only**, never the state text
  (compaction judgments included).
- Auto done-check runs only at session idle, judges a scrubbed transcript
  tail, dedupes by tail hash, and posts at most one notice per change -
  and only when completion looks unlikely (`notifyBelow`). The only other
  notices the plugin posts on its own are screen verdicts and
  routing stand-down/re-arm lines.
- Compaction never rewrites user/assistant text and never applies partial
  decisions; any failure falls back to the untouched built-in flow.
- User prompt text is never edited for instructions (scrub redaction
  aside): first-action guidance lives in the tool descriptions.
- Approvals never override configured deny rules, never auto-deny, and
  fall back to the human prompt on every failure mode; the deterministic
  gate list (destructive/secret patterns) is checked before any jev call.

Architecture and decision-history notes for contributors live in
[DESIGN.md](DESIGN.md).

## License

[MIT](LICENSE) © [atvari GmbH](https://atvari.eu)
