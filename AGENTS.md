# AGENTS.md

Guidance for coding agents working in this repo. Architecture rationale and
decision history live in [DESIGN.md](DESIGN.md); rider-facing overview and
option tables live in [README.md](README.md) with per-feature detail pages in
[docs/](docs/) — update those with any behavior change instead of duplicating
them here.

## Commands

- `bun` is not on PATH: run tests as `nix shell nixpkgs#bun -c bun test`
  (573 tests, 28 files, ~7 s). That plus `typecheck` is the entire
  check — there is no linter, formatter, codegen, or CI config to hunt
  for, and no build step (OpenCode loads `src/index.ts` directly).
- Typecheck: `nix shell nixpkgs#bun -c bun install` once (dev deps), then
  `bun run typecheck` (`tsc --noEmit`, strict + `noUncheckedIndexedAccess`,
  source and tests). Where `bun run` is unavailable, the equivalent is
  `nix shell nixpkgs#typescript -c tsc --noEmit -p tsconfig.json` — the
  declaration files come from `node_modules`, so the install is required
  either way. `src` is clean today; keep it that way rather than adding
  `@ts-expect-error` (a new error means a real shape or narrow bug).
  `skipLibCheck` is on because host packages (`@opentui/core`) ship
  declaration errors we do not own.
- One file: `nix shell nixpkgs#bun -c bun test ./test/route.test.ts`. The
  `./` prefix matters — without it bun treats the argument as a test-name
  filter instead of a path.
- There is no hot reload: changed plugin code loads only after the running
  OpenCode service restarts (`opencode service restart`) or a new install pin.

## Layout

- `src/index.ts` is the only file allowed to import `@opencode/plugin`: hooks,
  tools, commands, HTTP transport, credential chain, and module-level caches
  (e.g. `auth export` runs at most once per CLI integration per process).
- `src/logic.ts` is host-free by contract: node builtins only, no side
  effects, no plugin import, no endpoint access. Put new feature decision
  logic here so tests stay host-independent; keep hooks thin.
- `src/find.ts` / `src/compaction.ts` follow the same idea — cascade/host
  flows take injectable deps or export pure helpers ("FindDeps",
  `collectCalls`, `applyDecisions`, …).

## Invariants (committed design decisions, not suggestions)

- Fail closed. A missing credential, judge failure, timeout, or malformed
  answer never produces a "successful" judgment, and there is no fallback
  chain between providers/endpoints. Status errors surface the endpoint's own
  diagnostic (401 credential rejection, 402 funds, 403 free-tier/pairing
  gate); new auth/HTTP code must preserve these readings.
- Credentials: env override first, then the CLI store - the `opencode auth
  export` subprocess channel, falling back to a direct read-only read of
  the db-backed store (`src/store-db.ts`) when the subprocess is
  unavailable in the running context; either way the active OAuth session
  outranks a stored plain key, an oauth entry past its stored expiry is
  skipped as stale, and the CLI-store level still serves the single
  `opencode` integration - the jev deployment is chosen by the key↔endpoint
  pairing, not a separate CLI integration - then the legacy
  `~/.local/share/opencode/auth.json` entry. The store level is re-read
  once per call on a credential-class rejection: 401, or a diagnostic
  naming the key/credential as expired/revoked/invalid. The Console's 422
  "Upstream request failed: Endpoint is unavailable" is a deployment
  upstream outage, not a credential surface - do not re-read on it. A
  legacy-only expired key surfaces the delete-the-legacy-entries remedy
  (the live Console session is shadowed), never "create a new key". Never
  log, print, or persist a key.
- Cached judgments store answers + usage only, never the judged state text.
- Context writes scale with **anomalies and explicit agent actions**, never
  with tool calls: a passing screen writes nothing to the transcript (no
  row, no inline prefix) in every `screen.tools` / `annotation` combination.
  UI-only signals ride the `jev-config` RPC events instead: `screen` for
  verdicts, `error` event-first for failed judged calls, `config` for the
  buffered init fault, `warning` for a degraded source (the Go monthly-limit
  page), `scrub` for counts-only redaction hits, and `approval` for permission
  resolutions. Rows are the fallback only when the host has no event surface.
  The init fault is persisted and replayed
  through `configFault` for late subscribers; TUI/panel subscriptions
  re-attach on `server.connected` (ctx.client changes across restarts). Only
  flagged/unsafe results, withheld unsafe content, approval hints, explicit
  commands, and capped done-check nudges (`DONE_NUDGE_CAP` +
  `awaitingUserInput`) may write. `screen.mode: "redact"` withholds unsafe
  results for **every** screened tool, not just `webfetch`. The done-check
  tail drops `NON_CONVERSATION_KINDS` (`model-switched`, `agent-switched`,
  `idle`) like the host's `toLLMMessage`; do not reintroduce those JSON rows.
- TUI panels are **pure renderers**: `tui.ts` owns RPC subscriptions,
  reconnect handling, and event recording. A panel module must not import
  `./rpc` or subscribe itself - a stale half-updated RPC export once took
  the TUI event panel down on a pin update.
- Secret redaction is deterministic regex — never a model call — and runs on
  every outbound state (screening, tool inputs, prompts, compaction).
- `jev_judge_many` sends one request per item and aggregates in code; never
  batch several states into one giant request.
- Tool descriptions ride every request: budget each at ~300 tokens; expansion
  belongs in the plugin docs (README/docs/) or skills, not the schema.
- User prompt text is never edited for instructions (scrub redaction aside).
  Prompt-append notes were tried and removed three times — don't re-add them
  (DESIGN.md "Prompt-notes" has the history); description-led guidance is the
  escalation path.
- Option keys: `model` is the judgment-model override (a string); per-turn
  model routing lives under `routes`, a record of meta models (the deprecated
  `auto` key is still accepted as an alias). The built-ins
  `default` and `review` are on by default and keep the picker ids
  `opencode-decisions/auto` and `opencode-decisions/auto-review` (parked
  sessions and route pins reference those ids); any other key registers
  `opencode-decisions/<key>`. Each entry engages only while the session sits
  on its exact entry, and a review-kind pool is always disjoint from the
  `default` entry's pool (the kind also selects the review routing
  criteria, independent of an inlined cut). The Console cut inlines on the
  entry itself under
  `pool` (`true` takes the kind's built-in cut, `false` disables it, an
  object sets `cheap`/`popular`/`strong`/`topK`/`minContext`), with
  `favorites` beside it, so there is no shared pool registry; a review-kind
  entry still subtracts the `default` entry's pool at route time. `pool`
  carries a boolean-or-object
  meaning, never a string (named pools were removed and a leftover string
  warns and fails closed). One key must never carry both a string and an
  object meaning.

## Conventions

- Conventional Commits: `type(scope): description` (`fix(auth):`, `feat(route):`,
  `docs:` no scope when repo-wide).

## Environment gotchas

- Always check the current OpenCode v2 plugin API (docs at
  https://opencode.ai/v2/docs/build/plugins and /build/plugins/cli) before
  using a host feature in a new way - the API has shifted between 2.0.x
  releases and our codebases. Bugs shipped here by trusting older shapes or
  memory of an API: `storage.store(key, { initial: value })` (not a raw
  default, and the docs' `[value, updater]` pair is the shape to guard
  against), `command.transform` editor details, keymap/panel/slot
  registrations, and hook-returned cleanup functions (hosts have had our
  cleanups be `undefined` - always skip non-function entries). Anything not
  covered by tests should be verified against the docs page, not from
  memory. `bun test` only proves module-load integrity, NOT runtime host
  behavior.
- Every `.tsx` module the TUI loads must be imported **statically** from
  `tui.ts` and start with `/** @jsxImportSource @opentui/solid */` (and
  `tsconfig` sets `jsx: react-jsx` + `jsxImportSource: @opentui/solid`).
  `@opentui/solid` is the documented OpenTUI JSX runtime; pointing at
  `solid-js` resolves `jsxDEV` from `solid-js/dist/solid.js`, which does not
  export it ("Export named 'jsxDEV' not found"), and Bun's default React
  runtime emits `react/jsx-runtime`. Dynamic `import("./x.tsx")` is also
  resolved by Bun at runtime and cannot see the TUI-provided runtime, so
  keep these imports static. All three failure modes took the TUI panels
  and footer markers down.
- OpenTUI text nodes must be children of `<text>`, never a `<box>`: the
  renderer throws `Orphan text error: "…" must have a <text> as a parent`.
  An empty-string fallback like `<box>{""}</box>` is enough to crash the
  panel - return `null` for non-matching slot names and wrap every text row
  in `<text>`.
- Keep custom `session.panel` renderables `selectable={false}`: mouse text
  selection over the panel tree corrupts the whole OpenCode TUI (the view
  shifts up and the renderer desyncs). Use the panel's `c`/OSC52 copy
  shortcut instead.

- The end-user CLI binary may be `opencode2` (localhost wrapper) rather than
  `opencode`; the credential loader tries `OPENCODE_BIN` → `opencode` →
  `opencode2` in that order. Keep that fallback list intact.
- The `provider` plugin option resolves deployments at init from live
  sources: `JEV_ENDPOINT` env > Console profiles (`opencode`/
  `opencode-go`, baked OpenCode System One product route) > http(s) URL
  form (explicit endpoint, plain http loopback only) > any other id via
  the OpenCode provider registry (`provider.get`/`provider.list` →
  `settings.baseURL` + `/systemone` suffix; feature-detected, fails
  closed unresolved). Credential chains likewise derive from the resolved
  kind (CLI store integration "opencode" for Console, the provider's own
  integration e.g. from `opencode auth login` for host ids; env-key only
  for URLs; skipped wholesale while JEV_ENDPOINT is set). The init ping
  (one noul question) verifies the model; faults fail every judged call
  closed via the cachedJudge gate and surface `[jev-config-error]`
  (once per config change) / `[jev-error]` (per failed call; the same
  title per session repeats at most once per 60 s window - a surfaced
  row wakes a turn, so an outage must not re-trigger itself)
  toast rows. Don't invent service-specific endpoints beyond the
  documented `/systemone` convention (docs/provider.md, DESIGN.md
  "Provider resolution").
