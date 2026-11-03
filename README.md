# OpenCode plugin for the System One decision layer

An [OpenCode](https://opencode.ai) plugin that wires System One (Jev) judgments into OpenCode automatically - no companion skill, no prompt plumbing.

Jev is a decision model: it answers typed questions about content with calibrated probabilities instead of generating text. The plugin points it at the judgment-shaped moments of an agent session:

| Feature | What it does | Default |
| --- | --- | --- |
| **Screening** | Tool results are checked for junk and prompt injection before they enter context; unsafe content is withheld (fail-closed). `webfetch` and `websearch` by default, every tool optional. | on |
| **Secret scrubbing** | Known secret formats (`sk-…`, `ghp_…`, PEM keys, JWTs, …) are redacted from tool inputs and prompts - deterministic regex, never a model call. | on |
| **Jev tools** | The agent gets `jev_decide`, `jev_judge_many`, and `jev_screen` for verification, ranking, bounded choices, and scoring, with a durable answer cache. | on |
| **Commands** | `/jev-screen`, `/jev-done-check`, `/jev-compact`, `/jev-approval-stats`, `/jev-models`, and the `/jev-audit` panel with every UI-only event. | on |
| **Model routing** | Before a turn, jev picks the model and reasoning effort it runs on - trivial prompts get the cheaper model. Engages only while the session sits on the `Auto` picker entry. | entry on, effort off |
| **Done-check** | At session idle, a completion probe notices if the agent stopped early - capped per user message and per session, silent when the turn is done. | off |
| **Semantic search** | `jev_find` answers "where is this *discussed*?" - a jev cascade over the codebase for questions grep cannot phrase. | on |
| **Approvals** | Permission requests are vetted (reversible? on-task? harmful?): routine work auto-runs, clearly harmful work is refused, you see only the uncertain middle. | off |
| **Compaction** | Context compaction keeps, truncates, or drops each tool call by jev verdict instead of summarizing - user and assistant text stays verbatim. | off |

Clean verdicts cost nothing: a passing screen, a delegated approval, or a likely-done probe writes nothing to the transcript and stays UI-only.

## Requirements

- [OpenCode 2](https://opencode.ai/v2/docs)
- Access to a System One deployment. With the default Console endpoint, credentials resolve per call: `TYPESAFE_API_KEY` / `OPENCODE_API_KEY`, then your `opencode auth login` session, then the legacy auth store. Other deployments resolve from your provider config at startup. Paid models bill the responsible deployment's account (402 on empty funds, never retried elsewhere).
- No specific model provider is required; the plugin only adds tools and guards around your existing setup.

The deployment is ping-verified at plugin start, and faults fail every judged feature closed. Details: [Provider & credentials](docs/provider.md).

## Install

Add the plugin to `plugins` in `opencode.json(c)` - global (`~/.config/opencode/opencode.jsonc`) or per project (`opencode.json(c)` / `.opencode/opencode.json(c)`).

### From GitHub (recommended)

```console
$ opencode plugin add github:atvari-eu/opencode-system-one
```

Installs it globally under CLI management (`opencode plugin list` to inspect, `opencode plugin update` to pull new commits). Pin a fixed revision by appending a full commit hash (`#<hash>`). Restart a running OpenCode afterwards (`opencode service restart`) so the shared service picks it up.

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

Point `package` at the checkout root (the directory containing `package.json`); OpenCode loads the entrypoint from its `exports`.

### Nix / home-manager

Pin the repository and copy the entrypoint to a stable path:

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

## Configuration

Screening, scrubbing, the judgment tools (including `jev_find`), and the commands run out of the box. Everything below is optional; turn a part off with the object form (`"screen": { "enabled": false }`).

```jsonc
// opencode.json(c)
{
  "plugins": [
    {
      "package": "github:atvari-eu/opencode-system-one",
      "options": {
        "model": "jev-1.13",           // judgment model (default: jev-1.13-free, or JEV_MODEL)
        "auto": {                      // model routing
          "candidates": ["openrouter/anthropic/claude-3.5-haiku", "anthropic/claude-sonnet-4"],
          "fallback": "openrouter/anthropic/claude-3.5-haiku",
          "minConfidence": 0.6
        },
        "effort": { "auto": true },    // per-prompt thinking level
        "doneCheck": { "auto": true }, // idle completion probe
        "find": { "enabled": true },   // semantic code search (on by default; false removes it)
        "approvals": true,             // vetted permission requests
        "compaction": { "enabled": true, "mode": "replace" }
      },
    },
  ],
}
```

| Option | Default | Docs |
| --- | --- | --- |
| `screen` | on | [Screening](docs/screening.md) |
| `scrub` | on | [Screening](docs/screening.md) |
| `tools` | on | [Tools & commands](docs/tools.md) |
| `commands` | on | [Tools & commands](docs/tools.md) |
| `cache` | on | [Tools & commands](docs/tools.md) |
| `model` | `JEV_MODEL` env / `jev-1.13-free` | [Provider](docs/provider.md) |
| `provider` | `"opencode"` (Console) | [Provider](docs/provider.md) |
| `auto` | entry registered; routes only on the `Auto` entry | [Model routing](docs/routing.md) |
| `effort` | off | [Model routing](docs/routing.md) |
| `doneCheck` | off | [Done-check](docs/done-check.md) |
| `find` | on | [jev_find](docs/find.md) |
| `approvals` | off | [Approvals](docs/approvals.md) |
| `compaction` | off | [Compaction](docs/compaction.md) |
| `toasts` | `error` floor for every event | [Event toasts](docs/tools.md#event-toasts-toasts) |

## Guarantees

- **Fail-closed**: a missing credential, judge failure, timeout, or malformed answer never produces a "successful" judgment. Faults surface as toasts, never as a silently guessed endpoint or a fallback between deployments.
- Secret scrubbing is deterministic regex, applied to screening, tool inputs, prompts, and compaction state alike.
- The cache stores answers and usage only - never the judged content.
- User prompt text is never edited for instructions (scrub aside); guidance lives in the tool descriptions.
- Compaction never rewrites user/assistant text and never applies partial decisions.
- Approvals never override configured deny rules; automatic decisions are an explicit delegation, bounded by deterministic gates.

## Documentation

| Page | Covers |
| --- | --- |
| [Screening & scrubbing](docs/screening.md) | screen modes, thresholds, secret formats |
| [Jev tools & commands](docs/tools.md) | the three tools, the answer cache, commands, `/jev-audit` |
| [Model routing](docs/routing.md) | the `Auto` entry, effort routing, candidate sources |
| [Done-check](docs/done-check.md) | the idle completion probe |
| [jev_find](docs/find.md) | semantic code search |
| [Approvals](docs/approvals.md) | vetted permissions, gates, the host/plugin permission split |
| [Compaction](docs/compaction.md) | jev compaction, modes, idle triggers |
| [Provider & credentials](docs/provider.md) | deployments, credential chains, error surfacing |

For other agents (no plugin), the standalone `jev` CLI plus the portable skills in [`atvari-eu/skills`](https://github.com/atvari-eu/skills) are the path - see [docs/tools.md#skills](docs/tools.md#skills).

Architecture and decision history for contributors live in [DESIGN.md](DESIGN.md).

## License

[MIT](LICENSE) © [atvari GmbH](https://atvari.eu)
