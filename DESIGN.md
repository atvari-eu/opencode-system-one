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
- **`.reply` unwrap**: `cachedJudge` returns `{ reply, cached }`; every
  injected judge must unwrap `.reply` (a former direct pass-through typed
  fine, passed tsc, and failed only at runtime - hence the comment at each
  injection site).
- **`tierOf`**: a defensive read across catalog cost shapes (`cost.input`,
  `price.perMillion.input`, bare number) that feeds a per-Mtok hint into
  option criteria; missing data simply yields no hint.

## Auto done-check: the unprompted-notice carve-out

This is the only feature where the plugin addresses the user without being
asked, so it carries extra invariants beyond fail-open:

- **Trigger**: the `session.idle` event, probed destructively - the
  subscription surface differs across OpenCode versions (async-iterable
  stream vs effect-style `subscribe(name, handler)`), so setup tries both
  and logs a skip when neither fits. No event, no feature.
- **Dedupe**: the judged transcript tail (`doneTranscript`) is hashed and
  stored per session (`done-check/<id>`); an unchanged tail is never
  judged twice, and multiple idle fires after one turn cost nothing.
- **Self-exclusion invariant**: the tail excludes the plugin's own
  notices, which is what makes "at most one notice per transcript change"
  structurally true instead of best-effort.
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
