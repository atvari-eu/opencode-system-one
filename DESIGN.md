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

## Routing notes: history of the removed feature

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
effort call (one round-trip, two questions), measured offline first.

## Approvals: the "probability is never permission" tension

The System One guideline "a probability is never permission by itself"
targets an agent improvising approvals around the human. The approvals
feature resolves the tension explicitly instead of bending the guideline
quietly: delegation is opt-in in config, bounded by deterministic gates
checked before any jev call, never auto-denies, and logs every automatic
approval - the probability is one input to a declared policy, not the
policy itself.
