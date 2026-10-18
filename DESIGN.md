# Design notes

Architecture context and decision history for contributors. Rider-facing
behavior lives in [README.md](README.md); this file documents why the plugin
is built the way it is.

## Tool registration

- `jev_decide` / `jev_judge_many` are registered as first-class tools (not
  Code Mode nested calls), so every judgment surfaces as its own tool row in
  the timeline - judgments must stay visible and auditable in sessions.
- No multi-state batch endpoint is ever simulated: `jev_judge_many` sends one
  request per item (parallel) and aggregates in code (weighted mean +
  low-confidence flags). Long items are the state; they are never pasted into
  one giant request.

## Description budget

The tool descriptions are a request-schema surface: they run on every
request, so each is budgeted at ~300 tokens. Expansion belongs in the README
(portable guidance) or in skills for other agents - never in the schema. The
same rule keeps injected prompt text out of the architecture (see Routing
notes).

## OpenCode internals the plugin leans on

- Plugins cannot skip the primary model turn for user prompts; OpenCode
  exposes result-skips only for the compaction, title, and generate flows.
  The plugin's latency levers are therefore description-led first actions
  and the zero-model command path.
- **Effort / variants**: OpenCode models thinking level as the model's
  reasoning variant (`Model.Ref#variant`). Variant overlays apply when the
  `LanguageModel` is resolved - which reads `session.model` *after* the
  prompt hook fires, so `session.switchModel(..., { variant })` inside the
  hook lands for the current turn. An unknown variant fails the whole turn
  at resolve time, hence the strict filter against the model catalog's
  listed variants. Every real `ModelSelected` publish appends a
  `model-switched` transcript message (also the manual-pick detection
  signal; the plugin records its own switches in plugin storage to
  attribute them).
- **Permissions**: a configured deny rule short-circuits *before* plugin
  hooks (configuration outranks the plugin by construction). The
  `permission/evaluate` hook receives a mutable event: rewriting
  `effect` (`ask` → `allow`) is the approval mechanism, `message` rides
  into the human-facing prompt. The hook also fires for already-allowed
  operations - the approvals hook early-returns there, which is why only
  actual `ask` cases ever cost a jev round-trip.

## Prompt-notes: history of the removed feature

Prompt-append notes to steer the first action were tried and removed:

1. Broad vocabulary gate (`judge`, `verdict`, `noul`, `system-one`): visible
   false positives on ordinary prose, on skill names, and recursively on
   echoed notes.
2. Precision-first tool-name gate plus echo stripping (`dea696f`): fixed the
   noise class, but the "request vs mention" residual remained.
3. Default-off (`599a88f`), then full removal (`8ecf7fb`): the tool
   descriptions carry the identical first-action imperative on every
   request, and no measurement ever isolated the note's contribution -
   the two surfaces co-existed in every session since shipping.

Consequence adopted as a rule: user prompt text is never edited for
instruction purposes (scrub redaction aside). Semantic gating of the note
had also been considered and repeatedly rejected: a per-prompt classifier
would make every prompt leave the machine, and a visible note cannot ride
on soft confidence. If description guidance ever proves insufficient, the
escalation path is an opt-in classifier folded into the existing per-prompt
routing call (one round-trip, two questions, real since `routeTurn` pair
mode), measured offline first.

## Auto routing: one engine, two dials

Auto model routing and the older auto effort feature share one engine
(`routeTurn` in `src/logic.ts`); `src/index.ts` only performs the
OpenCode-side I/O the outcome declares (catalog lookups, `session.switchModel`,
pin storage). Rationale worth remembering when extending it:

- **Pair mode**: when `effort.auto` and `route.auto` are both on, the
  prompt hook asks one `(model, level)` question over the candidates that
  support variants, not two stacked judgments. Two separate calls would
  race each other's switches and double the latency; one call also lets
  the criteria state the cheaper-model-preference coherently.
- **The stand-down lattice** (in priority order for any prompt): a foreign
  manual pick (newest `model-switched` not matching the session pin) wins
  over everything; a return to the recorded base model re-arms auto; a
  low-confidence answer keeps the current model *without* reverting an
  active routed switch; a judge failure or uninterpretable answer reverts
  to base - but only if the newest switch is the plugin's own, otherwise
  it is a plain skip. The lattice is pure logic and fixture-tested; hooks
  stay thin on purpose.
- **`route` key rename**: the routing config moved from `model` to `route`
  because `options.model` is also the judgment-model override (a string) -
  one key carrying both a string and an object meaning is ambiguous in
  every config merger, not just OpenCode's. `effort-pin/...` keys are read
  as fallbacks so upgrades from the pre-rename storage keep working.
- **Candidate sources** (`route.sources`): the pool may extend past the
  static `candidates` list with what the session itself knows - TUI
  favorites (`~/.local/state/opencode/model.json` under `XDG_STATE_HOME`)
  and OpenCode's own most-used models (`session_message` rows read
  read-only via `bun:sqlite`, ranked by assistant-message count over 30
  days). The `opencode` source's single ranking mode is "popular" (top 10
  by default - hence `"opencode": true` is shorthand), and `plan` picks
  the model family: `"zen"` (the `opencode` provider, default) or `"go"`
  (the OpenCode Go subscription). Baked decisions: sources are opt-in
  (they widen what routing may switch to) and additive-only (explicit
  candidates stay ahead of sourced ones); the prompt hook runs per
  prompt, so the sources snapshot is read exactly once per process (the
  ranking shifts on a 30-day horizon - re-reading per prompt would only
  burn I/O), shared across concurrent hooks via an in-flight memo, with
  up to three attempts when the first read fails transiently; they fail
  open (missing file / failed DB read = no candidates from that source,
  logged once on change), and malformed shapes disable rather than guess
  (bar a clamped count). Availability gating happens twice: after
  merging, every candidate is checked against *this session's* catalog -
  provider auth and workspace enablement decide membership, so an
  unavailable provider's models vanish from the domain entirely - and
  known-bad flags (`enabled: false`, `deprecated`/`disabled`/... status,
  `time.deprecated`) drop the entry with a once-per-candidate log, while
  unknown statuses fail open. The 30-day local-usage window is the honest
  proxy for "most used" because OpenCode publishes no global ranking.
- **`.reply` unwrap**: `cachedJudge` returns `{ reply, cached }`; every
  injected judge must unwrap `.reply` (a former direct pass-through typed
  fine, passed tsc, and failed only at runtime - hence the comment at each
  injection site).
- **`tierOf`**: a defensive read across catalog cost shapes (`cost.input`,
  `price.perMillion.input`, bare number) that feeds a per-Mtok hint into
  option criteria; missing data simply yields no hint.
- **The auto entry** (`route.autoModel`): OpenCode has no "auto" model
  concept, so the plugin registers `opencode-system-one/auto` itself via
  `ctx.provider.transform` (Provider.Info.empty + Model.Info.default, a
  closed-port base URL so a direct invocation fails fast instead of
  hanging - fail-visible, never fail-silent). The entry is only ever a
  *resting point* the plugin routes away from; semantically it just makes
  the session base equal `opencode-system-one/auto`, so the existing stand-down
  lattice applies unchanged (a manual pick stands down until the user
  selects `auto` again, which is the base-return re-arm). Two
  lattice adjustments were needed: at the entry the options exclude a
  "stay" choice (auto is not runnable), and mid-loop judge failures keep
  the current pick instead of reverting to the not-runnable base.
  `route.autoFallback` exists because a failure *at* auto would otherwise
  leave the turn running on a dead model - the adapter (not the logic)
  switches to the fallback, keeping it pinned so the loop continues.
  Idle reset (the resting point pull-back - auto entry or, for plain
  auto effort, the model's default variant) lives in a shared idle
  subscription and only touches plugin-made switches (`pinMatches`),
  is best effort (no usable idle events = stays parked until the next
  prompt re-routes), and writes its own pin so the chain stays
  verifiable. In v2 the end of a turn is the terminal
  `session.execution.{succeeded,failed,interrupted}` event - builds of
  this era never broadcast `session.idle` on the stream, so the shared
  extractor accepts both; subscribing to execution events also puts the
  resting point back IMMEDIATELY after the turn, so the picker reads the
  auto entry at rest and the per-turn pick stays invisible to the user. `route-base/<sid>` had a latent `.id` vs `.modelID`
  mismatch that made the stored base a no-op; fixed while wiring the
  entry, and a session observed at the entry re-records its base as the
  entry (covers switching `autoModel` on after a real-model era).

## Auto done-check: the unprompted-notice carve-out

This is the only feature where the plugin addresses the user without being
asked, so it carries extra invariants beyond fail-open:

- **Trigger**: the `session.idle` event, probed destructively - the
  subscription surface differs across OpenCode versions (async-iterable
  stream vs effect-style `subscribe(name, handler)`), so setup tries both
  and logs a skip when neither fits. The payload extractor (`idleSessionID`
  in logic.ts) is shared with the resting reset and idle-compaction and
  normalizes both eras: v2 events carry the session in `data.sessionID`,
  legacy shapes in `properties`/top level - reading the wrong field does not
  error, it just sees no idle events at all and every idle feature silently
  dies, so the extractor is regression-tested against the v2 shape.
  No event, no feature.
- **Dedupe**: the judged transcript tail (`doneTranscript`) is hashed and
  stored per session (`done-check/<id>`); an unchanged tail is never
  judged twice, and multiple idle fires after one turn cost nothing.
- **Self-exclusion invariant**: the tail excludes the plugin's own
  notices, which is what makes "at most one notice per transcript change"
  structurally true instead of best-effort.
- **Stand-down invariant**: the hash gate alone cannot bound the notice
  count - the agent's reply to a notice changes the tail hash, so a filler
  reply loop would re-trigger the check forever (observed live: a session
  stuck answering "Holding - no change." to its own nudges). After posting
  a notice, the user-message count at notice time is stored in the same
  row (`userCountAtNotice`); the next idle with a user-message count not
  above it stands down before any jev request. One nudge per user turn.
- **Loop detection**: identical consecutive tail rows (whitespace-
  normalized, own notices removed first - a notice cannot mask a run it
  interrupts) flip the tail's `loop` flag; the notice then reports the
  loop ("interrupt or send a new instruction") instead of re-asking for
  the remaining work, which would only continue the loop.
- **Notification, not conversation**: the notice is one synthetic message;
  it never edits turns, never spawns model turns, and states p(complete)
  so the user can disagree with it.

## Screen-all: scoping lifted from webfetch-only

Screening generalized from a webfetch-only hook to any tool result
(`"screen": { "tools": "all" }`), with three deliberate asymmetries:

- **Fail-closed redaction stays webfetch-scoped** (`screenRedacts`):
  withholding a *fetched web page* wholesale is low-cost (re-read it if
  wrong), but withholding a local tool's output (a build log, a grep hit)
  can delete exactly the signal the agent needed. Other tools are
  annotated only.
- **Self-skip set**: `{ jev_decide, jev_judge_many, jev_find }` - their
  outputs are verdicts about already-judged content; screening them would
  recurse and double-cost every judgment.
- **Generalized cache key**: `{ tool, url, sampled content hash }` instead
  of url-only, so two tools hitting the same URL are distinct entries.

## jev_find: the cascade and what was simplified

`src/find.ts` ports oh-my-pi's `jfind` cascade
(walk → shortlist → windows → report) with OpenCode's plugin constraints.
Deliberate simplifications, in case the omp version evolves:

- **No sketch triage**: omp sketches candidate files into an LLM summary
  before windowing; here the lexical prefilter plus one `noul` pass over
  file names does that job - one fewer jev wave, cheaper and
  reproducible.
- **No fs-scan cache**: omp memoizes trees across runs; OpenCode tool
  processes are short-lived, so a cross-run cache would mostly never warm.
  Repeated *queries* still hit the judgment cache.
- **Integrity invariant**: the report ranks files with heat, line ranges
  and excerpts, but never quotes code as authoritative - descriptions and
  the report text both say "read the files before citing them", because
  window excerpts cut mid-symbol and rankings are relevance-only.
- **Secret-path skip list**: directory names that reliably host secrets
  (`.env`, `id_rsa`, key dirs) are skipped during the walk, in addition
  to the text scrub that runs on every judged window.

## Approvals: the "probability is never permission" tension

The System One guideline "a probability is never permission by itself"
targets an agent improvising approvals around the human. The approvals
feature resolves the tension explicitly instead of bending the guideline
quietly: delegation is opt-in in config, bounded by deterministic gates
checked before any jev call, never auto-denies, and logs every automatic
approval - the probability is one input to a declared policy, not the
policy itself.
