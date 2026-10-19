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

## Approvals: verdicts, not probabilities

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
clamped 0.5-0.99). Originally a per-action allowlist (`approvals.actions`,
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

## Provider resolution: registry-derived deployments, not baked tables

Early support for non-Console System One deployments sketched a plugin-side
profile table (per-provider endpoint + env names). Two operator-facing
facts rejected it: endpoints configured once in `opencode.json(c)` should
not be retyped into plugin options, and a config change (renamed provider,
moved baseURL) must propagate without touching the plugin again - the
plugin's job is judgment, not a second config of record.

The design now derives everything from live sources, in resolution order:
`JEV_ENDPOINT` env (explicit override; skips the registry entirely), the
Console profiles (`opencode`/`opencode-go`, which keep the OpenCode System
One *product* route - verified live that the Console chat baseURL does not
also serve `/systemone`, so there is nothing in the registry to read for
them), custom metric-less http(s) URLs (operator-typed endpoint; plain
http only for loopback hosts, so a key cannot travel unencrypted over the
open network by accident), and - the default workhorse - any other id,
resolved through the OpenCode provider registry read routes
(`provider.get`/`provider.list` on the plugin's client context,
feature-detected) onto `settings.baseURL`, then joined with the System One
route suffix (`/systemone`, appended unless the base already ends in it).
The suffix is a documented convention of the System One interface, backed
by two verified server-side sources (a direct provider host and a
Console-managed connection proxy both expose `baseURL + /systemone`); a
deployment that does not follow it is not guessed around - the init ping
reports its own diagnostic and the plugin fails closed with the fault
instead.

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
session. The **session layer** (`[jev-error]` rows, the established
path) fires per judged failure whose class a user can act on, deduped per
session per error kind per deployment fingerprint (`sessionSurfaceKey`) -
a new session or a config change re-informs, an ongoing breakage does not
toast-spam a run of failing screens. The per-call failure text itself is
composed once (`deployFaultText`): the config row reads the message (host,
model, remedy), every judged call throws the per-call surface so existing
call-site catch paths surface the identical failure a live outage would.
The migration from the old 60-second per-message cooldown to
session-scoped dedupe was deliberate: cadence keyed to sessions/configs is
what the operator reasoning about "is it still broken?" needs; time-based
cooldowns hide and re-reveal the same fault unpredictably.

Screen-failure presentation changed in the same commit family: a failed
screen on a local tool (shell, reads, edits, MCP) no longer prefixes and
truncates the tool's own output - the failure is its own surfaced row, and
the tool result stays intact; the inline fail-closed annotation remains
for fetched web content only (`inlineScreenFailure` in logic.ts), where a
failed screen means possibly-injected content is about to enter context.

