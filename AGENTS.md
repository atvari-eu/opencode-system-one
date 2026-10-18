# AGENTS.md

Guidance for coding agents working in this repo. Architecture rationale and
decision history live in [DESIGN.md](DESIGN.md); rider-facing behavior and
every option table in [README.md](README.md) — update those two with any
behavior change instead of duplicating them here.

## Commands

- `bun` is not on PATH: run tests as `nix shell nixpkgs#bun -c bun test`
  (94 tests, 5 files, ~60 ms at the time of writing). That is the entire
  check — there is no tsc, linter, formatter, codegen, or CI config to hunt
  for, and no build step (OpenCode loads `src/index.ts` directly).
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
- Credentials: env override first, then `opencode auth export` (always the
  single `opencode` integration — the jev deployment is chosen by the
  key↔endpoint pairing, not a separate CLI integration), then the legacy
  `~/.local/share/opencode/auth.json` entry. Only the store level is
  re-read once on 401. Never log, print, or persist a key.
- Cached judgments store answers + usage only, never the judged state text.
- Secret redaction is deterministic regex — never a model call — and runs on
  every outbound state (screening, tool inputs, prompts, compaction).
- `jev_judge_many` sends one request per item and aggregates in code; never
  batch several states into one giant request.
- Tool descriptions ride every request: budget each at ~300 tokens; expansion
  belongs in README or skills, not the schema.
- User prompt text is never edited for instructions (scrub redaction aside).
  Prompt-append notes were tried and removed three times — don't re-add them
  (DESIGN.md "Prompt-notes" has the history); description-led guidance is the
  escalation path.
- Option keys: `model` is the judgment-model override (a string); per-turn
  model routing lives under `auto` (`auto.enable` default true, engages
  only while the session sits on the `opencode-system-one/auto` entry) —
  one key must never carry both a string and an object meaning.

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

- The end-user CLI binary may be `opencode2` (localhost wrapper) rather than
  `opencode`; the credential loader tries `OPENCODE_BIN` → `opencode` →
  `opencode2` in that order. Keep that fallback list intact.
- A `provider` plugin option exists but today both providers hit the same
  Console System One endpoint; only the env key name and legacy store entry
  differ per provider. Don't invent service-specific endpoints without a
  server-side source (README "Provider" documents the current state).
