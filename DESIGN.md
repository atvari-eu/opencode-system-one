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

- **Pair mode**: when `effort.auto` and `auto` are both on, the
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
- **`auto` key rename**: the routing config moved from `model` to `route`
  because `options.model` is also the judgment-model override (a string) -
  one key carrying both a string and an object meaning is ambiguous in
  every config merger, not just OpenCode's. `effort-pin/...` keys are read
  as fallbacks so upgrades from the pre-rename storage keep working. A
  later rename folded the whole group under `auto` when the engagement
  gate changed (see below); that rename carried no backward compatibility
  by decision of the repo owner.
- **Candidate sources** (`auto.sources`): the pool may extend past the
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
- **The auto entry** (`auto.enable`): OpenCode has no "auto" model
  concept, so the plugin registers `opencode-system-one/auto` itself via
  `ctx.provider.transform` (Provider.Info.empty + Model.Info.default, a
  closed-port base URL so a direct invocation fails fast instead of
  hanging - fail-visible, never fail-silent). The entry is only ever a
  *resting point* the plugin routes away from.
  `auto.fallback` exists because a failure *at* auto would otherwise
  leave the turn running on a dead model - the adapter (not the logic)
  switches to the fallback, keeping it pinned so the loop continues.
  A 2026-10-18 incident showed a configured fallback alone is not
  enough: with no fallback set and a judge that fails fast (auth blip
  right after a service restart), admitted prompts executed the pseudo
  entry anyway - and synthetic wakes (done-check notices, the host's
  restart notice) bypass the prompt hook entirely, so nothing downstream
  guarantees anything for them. The adapter now fails safe before
  judging: at the entry every prompt first switches to the last real
  model the session itself ran (`emergencyRealModel` - the pin's
  parked-from ref, else the newest `model-switched` row; history, not
  intent, so no availability re-check is possible or needed), the judge
  refines on top of that placement, and one shared adapter helper
  (`ensureOffEntry`) moves a resting session off the entry before every
  plugin-posted wake - the done-check notice and the idle-triggered
  `session.compact` alike (the built-in summarizer runs a model call on
  the session's current model, exactly the hazard of a synthetic wake
  turn). Irreducible remainder: a host-generated
  synthetic reaching a session that never ran a real model before - the
  entry's closed-port base URL keeps that failure immediate.
  **Boot-window dead turns** (2026-10-21): a fresh session's first prompt
  right after a restart still hit that remainder because two adapter
  defects lined up. (1) Candidate validation ran against the startup
  catalog snapshot; providers activate asynchronously, so every candidate
  read as "absent from this domain" - and `modelInfo` memoized the miss,
  poisoning every later prompt for the process lifetime. Misses are no
  longer cached, and while none of the candidates is listed yet validation
  waits briefly (5 attempts, ~2.5 s, backing off, only in the 60 s boot
  window after setup) before concluding the candidate is unavailable; once
  a candidate is listed a miss is config, not boot, and is not waited on.
  (2) A fresh session has no pin and no
  `model-switched` row, so the emergency chain had no target and the turn
  executed on auto. The adapter now closes with the first named candidate
  when both `auto.fallback` and history are absent, and a `switchModel`
  the host rejects falls through the remaining usable candidates instead
  of leaving the session parked on the entry. Ordering stays: configured
  fallback > last-used real model > first candidate. The same remainder
  bit synthetic wakes: with no history to fall back to, `ensureOffEntry`
  used to return silently and the done-check notice still posted into a
  guaranteed ConnectionRefused. It now reports "not safe", and the notice
  is skipped (logged) instead of waking a dead turn.
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
  auto entry at rest and the per-turn pick stays invisible to the user.
- **Engagement gate rework** (after the entry's lived reality): originally
  auto routing engaged on every prompt of any session and used pins to
  detect foreign manual picks ("stand down until back at base"). Gating it
  on the *current* model being the auto entry is strictly stronger and
  simpler: a manual pick IS the stand-down (the session leaves auto's
  reach; selecting `Auto` again is the re-arm), so no route-base storage
  and no foreign-switch lattice remains for the model path. The pin
  record survives with a different job: its storage KEY is the loop's
  provenance (`route-pin` = a session of the auto loop, `effort-pin` = a
  plain effort session), and the per-prompt write keys off the outcome's
  mode (`pair`/`model` → route, `effort` → effort) so the two features
  compose correctly when both are enabled. `auto.enable` defaults to
  `true` - with nothing to opt out of, registering the picker entry for
  everyone is the honest expose of the feature (and it cannot interfere
  with any model the user picks by hand).
  In the model path the pin lattice code remains reachable only in its
  benign branches (own switches, or a failed pin read = fail open); the
  foreign-switch seats are structurally unreachable and fixture-tested
  as dead ends.

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
  Shape pitfall (observed live 2026-10-18): v2 `session.context` rows are
  flat and carry no `role` field - the kind rides as `type` - so a counter
  reading `role === "user"` stands at 0 forever and the invariant silently
  breaks (three probes judged and posted within one second after one turn
  end). The count now falls back to `type === "user"`.
- **Loop detection**: identical consecutive tail rows (whitespace-
  normalized, own notices removed first - a notice cannot mask a run it
  interrupts) flip the tail's `loop` flag; the notice then reports the
  loop ("interrupt or send a new instruction") instead of re-asking for
  the remaining work, which would only continue the loop.
- **Notification, not conversation**: the notice is one synthetic message;
  it never edits turns, never spawns model turns, and states p(complete)
  so the user can disagree with it. Live caution: v2 synthetic posts DO
  join the agent's next model call (the TUI wakes), so each notice earns a
  turn whose end re-arms the check - with the stand-down broken, that is
  the fusillade of near-identical notices observed. Two hardening rules
  came out of it: one probe per session in flight (concurrent copies all
  read the marker as absent and each would post), and setup returns a
  cleanup that hands back the idle subscriptions (a reload must not stack
  old probes beside fresh ones).

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

## Score criteria: the deployment shapes score questions

Judged screening worked against the baked Console deployment for a long
time, then the provider-derived Munito deployment answered every score
question with `422 - Invalid fields: questions.<id>.score.criteria`. That
wasn't an outage or a deployment quirk: a score question must carry
`criteria` as an ordered array of level descriptions (2-10) — the plugin had
been sending score questions bare, which the older Console endpoint accepted
silently. The provider fix earlier discovered this only through probes, so
the API reference (docs.typesafe.ai/api.md, score primitive) is the shape to
code against, not what one endpoint tolerated.

Screening's `secret` question now sends three ordered levels (redacted-clean
/ inert remnants / clearly usable) and the visible secret band stays 0..1:
the wire answer is a probability-weighted position across the levels (can
land between them), so UI-facing values are normalized by the answer's own
legend (falling back to the question's level count). `jev_decide` /
`jev_judge_many` accept object criteria (choice) and array criteria (score)
in their input schemas; compaction's Judge passthrough type follows. A bare
score question now fails at the deployment with the endpoint's own 422 -
fail-closed wording handles that surface like any other rejection.

Same class, second hit: the questions object count. Compaction batched
calls purely by token budget - a big session judged 90+ questions in one
request, which the Console deployment accepted (its schema has no max) and
the Munito one rejected wholesale with `422 - Invalid fields: questions`
(their schema caps `questions` at `maxProperties: 64`; other providers
publish yet other caps - ZeroGPU 16, NDI 512). It 422'd on the first batch,
so every compaction attempt failed the same way, and only compaction:
every other feature stays small (screen 3, approvals 3, decide a handful).
Batches now also wrap at `maxBatchCalls` calls (default 32 = 64 questions,
the largest cap documented today), so each request is valid at the strictest
deployment currently in use. The cost is more requests, each re-sending the
shared state - inherent to splitting, and `stats.requests` reports it.

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

## Approvals: scored questions under a resolver

The approvals feature started as a single `noul` question - "probability
that approval is safe" - thresholded at 0.85 for enacting an approval. In
practice that stayed prompt-heavy: the question's phrasing biases judges
under the bar (listing every risk makes calibration conservative), a
probabilistic verdict never names what should happen, and routine
workspace-local commands like `rm -rf dist` hit the hard-coded `rm -rf`
gate before any judgment.

The redesign resolves all three. The question is now one three-way choice -
approve / ask / deny, with the option descriptions steering the judge toward
decisive verdicts: routine reversible workspace-local work approves,
clearly harmful work denies, and `ask` is reserved for the genuinely
uncertain middle (its criterion explicitly says it is not for borderline
convenience). A verdict names the action, so enforcement is a pure mapping
(`resolveApproval` in logic.ts): `auto` enacts both decisive verdicts,
`deny` enacts only the refusal, `annotate` never enacts; the winner must
clear `minConfidence` (default 0.85, on confidence-in-the-verdict,
clamped 0-0.99 - the 0 floor seats sub-0.5 bars, the explicit delegation on
unsure scores; pre-2026-10 the floor was 0.5).Originally a per-action allowlist (`approvals.actions`,
default `shell`+`edit`) gated enactment; it was removed because the
`permissions` ruleset already covers its one legitimate use - pinning a
slice that must always prompt with an `ask` rule - while the list itself
grew into an awkward second dial next to the rules. With it gone, every
judged action is enactable, so always-prompt slices must be pinned by
`ask` rules.
Fail-closed is unchanged: a missing, malformed, or unknown choice answer is
never a decision.

Delegation tension: the System One guideline "a probability is never
permission by itself" targets an agent improvising approvals around the
human. The feature still resolves it explicitly: delegation is opt-in in
config, bounded by the deterministic gates that run before any jev call,
constrained again by the allowlist, and logged. `auto` now enacts automatic
*denies* too (it previously never auto-denied): the decisive deny verdict is
steered to critical operations by its criterion, denies are the fail-safe
direction (a wrong refusal is visible feedback to the agent, unlike a wrong
unattended approval), and below-bar denies still reach the human. The rm
gate narrowed to recursive deletions aimed at absolute or tilde paths;
workspace-local cleanup is judged instead of pre-gated, because it was the
single most common needless prompt.

The second redesign (2026-10, following OpenRouter's jev approvals
cookbook) returns to probabilities with judge-owned criteria: three `noul`
questions per judged request - `reversible` (undone with `git` or by
rerunning, writes confined to `workspace`; 2026-10 dropped the bundled
locality/no-network clauses after the stats showed them auto-asking every
out-of-workspace read and GET fetch - the largest recorded ask class; the
operator's posture: the agent runs under the user's own account, so host
filesystem permissions bound every path it can touch and out-of-workspace
READS carry no marginal risk - the workspace clause confines WRITES, while
secrets entering context stay covered by the secret-path gate and scrub
and egress by `harmful`),
`serves_task` (a reasonable next step toward the task line, only asked and
enforced when the judged state actually carries one), `harmful` (the old
deny criteria as one score) - and a pure arithmetic resolver
(`resolveApproval` in logic.ts): refuse first (`harmful` at or above the
refuse bar - no reversible score outvotes it), then approve needs
`reversible` at or above its bar, `harmful` at or under the complementary
ceiling (default `1 - approve`, float-normalized so the boundary answers;
an explicit `harmful` override is clamped 0-0.5), and - with a task -
`serves_task` at or above its bar. Everything else prompts, and the first
failing check names itself on the prompt (`reversible 0.74 (below 0.90)`,
`off-task (serves_task 0.09)`, `unclear (harmful 0.40)`). Why invert back:
the three-way verdict covered three criteria with one question and made
the bar a property of a fuzzy verdict ("how confident are you it denies?");
direct per-criterion scores calibrate, and a too-low score explains itself
instead of hiding inside a confidence band. The decisiveness problem the
first redesign solved moves from the judge to the resolver - scores are
permission numbers; what they enact is config.

Config and gates follow the inversion. `mode` becomes explicit
per-point delegation - `onGate`: `deny`/`ask` for what a deterministic-gate
hold enacts - refusal by default (a gate false positive costs the model the
request as tool feedback; `ask` keeps the pre-delegation prompt-holding
posture, and the deprecated `annotate` mode maps its gate to `ask`,
`auto`/`deny` to `deny`), plus `onApprove`: `allow`/`ask`, `onRefuse`:
`deny`/`ask`, and `onNoVerdict`: `allow`/`ask`/`deny` for the unclear band
no verdict resolves (annotate/auto/deny remain as a deprecated alias
mapped onto the knobs, logging one notice) - and `minConfidence` becomes bars:
`approve`/`refuse` verdict bars (defaults 0.5/0.7 - the approve bar at the
noul midline: within an `approvals` setup the operator already delegated,
so anything weakly certain enacts, while the refuse bar above it makes a
refusal need a clearly-harmful score and hands the mid band to
`onNoVerdict`; clamp 0-0.99 - the 0
floor seats sub-0.5 bars, the explicit delegation on unsure scores),
legacy `deny` = `refuse`; unparseable input falls back per-key so garbage
cannot silently raise a bar, e.g. the refuse default for a bare number
that sets both) plus per-question overrides `reversible`/`serves_task`
(own bars, same clamp) and `harmful` (own ceiling). 2026-10, third dial:
the unresolved band gets its own pricing key - `onNoVerdict`
(`allow`/`ask`/`deny`, default `allow`), distinct from
`onApprove`/`onRefuse`, which only govern resolved verdicts; the
enforcement points order as `onGate`, `onApprove`, `onRefuse`,
`onNoVerdict`, `onFail`. The default enacts whatever the bars leave
undecided - the bars only separate refuse from allow, and the outcome note
still names the first failing check (`- allowed by onNoVerdict`) while the
stats keep the reason bands. `ask` restores the annotated prompt the band
always resolved to, and the legacy `mode` aliases pin
`onNoVerdict: "ask"` to keep their old posture. The task line (`taskFromMessages`)
is strict extraction: the newest real user message over the same text
sources messageText reads, minus its JSON.stringify fallback - a row
without text parts supplies no task - own `[jev-…` notice rows and
synthetic kinds skipped, capped at 600 chars (the task feeds a comparison
judgment, relating one operation to a goal - a verbatim long message buys
no serving-score sharpness), scrubbed in the hook. Operations ride the
same tightness: 6 × 1200-char cap, middle-elided so a long command's
final targets always reach the judge (redirect targets, `&& rm -rf …`
live at the end); the transient retry keeps the first three at 300 with
a 60-char tail.
Sandbox posture (`approvals.sandbox`): an operator-asserted claim that the
agent runs inside a filesystem/network sandbox - the plugin cannot verify
it, the same trust family as `onFail: "allow"` - exists only to calibrate
jev: with it a factual note rides in the judged state and both questions
swap to the sandbox-aware wordings - `reversible` counts a write or
deletion inside the sandbox's allowed writable paths as reversible even
when the action itself cannot be undone (the sandbox bounds every
mistake), and `harmful`'s refusal lanes narrow to what the sandbox cannot
compensate for (uncommitted-work loss, `push --force`, egress, publishing,
`sudo`) while bulk out-of-workspace destruction and system-path contact
fall away: outside the allowed set an operation fails harmlessly, inside
it the operator granted it. The destructive gate defers its holds to the
judgment under the posture (recursive `rm` to `~`/absolute paths,
publishes, `dd`, `chmod 777` - judge instead of denying up front; the
residual misfire risk is capped by what the sandbox actually allows), while
secrets and out-of-project edits hold exactly as always. A wrong-typed
value reads as absent, so a bad claim never silently relaxes the questions.
Gates gained the infra-mutation verbs (terraform/tofu `apply`/`destroy`,
kubectl `delete`/`apply`, wrangler/vercel/fly `deploy`) and `.npmrc`/
`.netrc` secret paths, and shell chains now split on `|` and background
`&` like the other separators (quotes-rough by design: over-splitting
only adds checks, the weakest segment holds the whole request). The
secret-path gate matches per chain segment and exempts metadata-only
shell chains - every segment a name-only command (ls, stat, du, find
without -exec/-ok/-delete), no command substitution, no redirection:
listing cites names and never ingests content, so `ls -l
~/.ssh/sign*` judges instead of gating, while one ingest-capable
command anywhere holds the chain; `.ssh`/`.gnupg`/`.aws` match with a
word-boundary lookahead so mid-argument placements hold too. Verdict
words stay transmit-only (`approve`/`refuse`; "ask" is never a judged
answer), one judged request per permission ask, and the stats event grew
per-question score bands, `asked-approve`/`asked-refuse` counters and
judged token totals - so a bar moves off its default from calibration
data, not taste. The 2026-10 tuning pass added the `reason/...` band
(which failing check resolved the outcome), the transient retry's lean
judged state (same questions on fewer operations - payload traded for fit
inside the same budget), the fetch-only `curl` fast path and the widened
stdout-only builtin whitelist; `jevTimeout` was deliberately left at its
default - budgets stay put, payloads got smaller.

## Credential self-heal: re-read on worn-key diagnostics

Long sessions can ride a stale CLI-store credential: the plugin (and the
harness's jev-screen runtime) reads `opencode auth export` once per process,
so a key refresh mid-session leaves long-running processes on the old key
until the next restart, with the 401-keyed one-shot re-read firing only on
401. (The expired-key diagnostic the `jev` CLI surfaced came from the
legacy `auth.json` entry; observed histories differ per store level.)

The decision: the credential re-read triggers on a credential-class
rejection (`logic.credentialRejected`): status 401 always, plus any
diagnostic whose text names the key/token/credential/session as expired,
revoked or invalid, whatever status it rides. Deliberately not matched: the
Console's 422 "Upstream request failed: Endpoint is unavailable" wrap -
verified empirically to be the deployment's genuine upstream-outage
surface, not a worn-credential surface (it appears with a valid credential
in place, after the 401 era), so a re-read cannot help and costs one
needless export run. Fetched body detail parsing moved to a `detailOf`
helper shared by the retry check and the final error throw. Fail-closed is
unchanged: no re-read can make a failed call look successful; the retry
fires only when the fresh key differs from the old one, still only against
the default Console endpoint for the cli-store source.

## The db-backed store channel: when the auth-export subprocess is killed by the context

Live fault (Oct 2026): `loadCliStoreCredential` executed
`opencode auth export` through the operator's PATH, but the deployment
that mattered ran the opencode service sandboxed while the operator's
opencode builds are sandbox-wrapped - a nested execution refuses with a
nonzero exit and an empty stdout, for every candidate binary. The chain
fell through to the legacy `auth.json` entry, which held a stale planted
API key, and every judged call rode that key into a 401 with the
replace-the-key remedy. The deployment could not see it as a plugin
fault: normal chat calls authenticate through the host's own credential
path (no subprocess involved), so everything except jev worked.

Direct probes established the data line: the CLI's `auth export`, run
where nested execution is not refused, returns the active OAuth session
for integration "opencode" (device-method, with a refresh token the CLI
rotates on its own rejections), and the System One endpoint accepts
exactly that session's access token (200) while it rejects the stale
planted key with precisely the diagnostic the toasts had shown. The
export's entry shape matches `parseAuthExport` (`type:"oauth"` →
`access`), so the parsing was never the fault - only the execution plane
was.

Decision: the CLI store keeps two channels, first usable wins.

- `opencode auth export` stays channel 1 (the documented interface; works
  wherever the CLI runs).
- Channel 2 reads the CLI's db-backed store directly (`src/store-db.ts`,
  `src/store-db.test.ts`): readonly sqlite opens of the candidate db
  files (`XDG_DATA_HOME/opencode/*.db`, newest-mtime first), schema
  discovered at runtime - credential-shaped nodes (`{type:"oauth",access}`
  / `{type:"key",key}`, material >= 16 chars) are only accepted when an
  ancestor object ties them to the integration id as one of its exact
  string field values. Scans are bounded (40 tables, 300 rows each),
  transcript-shaped tables (`session|message|prompt|event|snapshot|blob|
  part`) are only entered after the auth-shaped ones come up empty, and
  the whole channel fails closed to `undefined` on any error. The oauth
  session outranks a stored plain key (it is the one the CLI rotates); an
  oauth node whose stored `expires` has passed is rejected as stale, so
  an unrenewable session fails the chain into "no credential" and its
  actionable remedy instead of a guaranteed-401 loop.

Consequences:

- In the faulted service context the plugin now resolves the live,
  rotating Console session without any user action; key rotation follows
  the CLI's own refresh writes (the store re-read on credential-class
  rejection picks the new access token).
- A legacy `auth.json` key that is the only resolvable source and gets
  rejected as expired now surfaces its own remedy (marker wording joins
  the 401 text; `jevUserError` classes it before the generic
  create-a-new-key branch): delete the stale `opencode`/`opencode-go`
  entries so the CLI store's session serves jev.
- Test isolation note: bun caches `os.homedir()` at process start, so
  run-time `$HOME` mutation cannot isolate store reads - credential-
  touching test files pin `XDG_DATA_HOME` at a per-process nonexistent
  data dir instead.

## Provider resolution: registry-derived deployments, not baked tables

Early support for non-Console System One deployments sketched a plugin-side
profile table (per-provider endpoint + env names). Two operator-facing
facts rejected it: endpoints configured once in `opencode.json(c)` should
not be retyped into plugin options, and a config change (renamed provider,
moved baseURL) must propagate without touching the plugin again - the
plugin's job is judgment, not a second config of record.

The design now derives everything from live sources, in resolution order:
`JEV_ENDPOINT` env (explicit override; skips the registry entirely), custom
metric-less http(s) URLs (operator-typed endpoint; plain http only for
loopback hosts, so a key cannot travel unencrypted over the open network by
accident), host-registered ids resolved through the OpenCode provider
registry read routes (`provider.get`/`provider.list` on the plugin's client
context, feature-detected) onto `settings.baseURL`, then joined with the
System One route suffix (`/systemone`, appended unless the base already
ends in it) - with the models.dev decision catalog (below) filling registry
gaps - and the Console profiles (`opencode`/`opencode-go`), resolved from
the decision catalog's per-model System One base (the Console chat baseURL
is verified live not to serve System One, so the host registry has nothing
to read for them; the baked product route stays as the last resort for the
rare boot where the catalog and its snapshot are both unavailable).
The suffix is a documented convention of the System One interface, backed
by two verified server-side sources (a direct provider host and a
Console-managed connection proxy both expose `baseURL + /systemone`); a
deployment that does not follow it is not guessed around - the init ping
reports its own diagnostic and the plugin fails closed with the fault
instead. The catalog-derived base composes with the same route suffix, and
its result is ping-verified exactly like a registry-resolved one - the
catalog names where System One answers, but only a live ping proves the
deployment still serves the configured model.

Both registry reads carry their own defenses, learned the hard way:
`provider.get` takes `{ providerID }` on 2.0.x hosts but earlier builds took
the raw string, so a rejection on one shape only means the shape is wrong -
both are tried before falling through to `provider.list()` (an array, a map,
or an outer `{ data }` wrapper; the shape-normalizing helpers stay pure in
`logic.ts` so tests can pin them). And a lookup at plugin setup time can
still miss a provider the host resolves fine seconds later: the config
plugin (`opencode.config.provider`) registers locally configured
`providers` entries during *its* setup pass, which runs after user plugin
setup (observed on 2.0.32, verified with a boot-time probe: config providers
were absent from `list()` at user-plugin setup, present at the first tool
execute). An unresolved host id therefore re-checks the registry on judged
calls - one `cachedJudge` retry, one shared inflight attempt, cheap local
reads - and re-runs the deployment ping after a late resolve. Everything
still fails closed when the id never appears: a judged feature inside that
first window waits at most one extra ping (seconds), never switches
endpoints, and a genuinely unregistered provider stays permanently failed.

Credentials pair with the same sources: Console profiles keep the Console
chain (env `TYPESAFE_API_KEY`/`OPENCODE_API_KEY`/`OPENCODE_GO_API_KEY` →
the single `opencode` export integration → legacy `auth.json` entry);
host-registered ids pair with their own integration (env
`TYPESAFE_API_KEY` → their `opencode auth export` entry → their
`auth.json` entry), because the CLI store lists every logged-in
integration, not just the Console's; explicit URLs carry no id, so only
the deployment-agnostic env key applies, and a Console key can never
silently pair with a foreign endpoint. When `JEV_ENDPOINT` is set the CLI
store is skipped for every chain (existing pairing rule).

## Decision-model discovery: the models.dev catalog slice, not static lists

The picker opened with a two-id constant (the long-established Console
models). System One deployments expose no listing route, but models.dev
turns out to serve exactly that listing for them: the provider catalog
filters server-side at `catalog.json?type=decision` - ~45 KB listing every
provider that serves decision models, each model record naming the System
One api base it is served at (`provider.api`), and unknown type filters
answer 400 instead of silently serving the unfiltered catalog, so a passive
contract change cannot be mistaken for an empty catalog. The canonical
`models.json?type=decision` (5 KB) was probed as the lighter alternative
and deliberately not taken: only the provider-keyed slice links model ids
to deployments, and one 45 KB fetch also named the ENDPOINT - the same
document every endpoint previously needed a baked constant for.

The piece that demoted the constant is the shape trick: the System One
base nests per model record (`provider.api`), while the provider-level
`api` field is the provider's *chat* base - verified live
(opencode: `…/inference/openai/v1` vs `…/inference/systemone/v1`), the
exact reason the Console chat baseURL can never serve System One. Reading
only the nested field makes the record a machine-readable version of the
old comment "the chat baseURL does not serve System One"; composing it
with the documented `/systemone` suffix yields precisely the formerly
baked Console endpoint (pinned by test), so `CONSOLE_SYSTEMONE` demotes to
the documented last resort - a passive fallback now, not a source of
truth. The registry-first order stays intact: host ids read the OpenCode
provider registry before the catalog is consulted at all, and the late
boot-resolution retry keeps that order.

Fetch discipline: once per process at init with a 10s timeout, mirrored
into plugin storage; a failed fetch serves the storage snapshot (any age,
because every candidate and endpoint is ping-verified before a judged call
rides it - a stale catalog can only ever produce a verified-failed pick,
never a silently wrong one), and zero sources leave the picker on its
minimal offline default while console endpoints fall to the baked route.
Ingest is guarded on two axes: records must carry the explicit
`type:"decision"` marker (a slice that ever mixes cannot leak a chat model
into the picker), and the parser only reads the wrapped provider/model
shapes a 200-and-JSON response can produce - anything else parses to an
empty index and the fallback chain applies.

## Init deployment check: ping the model, fail closed, two toast layers

No System One deployment exposes a model listing (Console and inference
hosts both POST-only; a wrong-method GET probes 405 unauthenticated), so
"the configured model exists here" is verified the only honest way: one
minimal POST at plugin start - a single noul question, a one-line state, a
10s timeout. A healthy decider answers in a token; an unknown model
answers the endpoint's own 400 model diagnostic; a wrong credential
answers its own 401; an unregistered host id fails before any call with a
named remedy. Strictly no-config inference: when no credential resolves,
the ping is still attempted unauthenticated - a deployment that needs
none (verified by its own 2xx) stays usable, one that answers 401/403
produces the no-credential fault with the chain's remedy rather than a
generic rejection.

Fault surfacing is layered to match how the operator experiences it. The
**config layer** (`[jev-config-error]` rows) fires when the broken
deployment's fingerprint (sha256 of endpoint|model) differs from the last
one recorded in storage: once per config change, across restarts, because
a persistent misconfiguration needs exactly one heads-up, not one per
session. The **per-call layer** (`[jev-error]` rows, the established path)
fires on every failed jev call with no dedupe: actionable classes keep
their stable remedy titles (`jevUserError`), everything else - timeouts,
5xx, refused connections, opaque diagnostics - surfaces the raw failure
text flattened to a one-liner (`surfaceTitle`), and routing/effort judge
failures join the same channel through `RouteOutcome.apiFaults` instead of
staying console-only. The per-call failure text itself is composed once
(`deployFaultText`): the config row reads the message (host, model,
remedy), every judged call throws the per-call surface so existing
call-site catch paths surface the identical failure a live outage would.

Surfacing cadence history: the per-call layer tiered down from a 60-second
per-message cooldown to session-scoped dedupe (once per session per error
kind per deployment fingerprint, user-actionable classes only) to the
current no-dedupe per-call surface. The session notch was deliberate -
cadence keyed to sessions/configs is what the operator reasoning about
"is it still broken?" needs - but a live credential outage flipped the
verdict: with approvals' `onFail: "ask"` the failures materialize as
repeated prompts anyway, so hiding the cause made every prompt
unexplainable, and per-call toasts make the noise track the damage
one-to-one instead. If toast volume ever needs taming again, start from
the config layer's fingerprint-gate lesson, not a time-based cooldown.

Screen-failure presentation changed in the same commit family: a failed
screen on a local tool (shell, reads, edits, MCP) no longer prefixes and
truncates the tool's own output - the failure is its own surfaced row, and
the tool result stays intact; the inline fail-closed annotation remains
for fetched web content only (`inlineScreenFailure` in logic.ts), where a
failed screen means possibly-injected content is about to enter context.

