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
  `"screen": { "tools": "all" }`. An unsafe verdict **replaces** the
  content fail-closed (default `mode: "redact"`) — fetched web pages note
  why they were withheld and how to override; local tool output is never
  withheld, only annotated. Set `"mode": "annotate"` to keep all content.
  The verdict lands in a separate `[jev-screen]` timeline row by default
  (`"annotation": "notice"` — result text stays clean; the model learns of
  a verdict late). Set `"annotation": "inline"` to prefix the result
  instead, so the model sees the verdict where it reads the content (plus
  `⚠ do-not-rely` over threshold). Screened state is regex-scrubbed and
  sampled to 12 kB; both paths share the judgment cache (same content
  costs nothing on repeat). The plugin's own judgment tools are never
  screened. A third question rates residual credential material against
  ordered levels, normalized to the 0-1 band (`"screen": { "secretThreshold":
  0.6 }` - at/above the threshold the verdict rises to flagged, advisory only: it never withholds
  or downgrades a higher band). For content that is not a tool result, the
  agent can call `jev_screen` itself — same judgment, its own tool row, a
  pass/flagged/unsafe verdict.
- **scrub** - deterministic redaction (pure regex, never a model call) of
  known secret formats in **tool inputs** and **user prompts**: PEM private
  keys, `sk-…` API keys, GitHub tokens (`ghp_`/`github_pat_`), AWS `AKIA…`,
  Slack `xox…`, GitLab `glpat-…`, age keys, `npm_…`, bearer tokens, JWTs.
  Replaced with `[REDACTED:<label>]`.
- **tools** - `jev_decide`: one request = one state + typed questions
  (noul/choice/score — score questions carry their ordered levels as
  `criteria`, a 2-10 item array); `jev_judge_many`: one judgment per item, launched in
  parallel and aggregated in code (weighted mean + low-confidence flags);
  `jev_screen`: on-demand junk/prompt-injection/secret-material screening of
  pasted or suspect content, back to back with the automatic fetched-result
  screen.
  Every judgment shows as its own tool row (`Running jev_decide…`) in the
  timeline, and the tool descriptions carry the when-to-call guidance -
  screening, claim verification, ranking, bounded choices, scoring, and
  self-contained classification questions (nothing to read first) - plus the
  skip rules and confidence thresholds. No companion skill is needed.
- **cache** - replies for identical (endpoint, model, state, questions) are
  served from durable plugin storage; only answers are persisted, never the
  state text.
- **commands** - `/jev-screen <url | file>` gives a one-shot junk/injection/
  secret verdict for any URL or local file; `/jev-done-check` runs a completion self-check over the recent
  session transcript; `/jev-compact` compacts the session now with jev
  decisions only, never falling back to the built-in summarizer;
  `/jev-approval-stats` lists which command patterns trigger approvals and how
  they resolve, so recurring asks can become explicit permissions rules. All
  answer without loading a skill.
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
- **approvals** (opt-in) - permission requests are vetted by jev with three
  scored questions (`reversible` / `serves_task` / `harmful`) before they
  reach you: with the default delegation, approve verdicts auto-run routine
  operations and refuse verdicts reject clearly harmful ones, so prompts
  stay for genuinely uncertain cases - and either verdict can be held at
  the prompt instead of enacted. Configured deny rules always win. See
  [jev-assisted approvals](#jev-assisted-approvals).
- **compaction** (opt-in) - replaces the lossy compaction summarizer with
  System One decisions: tool calls and results are dropped or truncated by
  jev verdicts, everything kept stays verbatim, no summarizing model call
  runs. See [System One compaction](#system-one-compaction).

## Requirements

- [OpenCode 2](https://opencode.ai/v2/docs)
- Access to a System One deployment. With the default OpenCode Console
  endpoint, credentials resolve per call: `TYPESAFE_API_KEY` / `OPENCODE_API_KEY`
  env → the CLI's own login (`opencode auth login` - an API key or your
  Console OAuth session) → the legacy auth store. Other deployments are
  resolved from your OpenCode provider config at startup (see
  [Provider](#provider)); keys and endpoints must still come from the same
  deployment. Paid models bill the responsible deployment's account - a call
  without funds comes back as 402 and is never silently retried elsewhere.

Nothing here depends on a specific model provider; the plugin only adds tools
and guards around your existing setup.

### Error popups

Judged deployments are verified at plugin start: the configured model is
ping-checked against the resolved endpoint once, and any fault (unregistered
provider, unknown model, missing/wrong credential, outage) fails every judged
feature closed until the plugin restarts with a working config. A changed
fault (new fingerprint) surfaces one `[jev-config-error]` toast once per
config change; per-session learning stays with the regular rows below.

User-actionable failures - no credential, 401 key rejection, 402 insufficient
funds, 403 endpoint gate, wrong model at the deployment, free-tier restriction
("only from within OpenCode") - surface as `[jev-error] …` timeline rows
rendered by the bundled TUI half (`./tui` export) as top-corner error popups,
exactly like OpenCode's own failures: at most one row per session per failure
class per deployment config, so repeated tool failures never toast-spam and a
new session (or config change) informs once again. Screening failures on
local tools surface the same way instead of inlining anything into the tool
output; fetched web content keeps the fail-closed inline annotation. Pure
transport noise (5xx, refused connections, opaque diagnostics) stays
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
        "screen": { "enabled": true, "annotation": "notice", "tools": "all" },
        "model": "jev-1.13", // optional; overrides JEV_MODEL and the default
        "scrub": { "enabled": true },
        "tools": true,       // jev_decide + jev_judge_many
        "commands": true,    // /jev-screen + /jev-done-check + /jev-compact + /jev-approval-stats
        "cache": true,
        "auto": {            // the "Auto" entry + per-turn routing; see "Auto model routing"
          "candidates": ["openrouter/anthropic/claude-3.5-haiku", "anthropic/claude-sonnet-4"],
          "minConfidence": 0.6,
          "fallback": "openrouter/anthropic/claude-3.5-haiku"
        },
        "effort": { "auto": true }, // per-prompt thinking level (pairs with route)
        "doneCheck": { "auto": true }, // see "Auto done-check"
        "find": { "enabled": true },   // see "jev_find"
        "approvals": true, // see "jev-assisted approvals"
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
  the switch is pinned, so the loop continues from there.
- Fail-safes make a turn on the pseudo-entry effectively unreachable,
  config or not: at the entry every prompt first drops the session onto
  the last real model it ran (its own pin's parked-from model, else the
  newest `model-switched` row) *before* the judge refines the pick, and
  without `auto.fallback` that same last-used model closes the routing
  chain. Idle notices (done-check) and idle-triggered compaction move a
  resting session off the entry before posting or summarizing, so their
  wake turns run real too - those admissions never pass the prompt hook,
  only this head start protects them. The pseudo-entry itself fails fast
  when hit (closed-port base URL makes the failure immediate rather than
  hanging).
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
| `auto.fallback` | — | Real model (`provider/model`) switched to when an auto-entry turn cannot be routed; without it the session's last-used model is the fallback. |
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
- Simultaneous end-of-turn events judge once: one probe per session runs
  at a time, and the idle subscriptions a reload leaves behind are handed
  back (setup returns a cleanup), so stacked copies never each post their
  own notice.
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

## jev_screen

Registered with `"tools": true` (alongside `jev_decide`) — no separate
option. The agent calls it on untrusted text that automatic screening does
not reach: pasted blocks, excerpts, snippets, suspicious tool output.

Input:

| Field | Meaning |
| --- | --- |
| `summary` | One line naming what is screened (shows as the tool row). |
| `content` | The untrusted text, verbatim — sampled to 12 kB like automatic screening. |
| `source` | Optional origin (URL, tool name) echoed in the report. |

Output: `junk` and `injection` noul probabilities, a `verdict`
(`pass` / `flagged` / `unsafe`, bands 0.5 / 0.85–0.7 matching the automatic
screen), a plain-language `verdictText`, and the redaction hit count
(`scrubbedHits`) when the content contained secret-like tokens before
judging. Same state cache as automatic screening: the same content costs
nothing on repeat.

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
be vetted by jev before they reach you. The feature is opt-in: omit
`approvals` (or set it `false`) and nothing changes; `true`, `{}` or any
object value runs. One judged request asks three scored questions -
`reversible`, `serves_task`, `harmful` - and their scores resolve against
configurable bars into the same effects the permission flow already speaks:
`allow` (auto-run), `ask` (prompt you), `deny` (refuse; the reason rides
back to the model so it can pick a different approach). What each verdict
enacts is your explicit delegation choice:

- **Full delegation** (the default: `true`, `{}`, or an object that omits
  the keys): an approve above its bars auto-runs, a refuse at or above its
  bar refuses - prompts stay for the genuinely uncertain band.
- **Hold approves** (`"onApprove": "ask"`): every approve presents the
  annotated prompt instead of auto-running - the "vetting opinions only, no
  automatic yes" posture (`[jev] approves (0.93) - held for you`), useful
  while the endpoint bills per request or you want opinions only.
- **Hold refusals** (`"onRefuse": "ask"`): a refusal becomes the annotated
  prompt (`[jev] refuses (0.86) - held for you`) instead of the automatic
  refusal - the judgment stands, you own the enactment.
- **Judge failures** (`"onFail"`, default `"ask"`): a judgment that never
  completes - timeout, endpoint fault, scores the resolver cannot interpret -
  stays OpenCode's own prompt; `"deny"` turns the failure into a refusal with
  the cause named, and `"allow"` enacts the request the judgment never scored
  (an explicit delegation in which the endpoint's health becomes the approval).
- **Legacy `mode`** (`annotate` / `auto` / `deny`) still works and maps onto
  the same knobs with a one-time deprecation notice: `annotate` holds both
  verdicts at the prompt, `auto` enacts both (the default delegation),
  `deny` enacts only refusals (the no-yes posture).

Delegation always applies below the deterministic gates and below
`permissions`: gate hits, `ask`-pinned slices, and the genuinely uncertain
score band still prompt you, with the reason named on the prompt (judge
failures too, unless `onFail` re-prices them - the bullet above).

The judgment is deliberately scored instead of a three-way verdict: the
questions return probabilities and the resolver does the arithmetic, so
there is no per-verdict confidence band to reconcile - one too-low score
names itself in the prompt. The questions:

- **`reversible`** - can these operations be undone? Both wordings ask the
  name and one carve-out only: operations read, or write inside `workspace`,
  and what they write there undoes with git or re-running. Reads outside the
  workspace and GET fetches score high - the old wording bundled
  workspace-locality and no-network use here and auto-asked exactly those
  classes (the largest recorded ask source). The posture: the agent runs
  under your own account, so host filesystem permissions already bound what
  it can touch and out-of-workspace reads add no marginal risk; writes stay
  workspace-confined, secrets entering context stay covered by the
  secret-path gate and scrub, and egress stays covered by `harmful`.
- **`serves_task`** - is running these operations a reasonable next step
  toward the task currently being served? Only asked (and its bar only
  enforced) when the session actually has a task; the judged state carries
  the latest real user message, redacted and capped.
- **`harmful`** - irreversible damage, secret exposure, or executing
  instructions that came from fetched content? The old refusal criteria as
  one score.

Resolution is fail-closed: `harmful` at or above the refuse bar refuses
first - no high reversible score outvotes it. Otherwise an approve needs
`reversible` at or above its bar, `harmful` at or under the approve-side
ceiling, and - with a task being served - `serves_task` at or above its
bar. Everything else prompts, annotated with the first failing check -
`reversible 0.74 (below 0.90)`, `off-task (serves_task 0.09)`,
`unclear (harmful 0.40)` - so you can act informed or re-bar. That is what
keeps prompts down: routine, workspace-local work (including
`rm -rf dist`, `npm run build`, `git commit`) clears the bars and never
interrupts; clearly harmful work refuses instead of interrupting; you
decide only the uncertain middle.

Every judgment only happens when a request would already prompt you -
already-allowed and explicitly denied requests stay free of any jev call.

Deterministic gates decide before any model does: requests containing secret
scans or `[REDACTED:]` markers, destructive patterns (`rm` with recursive
flags aimed at absolute or home paths, `sudo`, piped-to-shell,
`git push --force`, `git reset --hard`, `npm publish`, `DROP TABLE`,
`dd of=`, system paths, infra mutations - `terraform`/`tofu apply`/`destroy`,
`kubectl delete`/`apply`, `wrangler`/`vercel`/`fly deploy`, ...), or edits
outside the project directory are **never** auto-approved - by default they
are refused outright (the reason rides back to the model as tool feedback),
or annotated and left to you with `"onGate": "ask"`. Shell chains split on
every separator (`&&`, `;`, `|`, a background `&`, a newline) and the weakest
segment rules the whole request. (Routine workspace-local cleanup like
`rm -rf dist` is *not* gated; the judge sees the full command and its harm
score covers broad or unknown deletions.)
The gate list is deliberately a deny-the-shortcut list, not a security
sandbox; a false positive costs the request it holds - a refusal with
feedback by default, or the human prompt under `"onGate": "ask"`.

With `"readonlyAllow": true`, a shell request whose every chain segment is
a read-only builtin (`grep`, `ls`, `cat`, `strings`, `jq`, ...) skips the judgment
entirely - the pipeline class (`grep -n foo src | head -3`) that was the
largest judge burden in the recorded stats is structurally incapable of
mutating anything. Fetch-only `curl` segments qualify too (default `GET` /
`-X GET` / `-I` to stdout only; any body, form, upload, file output, header
dump, curl config or bundled flag concealing one falls back to the judged
path), and `find` qualifies only while it cannot mutate (`-delete` and the
`-exec` family judge like any other command). Redirects (`>`, `>>`, `&`)
count as writes and still
judge, and the check runs after the gates, so secret paths and destructive
strings hold exactly as they would without the option. When the matched
permission rule carries no operator `context`, the judged state also gains
a one-line default context for prefixes the scored review keeps misreading
(`curl`: GET requests read data vs state-changing methods and bodies;
`find`: read-only without `-delete` or state-changing `-exec`; `sed`:
without `-i` it never edits files in place).

The fail-closed ladder: jev unreachable, a timeout (`"jevTimeout"` sets
the per-judgment signal budget, clamped 2-120 s, default 8 s; transient
failures - timeouts and endpoint faults - retry once inside the budget, and
the retry re-asks on a lean judged state so a bigger payload never buys a
longer wait), or scores the resolver cannot interpret leave the request exactly as OpenCode built it
(annotation aside), with the first failing check named on the prompt
(`verdict unavailable`, `unclear (harmful 0.40)`) - a sub-bar score never
silently enacts anything unless you lowered the bar itself below it.
Configured deny rules and every "always allow"
memory you made in the UI always rank above the feature.

One framing matters: automatic decisions are an **explicit delegation you
opt into**, bounded by the deterministic gates above. The defaults enact
`approve` into a run and `refuse` into a refusal, and a gate hold into a
refusal; each can be held at the prompt with `"ask"` instead. Every
automatic decision is logged.

### Splitting permission config between the host and the plugin

The feature does not replace OpenCode's `permissions` - it sits one layer
below, seeing only requests the host rules resolve to `ask`. That split is
most useful when it stays deliberately asymmetric:

- **Host config: coarse trust boundary.** Keep it short and stable. The
  minimal pattern is a single catch-all `ask` per reviewed action, and the
  whole policy then lives in the plugin:

  ```jsonc
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "edit", "resource": "*", "effect": "ask" },
    { "action": "external_directory", "resource": "*", "effect": "ask" },
  ],
  ```

  Every `shell` and `edit` request now flows into the plugin instead of
  whenever-triggered prompts, and `approvals.permissions` (next option table)
  does the fine-grained shaping - `allow`, `ask`, `system-one` with
  `context`, per slice. Hard red lines - requests you never want to see,
  not even as a question with operator context - still belong here as
  host-configured `deny` rules, since a configured `deny` is final and the
  `evaluate` hook never runs for one.

- **Plugin `permissions`: the actual policy.** Same `{ action, resource, effect }`
  entries, wildcard matching and last-match-wins as the host. Safe commands
  get `allow`, mapped slices get `system-one` with `context` for the
  judgment, rarely-needed things stay `ask`. An `edit *` rule with
  `effect: "system-one"` is a typical shape: the host one-line `ask` hands
  edits to the plugin, the gate holds `secrets/` paths before any judgment,
  `context` tells the judge routine local edits are fine, and only the
  genuinely uncertain band still prompts you.

- **Cost note:** an `allow` effect saves more than a prompt - no jev call,
  no annotation, no gate. Host `allow` is even cheaper because the hook
  never runs. So actions that never benefit from judgment can skip it at
  the host level too; put judgment where the judgment adds something.

- **Escape hatch note:** "Allow always" memories created in the UI save
  host-level `allow` patterns, and they rank above both this feature and
  its `permissions`. Long-running setups therefore tend to keep the host rules
  coarse: the recurring commands that deserve a standing allow are captured
  by memories over time, and `permissions` carries everything else as policy.

The same file shows both halves together. Host `permissions` stays a
coarse boundary; every judgment-shaped decision lives in the plugin
options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",

  // HOST: coarse boundary + final red lines. Judged stuff routes to the plugin.
  "permissions": [
    { "action": "shell",              "resource": "*", "effect": "ask" },
    { "action": "edit",               "resource": "*", "effect": "ask" },
    { "action": "external_directory", "resource": "*", "effect": "ask" },
  ],

  "plugins": [
    {
      "package": "github:atvari-eu/opencode-system-one",
      "options": {
        "provider": "opencode",
        "model": "jev-1.13",
        "approvals": {
          // full delegation is the default; explicit keys are the knobs:
          "onApprove": "allow",            // "ask" holds approves at the prompt
          "onRefuse": "deny",              // "ask" holds refusals at the prompt
          "onGate": "deny",                // "ask" holds gate hits at the prompt instead
          "minConfidence": { "approve": 0.60, "refuse": 0.70 },
          // PLUGIN: the policy. Same shape, plus "system-one" and "context".
          // Ordered; the LAST matching rule wins.
          "permissions": [
            { "action": "shell", "resource": "git status *", "effect": "allow" }, // + git log/diff/branch/show, ls, ...
            { "action": "shell", "resource": "git push *",   "effect": "ask" },
            { "action": "shell", "resource": "sudo *",       "effect": "deny" },
            {
              "action": "edit",
              "resource": "*",
              "effect": "system-one",
              "context": "Workspace-local edits are routine and fine. Refuse or hand to the operator any edit under secrets/ or of .env, *.key, *token* files - do not judge those yourself."
            },
          ],
        },
      },
    },
  ],
}
```

Notes on the split:

- Host `deny` rules (and UI "Allow always" memories) outrank the plugin
  ruleset entirely; the example's `sudo *` deny line could equally live at
  the host for a boundary the plugin cannot even soften.
- `context` is injected into the judged state after the deterministic
  gates run, so a `secrets/` edit is held before the remark matters.
- `system-one` entries only fire for requests the host sends to `ask` - a
  host `allow` never reaches the plugin for that request at all.
- Resource paths inside the workspace directory are normalized to
  workspace-relative before rules, gates, and the judged state see them, so
  `read src/index.ts` and `read /home/me/proj/src/index.ts` resolve the same
  way and land in one `/jev-approval-stats` slice. Outside-workspace
  absolutes pass through unchanged.


Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `stats` | `true` | Records one aggregate in plugin storage (`jev-approval-stats`): every approval event folds into a per `(action, command-prefix)` entry with outcome counts (allow / deny / ask / gate / fail), the binding-confidence band of each outcome, a confidence band per judged question score (where the scores actually land - the calibration data for moving a bar off its default), a `reason/...` band naming the check that resolved the outcome (reversible below its bar, serves_task off-task, harmful over the ceiling, policy-held verdicts, refused-over-bar), `asked-approve` / `asked-refuse` counters, judged token totals, judge-failure cause classes (timeout / http / error) with the per-`onFail` enacted counts, and judged latency sums. `/jev-approval-stats` prints event totals across all recorded slices plus the top 20, with per-row fail causes, average judge latency and a suggested `minConfidence` bar pair (the 0.95-mass floors over the recorded verdict bands, shown when either direction carries at least 50 samples; a fully sub-0.5 verdict band proposes the 0 floor); hot ask slices become candidates for explicit `permissions` rules. Set `false` to skip recording. |
| `gates` | `{ secrets: true, readonlyBypass: true }` | The two deterministic-gate toggles, as one object. `gates.secrets` (default `true`): the built-in secret-path gate matches credential-ish local paths case-insensitively — `secrets/…`/`secret.*` files, `.env`/`.env.local`/`.envrc`, `.npmrc`/`.netrc` machine credentials, `.pem/.key/.age/.kdbx/.p12/.pfx/.gpg/.asc` containers, `.ssh`, `.gnupg`, `.aws` directories, `id_rsa`/`id_ed25519`-style keys, credential/token basenames, `.npmrc`/`.netrc` (registry and machine credential files) — for the local path tools (`read`, `grep`, `shell`/`bash` segments, `edit`/`write`); matching requests resolve through `onGate` - refused outright by default with the reason as tool feedback, or held at your prompt with `\"onGate\": \"ask\"` - in both cases even when an explicit allow rule would cover them (`webfetch` URLs are deliberately excluded - token-ish doc URLs would false-positive, and token VALUES there are caught by the value-level check). Matching is per chain segment, so a mid-chain `.ssh` reference (`ls ~/.ssh | xargs cat`) catches where whole-string matching missed it. Metadata-only listings pass through to jev: a shell chain whose every segment is a name-only command (`ls`, `stat`, `du`, `find` without `-exec`/`-ok`/`-delete`; no command substitution and no redirection inside any segment) cites names and never ingests content, so `ls -l ~/.ssh/atvari_sign*` judges instead of gating - one ingest-capable command anywhere (`cat`, `xargs cat`, `find -exec`, substituted `ls`) holds the chain as always. Identifiers with the keyword as a longer-word prefix (`tokenizer.ts`) do not match; `tokens.json` does. Encrypted containers matter even though content screening can't flag ciphertext - the path does. `gates.readonlyBypass` (default `true`): read-only shell commands (`grep`, `cat`, `ls`, `tail`, `find`, `jq`, …) skip the destructive-regex gate because their arguments legitimately mention dangerous strings (a grep pattern containing `sudo`, a log line with an `/etc/` path) without performing anything - secret paths still gate (the secrets check runs first), and a chain with one mutating segment still gates. Set either member `false` for stricter behavior; unknown keys are ignored. |
| `onApprove` | `"allow"` | What an approve verdict enacts: `"allow"` auto-runs the request; `"ask"` holds it at the prompt with `[jev] approves (0.93) - held for you` - the vetting-only, no-automatic-yes posture. |
| `onRefuse` | `"deny"` | What a refuse verdict enacts: `"deny"` refuses the request and the reason rides back to the model as tool feedback so it picks another approach; `"ask"` holds refusals at the prompt (`[jev] refuses (0.86) - held for you`) and leaves every enactment to you. |
| `onGate` | `"deny"` | What a deterministic-gate hold enacts (secret paths, destructive patterns, `[REDACTED:]`/secret-marker usage, edits outside the project directory): `"deny"` refuses the request with the reason as tool feedback, so the model re-plans without the prompt; `"ask"` leaves the hold at your prompt (`[jev] gate: secret path - review required`), the pre-`onGate` behavior - the middle ground when you want to see every gate-touching request instead of letting the model route around it. |
| `onFail` | `"ask"` | What a judgment that never completes enacts (endpoint unreachable, timeout after the retry, scores the resolver cannot reject or interpret): `"ask"` keeps OpenCode's own prompt unchanged (the fail-closed default); `"deny"` refuses the request with the cause as tool feedback (`[jev] approval: denied - judgment failed (http)`); `"allow"` enacts the request the judgment never scored - an explicit delegation in which the endpoint's health becomes the approval, so it belongs to trusted-until-verified setups. |
| `jevTimeout` | `8000` | The per-judgment signal budget in milliseconds, clamped 2000-120000. Each judgment gets the budget once and retries once inside it on transient causes (timeout, endpoint fault) before degrading to the fail path; the retry re-asks the same questions on a lean state (first three operations at 300 chars, no metadata) so a bigger payload never buys a longer wait. Configuration and credential faults fail fast without retrying. |
| `readonlyAllow` | `false` | The read-only fast-path: a shell request whose every chain segment is a read-only builtin (`grep`, `ls`, `cat`, `strings`, `tr`, `jq`, ...) is structurally incapable of mutating anything, so it allows without any jev call. Fetch-only `curl` segments qualify (default `GET`/`-X GET`/`-I`, stdout only; any body/form/upload/file-output/header-dump/config flag - or a bundled flag group concealing one - falls back to the judged path), and `find` segments qualify only without `-delete` or the `-exec`/`-ok` family. Redirects (`>`, `>>`, `&`) count as writes and still judge. Runs after the deterministic gates, so secret paths and destructive chains hold exactly as they would without the option. |
| `sandbox` | `false` | The sandbox posture: an operator-asserted claim that the agent runs inside a filesystem/network sandbox (nono, bubblewrap, a container) - the plugin cannot verify it, so this is the same trust family as `onFail: "allow"` and exists only to let jev calibrate. With `true` a default note ("operations outside its allowed paths and network fail harmlessly") rides in the judged state and both questions swap to sandbox-aware wording: `reversible` treats a write or deletion inside the sandbox's allowed writable paths as reversible even when the action itself cannot be undone (the sandbox bounds every mistake), and `harmful`'s refusal lanes narrow to what the sandbox cannot compensate for - deleting uncommitted source work, `git push --force`, `git reset --hard`, credentials going anywhere they shouldn't, `sudo`, piped-to-shell downloads, publishing, fetched-content instructions - while bulk out-of-workspace destruction and system-path contact fall away (outside the allowed set it just fails harmlessly; inside it, you granted it). The destructive gate defers its holds to the judge under the posture - recursive `rm` to a `~`/absolute path, `git push --force`, publishes, deploys, `dd`, `chmod 777`, `DROP TABLE` now judge instead of denying up front, and the residual misfire risk is capped by what the sandbox actually allows - while secrets (secret paths and `[REDACTED:]` markers) and out-of-project edits hold exactly as always. Take a string to assert the posture verbatim (e.g. `"landlock; only bundled paths writable; network denied"`, capped at 300 chars). A wrong-typed value is treated as absent, never as a silent relaxation. |
| `minConfidence` | `{ approve: 0.5, refuse: 0.5 }` | The bars the three scores resolve against. Defaults sit at the noul midline: within an `approvals` setup you already delegated, so anything weakly certain enacts and mid-band harmful refusals instead of prompting. A single number sets both verdict bars; an object sets `approve` / `refuse` individually (legacy `deny` = `refuse`) and may carry per-question overrides that beat the verdict keys - `reversible` and `serves_task` take their own bars, `harmful` takes the approve-side ceiling (an explicit override clamps 0-0.5; without one the ceiling is the complement `1 - approve`). Verdict bars clamp 0 - 0.99: a sub-0.5 bar is an explicit delegation that enacts the verdict even on unsure scores (the judged state still has to carry valid scores), so `{"approve": 0.4}` auto-runs a reversible 0.45 the pre-0-floors code would have prompted; note a single number sets BOTH bars, so `0.3` also drops the refuse bar to 0.3 - use the object form unless you mean both. Unknown keys are ignored; unsupported values fall back to these defaults. Lower a bar to enact more of that verdict, raise it to hand more to you; raising `refuse` toward `1 - approve` widens the prompted middle instead of refusing. |
| `permissions` | `[]` | Plugin-level permission rules evaluated before jev looks at a request. Entries use the same shape as OpenCode 2 permission rules: `{ "action": "shell", "resource": "git push *", "effect": "deny" }` - `action` is optional and defaults to any action, `resource` is an OpenCode glob (`*` spans any characters incl. `/`, `?` is one character; a shell pattern ending in `" *"` also matches the bare command), and `effect` is `allow`, `ask`, `deny` or `system-one`. Rules apply in order with the last match winning; `allow` and `deny` are enacted directly, `ask` leaves the request exactly as configured (plain prompt, no jev verdict, no annotation), and `system-one` falls through to the regular jev judgment with the entry's optional `context` remark (max 400 chars) injected verbatim into the judged state - use it to steer the verdict for a specific slice, e.g. `{ "action": "edit", "resource": "*", "effect": "system-one", "context": "Workspace edits are routine; edits under secrets/ are operator territory, never judge those yourself - ask." }`. Entries may also carry a `hint`: a note posted once per session to the agent context when a matching request resolves - a plain string applies to every outcome, an object `{ "allow": …, "ask": …, "deny": … }` keys the note by the resolved outcome (the deterministic gate counts as the outcome `onGate` enacts - `deny` by default, or `ask` when held), e.g. `{ "action": "external_directory", "resource": "*", "effect": "ask", "hint": "for more than occasional access, prefer /cd to that directory" }`. Host-configured deny rules and saved approvals still rank above these. Since enactment applies to every judged action, `ask` rules are the way to pin a slice that must always prompt (e.g. cross-workspace access, MCP tools you do not trust). |

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
   under `maxRequestTokens` and at most `maxBatchCalls` calls per request
   (each call carries two questions, so the default 32 loads up to 64
   questions - the largest documented System One deployment cap, Munito's;
   stricter deployments need a lower value). Batches run concurrently and
   are cached like every other jev reply.
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

Are those fallbacks too quiet for you? `/jev-compact` (requires
`compaction.enabled`) is the explicit ask: it triggers the same compaction
request, but marks it so the jev pass is the whole story - "replace" mode
applies the pruned summary with no summarizer call at all; "clean" mode
announces the kept message counts as a `[jev-compact]` row before the
summarizer step your config chose; and "nothing stale", duplicate-pass and
jev-failure cases abort visibly (`compaction failed` in the transcript plus
an explaining row), never rerouting to the built-in summarizer the way a
plain `/compact` can. Every trigger still funnels through the same jev hook;
the command only changes what the fallbacks do.

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
| `maxBatchCalls` | `32` | Tool calls judged per request (two questions each = 64 questions - the maximum System One deployments document, Munito's 64-question cap; lower it for stricter deployments). |
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

The `provider` plugin option selects the System One deployment jev judges
against. Three forms, all resolved once at plugin start:

- **`"opencode"`** (default) - the OpenCode Console pay-as-you-go System One
  deployment. Models: `jev-1.13` (bills Console credits) and `jev-1.13-free`
  (zero-cost, restricted by the Console to OpenCode clients). The endpoint
  is OpenCode's System One product route; the Console chat baseURL does not
  serve System One itself.
- **`"opencode-go"`** - the OpenCode Go subscription deployment;endpoint
  unchanged, credential chain switches to `OPENCODE_GO_API_KEY` env and the
  legacy store's `."opencode-go".key` entry.
- **Any other id** - a provider registered in your OpenCode config,
  including local `providers.<id>` blocks in `opencode.json(c)`. At
  startup the plugin reads the OpenCode provider registry and derives the
  deployment endpoint from the provider's configured `settings.baseURL`,
  joined with the System One route: `<baseURL>/systemone`, appended unless
  the base already ends in `/systemone`. Change the provider config and the
  next plugin start follows it - no plugin option to keep in sync. On some
  2.0.x hosts locally configured providers register shortly after plugin
  setup; if the id is missing then, judged calls re-check shortly after
  boot before failing closed. Credential chain:
  `TYPESAFE_API_KEY` env → the CLI credential store entry for that
  integration (`opencode auth login` picks the key the registry resolves
  with) → a legacy `auth.json` entry of the same id.

Example: point jev at an inference provider you already registered for chat,
so judged calls run on the same deployment:

```jsonc
{
  "providers": {
    "acme": {
      "name": "Acme",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://api.acme.dev/inference/v1" },
      "models": { "acme-ai/decider-v1.2": { "name": "decider-v1.2" } }
    }
  },
  "plugins": [
    {
      "package": "github:atvari-eu/opencode-system-one",
      "options": { "provider": "acme", "model": "acme-ai/decider-v1.2" }
    }
  ]
}
```

- Console-managed connection providers (the `console-*` entries OpenCode
  adds when you connect an integration, e.g. `"console-acme-eu"`) work
  the same way and need **no provider key of their own**: their proxied
  System One route authenticates with your Console login, which the
  default chain already resolves.
- An explicit **URL form** (`"https://host/…"` or loopback
  `"http://127.0.0.1/…"`) bypasses the registry and points the deployment
  endpoint directly; keys pair via `TYPESAFE_API_KEY` env only.
- `JEV_ENDPOINT` env still overrides everything endpoint-related (and then
  skips the registry entirely).

Anything else is a fault: unregistered provider, unreachable endpoint or an
unverifiable model fail all judged features closed with the deployment's own
diagnostic (and a toast once per config change) - never a silently guessed
endpoint, never a fallback to another provider. The one exception: an id
left out of the registry at startup re-checks after boot (see DESIGN) before
failing closed.

## Environment

Resolved once per plugin start together with the deployment (the key
is never logged or persisted; `JEV_ENDPOINT` skips the registry):

1. `TYPESAFE_API_KEY` / `OPENCODE_API_KEY` env (Console deployments) or
   `OPENCODE_GO_API_KEY` (opencode-go), `TYPESAFE_API_KEY` for
   host-registered providers - explicit override. The `TYPESAFE` key is
   the deployment-agnostic one: it must pair with whatever endpoint is
   resolved.
2. The OpenCode CLI's credential store, read from `opencode auth export`:
   an API key or the active OAuth session, which the CLI keeps refreshed.
   Console deployments read the integration `opencode` (the single Console
   integration the V2 CLI exposes); host-registered providers read their
   own integration entry (`opencode auth login <provider-id>` adds one).
   Skipped while `JEV_ENDPOINT` is set, so an exported key never pairs
   with a foreign endpoint. Cached per process and re-read once when the
   endpoint rejects a cached key as worn - a 401, or a diagnostic naming
   the key/credential as expired/revoked/invalid. (The Console's 422
   "upstream unavailable" responses are a deployment outage, not a
   credential signal.)
3. Legacy opencode auth store (`~/.local/share/opencode/auth.json`) - the
   entry matching the resolved provider id (`."opencode".key`,
   `."opencode-go".key`, or the provider's own id for hand-planted keys);
   V1 installs and hand-planted keys; the V2 CLI no longer updates this
   file.

- `JEV_MODEL` (default: `jev-1.13-free`; the plugin's `model` option wins
  over this env, which wins over the default)

A missing key or failed call never produces a "successful" judgment: screen
marks `unavailable`, tools throw. Failures surface the endpoint's own
diagnostic: 401 reads as credential rejection (expired key or wrong
deployment), 402 as lack of funds on the responsible account, 403 as the
pairing or free-tier gate. There is no provider degradation chain.

## Guarantees

- The deployment is **verified at init**: no judged feature ever consults
  an endpoint or model that has not answered a minimal live ping this
  process; faults fail closed and toast once per config change.
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
- Approvals never override configured deny rules and fall back to the human
  prompt on every failure mode; delegation is explicit (`onApprove` /
  `onRefuse`), and the deterministic gate list (destructive/secret patterns)
  is checked before any jev call.

Architecture and decision-history notes for contributors live in
[DESIGN.md](DESIGN.md).

## License

[MIT](LICENSE) © [atvari GmbH](https://atvari.eu)
