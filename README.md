# OpenCode plugin for the System One decision layer

An [OpenCode](https://opencode.ai) plugin that wires System One (Jev)
judgments into OpenCode automatically: every `webfetch` result is checked for
junk and prompt injection before it enters context, known secret formats are
redacted from tool inputs and user prompts, the agent gets `jev_decide` /
`jev_judge_many` tools with caching, each turn's reasoning effort can be
picked by System One from the prompt *(opt-in)*, permission requests can be
vetted by System One *(opt-in)*, and context compaction can be decided by
System One instead of a lossy summary *(opt-in)*.

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
- **effort** (opt-in) - before each turn, jev picks the reasoning effort
  (thinking level) that prompt deserves - from the levels the selected model
  actually supports - and switches the model's variant, the same mechanism as
  the UI's effort picker. Fail-open: if jev is unavailable or uncertain, the
  current level stays. See [Auto reasoning effort](#auto-reasoning-effort).
- **approvals** (opt-in) - permission requests are judged by jev before they
  reach you: the verdict is added to the prompt ("likely safe 0.92",
  "uncertain - review", gate holds for destructive/sensitive patterns), and
  with `"auto"` enabled, high-confidence routine operations are approved
  outright. Configured deny rules always win; low confidence always falls
  back to the human prompt. See
  [jev-assisted approvals](#jev-assisted-approvals).
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

Everything is on by default except `effort`, `approvals`, and `compaction`
(all opt-in); turn parts off with the object form:

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
        "effort": { "auto": true }, // opt-in per-prompt thinking level; see "Auto reasoning effort"
        "approvals": { "auto": true }, // opt-in; see "jev-assisted approvals"
        "compaction": {      // opt-in; see "System One compaction"
          "enabled": true,
          "mode": "replace"  // or "clean"
        }
      },
    },
  ],
}
```

## Jev-first latency

OpenCode always runs the primary model on a user prompt - a plugin cannot
skip that turn. What the plugin provides instead:

- The `jev_decide` / `jev_judge_many` descriptions instruct the agent to
  make an explicit judgment request a **first action** - user items passed
  verbatim, no pre-analysis, no rewriting. Always on, bundled with the tool
  schema.
- The zero-model paths answer entirely outside the agent loop:
  `/jev-screen` runs the jev call with no model turn at all, and a
  dedicated agent in `opencode.json` with a tool-first prompt can be
  switched to for judgment-only turns.

## Auto reasoning effort

OpenCode models "thinking level" as the model's *reasoning variant*
(`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). With
`"effort": { "auto": true }`, the plugin asks jev once per prompt which level
that prompt deserves and applies it by switching the model's variant - the
same mechanism the UI's effort picker uses, programmatically, before the
turn's first request is resolved:

- jev answers a single `choice` question whose options are only the levels
  the selected model's catalog actually lists; for models without reasoning
  variants the feature disables itself.
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

**Manual picks win.** Your effort picks (and any other model changes) show
up in the transcript and are detected automatically. The plugin records its
own switches in durable plugin storage; when the newest switch is not one
of its own (you picked a level, or changed the model another way), auto stands
down for that session - no jev call, no switching - until the variant is
`Default` again, which re-enables it. Repeated prompts log the stand-down
notice once. A missing attribution record (cleared storage, fresh install)
errs toward the user and keeps auto off until the next `Default` pick. The
gate is a plain comparison, no model call.

Like every jev call, the judgment is cached per prompt - repeating the same
prompt costs nothing. The price is one extra jev round-trip per new prompt
(capped by the 8 s timeout); the payoff is that
simple prompts get a cheaper turn than OpenCode's static default would give
them.

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `auto` | `false` | Off unless explicitly enabled. |
| `minConfidence` | `0.6` | Minimum jev answer confidence required to switch levels. |

## jev-assisted approvals

Permission requests (tool executions that would otherwise interrupt you) can
be vetted by jev before they reach you. The feature is opt-in and has two
stacked modes:

- **Annotate** (enabled with `"approvals": true` or any object form): every
  `ask` verdict gets a one-line jev opinion added to the prompt you see -
  `[jev] likely safe (0.92)`, `[jev] uncertain (0.63) - review`,
  `[jev] likely risky (0.18) - review`. The decision stays entirely yours.
- **Auto** (`"approvals": { "auto": true }`): the same judgment, and when it
  clears the confidence bar (default `0.85`, `minConfidence`), the request is
  approved programmatically and logged to the console. Only the allowlisted
  `actions` (default `bash`, `edit`) are candidates; `webfetch`, MCP calls,
  and everything else still prompt you.

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
uninterpretable answer leaves the request exactly as OpenCode built it -
your prompt, unaltered verdict aside. Low confidence never silently
approves. Configured deny rules and every "always allow" memory you made in
the UI rule above the feature by construction.

One framing matters: auto-approval is an **explicit delegation you opt
into**, bounded by the deterministic gates above; it never auto-denies,
and every automatic approval is logged.

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `auto` | `false` | Enable programmatic approval on high confidence. |
| `minConfidence` | `0.85` | `auto` threshold, clamped to 0.5-0.99. |
| `actions` | `["bash", "edit"]` | Actions eligible for `auto`; others always prompt. Annotations judge every `ask` regardless. |

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
the tool descriptions, hooks, and commands above carry the whole job.
On OpenCode with this plugin, do not load the `system-one` / `auto-system-one`
skills; nothing in them is consulted. For other agents (no plugin): the
standalone `jev` CLI is the path, and the portable skills in
[`atvari-eu/skills`](https://github.com/atvari-eu/skills) can drive it from
any agent. Install there, not on OpenCode with this plugin:

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

- Secret scrubbing is **always deterministic regex** - never a Jev call -
  and applies to screening, tool inputs, prompts, and the compaction
  judgment state alike.
- Cached entries store **answers + usage only**, never the state text
  (compaction judgments included).
- No synthetic auto-"done" checks run behind the agent's back;
  `/jev-done-check` runs only when invoked - and the only notices the plugin
  posts on its own are screen verdicts for flagged fetches.
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
