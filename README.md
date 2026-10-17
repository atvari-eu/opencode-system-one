# OpenCode plugin for the System One decision layer

An [OpenCode](https://opencode.ai) plugin that wires System One (Jev)
judgments into OpenCode automatically: every `webfetch` result is checked for
junk and prompt injection before it enters context, known secret formats are
redacted from tool inputs and user prompts, the agent gets `jev_decide` /
`jev_judge_many` tools with caching, judgment prompts are routed tool-first,
each turn's reasoning effort can be picked by System One from the prompt, and
context compaction can be decided by System One instead of a lossy summary.

## What it does

- **screen** - every `webfetch` result is judged (junk? prompt injection?)
  before it enters context. Mode `annotate` (default) prefixes the result with
  `jev-screen: junk=… injection=…` (plus `⚠ do-not-rely` over threshold); mode
  `redact` replaces unsafe content fail-closed. Screened state is
  regex-scrubbed, sampled to 12 kB, and cached per (url, content hash).
  Flagged fetches additionally surface as a visible
  `[jev-screen] ⚠ … do-not-rely` notice row in the timeline.
- **scrub** - deterministic redaction (pure regex, never a model call) of
  known secret formats in **tool inputs** and **user prompts**: PEM private
  keys, `sk-…` API keys, GitHub tokens (`ghp_`/`github_pat_`), AWS `AKIA…`,
  Slack `xox…`, GitLab `glpat-…`, age keys, `npm_…`, bearer tokens, JWTs.
  Replaced with `[REDACTED:<label>]`.
- **tools** - `jev_decide`: one request = one state + typed questions
  (noul/choice/score); `jev_judge_many`: one judgment per item, launched in
  parallel, aggregated in code (weighted mean + low-confidence flags). No
  multi-state batch endpoint is ever simulated. Both are registered as
  first-class tools (not Code Mode nested calls), so every judgment shows as
  its own tool row (`Running jev_decide…`) in the timeline, and their
  descriptions carry the judgment-moment guidance and call discipline - no
  companion skill is needed.
- **cache** - replies for identical (endpoint, model, state, questions) are
  served from durable plugin storage; only answers are persisted, never the
  state text.
- **commands** - `/jev-screen <url>` gives a one-shot junk/injection verdict
  for any URL; `/jev-done-check` runs a completion self-check over the recent
  session transcript. Both answer without loading a skill.
- **routing** - prompts that explicitly ask for a judgment get a short
  deterministic append telling the agent to make the matching
  `jev_decide` / `jev_judge_many` call its **first action** with verbatim
  inputs, instead of thinking the judgment through itself first. See
  [Fast routing of judgment prompts](#fast-routing-of-judgment-prompts).
- **effort** (opt-in) - before each turn, jev picks the reasoning effort
  (thinking level) that prompt deserves - from the levels the selected model
  actually supports - and switches the model's variant, the same mechanism as
  the UI's effort picker. Fail-open: if jev is unavailable or uncertain, the
  current level stays. See [Auto reasoning effort](#auto-reasoning-effort).
- **compaction** (opt-in) - replaces the compaction summarizer with System One
  decisions, following
  [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction):
  tool calls and results are dropped or truncated by jev `noul` verdicts,
  everything kept stays verbatim, and no summarizing model call runs. See
  [System One compaction](#system-one-compaction).

## Requirements

- [OpenCode 2](https://opencode.ai/v2/docs)
- Access to a Jev endpoint. With the default OpenCode Console endpoint, run
  `opencode auth login`, select `opencode`, and paste your API key - or export
  `OPENCODE_API_KEY` / `TYPESAFE_API_KEY` instead. Key and endpoint must come
  from the same deployment.

Nothing here depends on a specific model provider; the plugin only adds tools
and guards around your existing setup.

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

Everything is on by default except `effort` and `compaction` (both opt-in);
turn parts off with the object form:

```jsonc
{
  "plugins": [
    {
      "package": "github:atvari-eu/opencode-system-one",
      "options": {
        "screen": { "enabled": true, "mode": "annotate" }, // or "redact"
        "scrub": { "enabled": true },
        "tools": true,       // jev_decide + jev_judge_many
        "commands": true,    // /jev-screen + /jev-done-check
        "cache": true,
        "routing": { "hints": true }, // tool-first hints for judgment prompts
        "effort": { "auto": true }, // opt-in per-prompt thinking level; see "Auto reasoning effort"
        "compaction": {      // opt-in; see "System One compaction"
          "enabled": true,
          "mode": "replace"  // or "clean"
        }
      },
    },
  ],
}
```

## Fast routing of judgment prompts

When the user's prompt explicitly asks for a judgment ("judge these", "give a
verdict", mentions `jev`, …), OpenCode still runs the primary model first, and
that model tends to deliberate the question itself before reaching for the
tool. The plugin closes most of that gap mechanically:

- The `jev_decide` / `jev_judge_many` tool descriptions state that an explicit
  judgment request makes the tool call the **first action**, with the user's
  items passed verbatim - no pre-analysis, no rewriting.
- The `prompt` hook appends a short routing hint whenever a deterministic
  regex (`ROUTING_PATTERN`) matches the prompt: *"make that jev call your
  FIRST action … do not deliberate before calling; if no jev tool fits, ignore
  this note."* No model call decides this; the gate is a plain regex like the
  scrubber, and false positives degrade gracefully to "ignore this note".

Turn off with `"routing": { "hints": false }`.

Not possible plugin-side: skipping the primary model turn entirely - OpenCode
exposes result-skips only for the compaction, title, and generate flows, not
for user prompts. When latency matters more than flexibility, use the
zero-model paths instead: `/jev-screen` (runs the jev call with no agent
loop at all), or define a dedicated agent in `opencode.json` with a
tool-first prompt and switch to it for judgment-only turns.

## Auto reasoning effort

OpenCode models "thinking level" as the model's *reasoning variant*
(`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). With
`"effort": { "auto": true }`, the plugin asks jev once per prompt which level
that prompt deserves and applies it by switching the model's variant - the
same mechanism the UI's effort picker uses, programmatically, before the
turn's first request is resolved:

- jev answers a single `choice` question whose options are only the levels
  the selected model's catalog actually lists. Switching to an unlisted
  variant would fail the whole turn at model-resolve time, so the feature
  disables itself for models without reasoning variants.
- The judgment state is the prompt, truncated to 6 kB and scrubbed of known
  secret formats - same treatment as every other judgment state.
- Fail-open everywhere: jev unreachable, timeout (8 s), or an uninterpretable
  answer leaves the current level untouched and the turn proceeds normally.
- A confidence floor (`minConfidence`, default `0.6`) keeps the current level
  when jev is unsure - uncertain judgment must not flap between levels. When
  the picked level equals the current one, nothing happens at all.
- The question biases toward the *lower* of two plausible levels: a cheap
  turn can escalate later, wasted thinking cannot be taken back.

Each real level change appends OpenCode's native `model-switched` message (a
small status line in the timeline), so changes are visible and auditable.

**Manual picks win.** The picker commits through the same `session.switchModel`
the feature uses, so a manual effort pick shows up as the newest
`model-switched` message before the next prompt is judged. The plugin records
its own switches in durable plugin storage; when the newest switch is not one
of its own (you picked a level, or changed the model another way), auto stands
down for that session - no jev call, no switching - until the variant is
`Default` again, which re-enables it. Repeated prompts log the stand-down
notice once. A missing attribution record (cleared storage, fresh install)
errs toward the user and keeps auto off until the next `Default` pick. The
gate is a plain comparison, no model call.

Like every jev call, the judgment is cached per prompt - repeating the same
prompt costs nothing. The price is one extra jev round-trip per new prompt
(inside prompt admission, capped by the 8 s timeout); the payoff is that
simple prompts get a cheaper turn than OpenCode's static default would give
them.

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `auto` | `false` | Off unless explicitly enabled. |
| `minConfidence` | `0.6` | Minimum jev answer confidence required to switch levels. |

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
| `keepThreshold` | `0.5` | Verdict probability at which call/result survive. |
| `preserveRecentMessages` | `6` | Newest messages pinned untouched. |
| `maxStateTokens` | `25000` | Judgment state budget before staged fitting gives up. |
| `maxRequestTokens` | `30000` | Per-request budget (state + questions); splits into batches. |
| `truncateHeadChars` | `300` | Head kept when a result is pruned. |
| `minReduction` | `0.25` | Required relative shrink before a hook-supplied summary replaces the built-in one. |
| `maxSummaryTokens` | half the model window | Cap on the hook-supplied summary (estimated tokens). |

## Skills

None needed. This plugin does not depend on and does not pair with any skill -
the tool descriptions, hooks, routing, and commands above carry the whole job.
On OpenCode with this plugin, do not load the `system-one` / `auto-system-one`
skills; nothing in them is consulted, and the plugin only enforces what
functions can be reached at all. The tool descriptions stay deliberately
compact for the same reason - each budgeted at ~300 tokens since they run on
every request; fuller guidance belongs in the README or in the skills that
other agents load, not in the request schema.

For other agents (no plugin): the standalone `jev` CLI is the path, and the
portable skills in [`atvari-eu/skills`](https://github.com/atvari-eu/skills)
can drive it from any agent. Install there, not on OpenCode with this plugin:

```console
$ skills add atvari-eu/skills@system-one -g
$ skills add atvari-eu/skills@auto-system-one -g
```

## Environment

Identical to the `jev` CLI (resolved fresh on every call; the key
is never logged or persisted):

- `TYPESAFE_API_KEY` → `OPENCODE_API_KEY` → opencode auth store
  (`~/.local/share/opencode/auth.json`, field `.opencode.key`)
- `JEV_ENDPOINT` (default: OpenCode Console System One endpoint)
- `JEV_MODEL` (default: `jev-1.13-free`)

A missing key or failed call never produces a "successful" judgment: screen
marks `unavailable`, tools throw, 401/403 reports the key↔endpoint pairing
rule. There is no provider degradation chain.

## Design rules preserved

- Secret scrubbing is **always deterministic regex** (`SECRET_PATTERNS` in
  `src/index.ts`) - never a Jev call - and applies to screening, tool inputs,
  prompts, and the compaction judgment state alike.
- Cached entries store **answers + usage only**, never the state text
  (compaction judgments included).
- No synthetic auto-"done" checks run behind the agent's back;
  `/jev-done-check` runs only when invoked - and the only notices the plugin
  posts on its own are screen verdicts for flagged fetches.
- Compaction never rewrites user/assistant text and never applies partial
  decisions; any failure falls back to the untouched built-in flow.

## License

[MIT](LICENSE) © [atvari GmbH](https://atvari.eu)
