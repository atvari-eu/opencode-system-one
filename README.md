# OpenCode plugin for the System One decision layer

An [OpenCode](https://opencode.ai) plugin that wires System One (Jev)
judgments into OpenCode automatically: every `webfetch` result is checked for
junk and prompt injection before it enters context, known secret formats are
redacted from tool inputs and user prompts, and the agent gets `jev_decide` /
`jev_judge_many` tools with caching.

## What it does

- **screen** - every `webfetch` result is judged (junk? prompt injection?)
  before it enters context. Mode `annotate` (default) prefixes the result with
  `jev-screen: junk=… injection=…` (plus `⚠ do-not-rely` over threshold); mode
  `redact` replaces unsafe content fail-closed. Screening state is
  regex-scrubbed, sampled to 12 kB, and cached per (url, content hash).
- **scrub** - deterministic redaction (pure regex, never a model call) of
  known secret formats in **tool inputs** and **user prompts**: PEM private
  keys, `sk-…` API keys, GitHub tokens (`ghp_`/`github_pat_`), AWS `AKIA…`,
  Slack `xox…`, GitLab `glpat-…`, age keys, `npm_…`, bearer tokens, JWTs.
  Replaced with `[REDACTED:<label>]`.
- **tools** - `jev_decide`: one request = one state + typed questions
  (noul/choice/score); `jev_judge_many`: one judgment per item, launched in
  parallel, aggregated in code (weighted mean + low-confidence flags). No
  multi-state batch endpoint is ever simulated.
- **cache** - replies for identical (endpoint, model, state, questions) are
  served from durable plugin storage; only answers are persisted, never the
  state text.
- **commands** - `/jev-screen <url>` gives a one-shot junk/injection verdict
  for any URL; `/jev-done-check` runs a completion self-check over the recent
  session transcript. Both answer without loading a skill.

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

Everything is on by default; turn parts off with the object form:

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
        "cache": true
      },
    },
  ],
}
```

## Companion skills

This plugin implements the same System One contract as two skills from
[atvari-eu/skills](https://github.com/atvari-eu/skills), a collection of agent
skills published to the open [skills](https://skills.sh/) ecosystem. The
division of labor: the skills carry portable *advice* (usable with any agent
and the `jev` CLI), while the plugin is OpenCode's native mechanism and
*enforces* the parts that can be mechanical - hooks like screening, scrubbing,
and fail-closed routing are things advice alone cannot guarantee.

| Skill | Adds |
| --- | --- |
| [`auto-system-one`](https://github.com/atvari-eu/skills/blob/main/skills/auto-system-one/SKILL.md) | The judgment-moment guidance: *when* to call for a decision, *how* to phrase questions. Useful everywhere, including OpenCode with this plugin. |
| [`system-one`](https://github.com/atvari-eu/skills/blob/main/skills/system-one/SKILL.md) | The portable mechanics: HTTP shapes, `jev` CLI, thresholds. Redundant on OpenCode with this plugin; load it everywhere else. |

Install with the `skills` CLI:

```console
$ skills add atvari-eu/skills@system-one -g
$ skills add atvari-eu/skills@auto-system-one -g
```

### Recommended pairing

- **OpenCode always running with this plugin:** keep `auto-system-one`, skip
  `system-one`. The plugin already enforces the mechanics - transport and auth
  chain, one call = one state, per-item batching with aggregation, durable
  cache, fail-closed routing, and the screening.
- **Anywhere else** (other agents, the `jev` CLI, plugin-less OpenCode): load
  `system-one` first and `auto-system-one` second, as the portable pair - the
  documented contract is exactly what this plugin implements on OpenCode.

## Environment

Identical to the `jev` CLI and skills (resolved fresh on every call; the key
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
  `src/index.ts`) - never a Jev call.
- Cached entries store **answers + usage only**, never the state text.
- No synthetic auto-"done" checks run behind the agent's back;
  `/jev-done-check` runs only when invoked.

## License

[MIT](LICENSE) © [atvari GmbH](https://atvari.eu)
