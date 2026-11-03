# OpenCode plugin for decision models

An [OpenCode](https://opencode.ai) plugin that wires decision-model judgments - System One, with Jev as the default model - into OpenCode automatically, with no companion skill and no prompt plumbing.

A **decision model** answers typed questions about content with calibrated probabilities instead of generating text. **System One** is the decision-model family this plugin speaks today, and **Jev** (`jev-1.13`, `jev-1.13-free`) is its default model - point it at any System One model per deployment (`model` option, `JEV_MODEL`) or per session (`/jev-models`). Tool and command names keep their historical `jev_` / `jev-` prefixes whatever model judges. The plugin puts those judgments at the judgment-shaped moments of an agent session:

| Feature | What it does | Default |
| --- | --- | --- |
| **Screening** | Tool results are checked for junk and prompt injection before they enter context; unsafe content is withheld (fail-closed). `webfetch` and `websearch` by default, every tool optional. | on |
| **Secret scrubbing** | Known secret formats (`sk-…`, `ghp_…`, PEM keys, JWTs, …) are redacted from tool inputs and prompts - deterministic regex, never a model call. | on |
| **Judgment tools** | The agent gets `jev_decide`, `jev_judge_many`, and `jev_screen` for verification, ranking, bounded choices, and scoring, with a durable answer cache. | on |
| **Commands** | `/jev-screen`, `/jev-done-check`, `/jev-compact`, `/jev-approval-stats`, `/jev-models`, the `/jev-audit` panel with every UI-only event, and the `/jev-status` panel. | on |
| **Model routing** | Before a turn, the decision model picks the model and reasoning effort it runs on - trivial prompts get the cheaper model. Engages only while the session sits on the `Auto` or `Auto Review` picker entry; both default to a pool drawn from the Console catalog and ranked by the public usage statistics behind [opencode.ai/data](https://opencode.ai/data). | Auto and Review on; effort off |
| **Done-check** | At session idle, a completion probe notices if the agent stopped early - capped per user message and per session, silent when the turn is done. | off |
| **Semantic search** | `jev_find` answers "where is this *discussed*?" - a decision-model cascade over the codebase for questions grep cannot phrase. | on |
| **Approvals** | Permission requests are vetted (reversible? on-task? harmful?): routine work auto-runs, clearly harmful work is refused, you see only the uncertain middle. | off |
| **Compaction** | Context compaction keeps, truncates, or drops each tool call by decision-model verdict instead of summarizing - user and assistant text stays verbatim. | off |

Clean verdicts cost nothing: a passing screen, a delegated approval, or a likely-done probe writes nothing to the transcript and stays UI-only.

## Requirements

- [OpenCode 2](https://opencode.ai/v2/docs)
- Access to a decision-model deployment; the plugin speaks the System One interface. With the default Console endpoint, credentials resolve per call: `TYPESAFE_API_KEY` / `OPENCODE_API_KEY`, then your `opencode auth login` session, then the legacy auth store. Other deployments resolve from your provider config at startup. Paid models bill the responsible deployment's account (402 on empty funds, never retried elsewhere).
- No specific model provider is required; the plugin only adds tools and guards around your existing setup.

The deployment is ping-verified at plugin start, and faults fail every judged feature closed. Details: [Provider & credentials](docs/provider.md).

## Install

Add the plugin to `plugins` in `opencode.json(c)` - global (`~/.config/opencode/opencode.jsonc`) or per project (`opencode.json(c)` / `.opencode/opencode.json(c)`).

### From GitHub (recommended)

```console
$ opencode plugin add github:atvari-eu/opencode-decisions
```

Installs it globally under CLI management (`opencode plugin list` to inspect, `opencode plugin update` to pull new commits). Pin a fixed revision by appending a full commit hash (`#<hash>`). Restart a running OpenCode afterwards (`opencode service restart`) so the shared service picks it up.

### Local checkout (also for development)

```jsonc
// opencode.json(c)
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "/absolute/path/to/opencode-decisions" }
  ],
}
```

Point `package` at the checkout root (the directory containing `package.json`); OpenCode loads the entrypoint from its `exports`.

### Nix / home-manager

Pin the repository and copy the entrypoint to a stable path:

```nix
# in your home-manager configuration (e.g. home.nix)
opencode-decisions = pkgs.fetchFromGitHub {
  owner = "atvari-eu";
  repo = "opencode-decisions";
  rev = "<pin>";
  hash = "<pin-hash>";
};

home.file.".config/opencode/opencode-decisions/index.ts".source =
  "${opencode-decisions}/src/index.ts";
```

```jsonc
// opencode.json(c)
{
  "plugins": [
    { "package": "~/.config/opencode/opencode-decisions" }
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
      "package": "github:atvari-eu/opencode-decisions",
      "options": {
        "model": "jev-1.13",           // judgment model (default: jev-1.13-free, or JEV_MODEL)
        "routes": {                    // routing meta models (default + review are built in)
          "default": {
            "candidates": ["openrouter/anthropic/claude-3.5-haiku", "anthropic/claude-sonnet-4"],
            "fallback": "openrouter/anthropic/claude-3.5-haiku",
            "minConfidence": 0.6
          },
          "review": {                  // on by default; this pins its pool
            "candidates": ["anthropic/claude-opus-4"],
            "fallback": "anthropic/claude-opus-4"
          }
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
| `routes` | `{ "default": {}, "review": {} }`; extra keys become picker entries; each entry's Console cut inlines under `pool` | [Model routing](docs/routing.md) |
| `auto` | deprecated alias for `routes` | [Model routing](docs/routing.md) |
| `effort` | off | [Model routing](docs/routing.md) |
| `doneCheck` | off | [Done-check](docs/done-check.md) |
| `find` | on | [Semantic search](docs/find.md) |
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
- `Auto Review` never routes to a model in `Auto`'s pool: overlapping candidates, pool picks, and fallbacks are filtered before the review question is built.

## Documentation

| Page | Covers |
| --- | --- |
| [Screening & scrubbing](docs/screening.md) | screen modes, thresholds, secret formats |
| [Judgment tools & commands](docs/tools.md) | the three tools, the answer cache, commands, `/jev-audit`, `/jev-status` |
| [Model routing](docs/routing.md) | the `Auto` entry, effort routing, candidate sources |
| [Done-check](docs/done-check.md) | the idle completion probe |
| [Semantic search](docs/find.md) | semantic code search |
| [Approvals](docs/approvals.md) | vetted permissions, gates, the host/plugin permission split |
| [Compaction](docs/compaction.md) | decision-model compaction, modes, idle triggers |
| [Provider & credentials](docs/provider.md) | deployments, credential chains, error surfacing |

For other agents (no plugin), the standalone `jev` CLI plus the portable skills in [`atvari-eu/skills`](https://github.com/atvari-eu/skills) are the path - see [docs/tools.md#skills](docs/tools.md#skills).

Architecture and decision history for contributors live in [DESIGN.md](DESIGN.md).

## License

[MIT](LICENSE) © [atvari GmbH](https://atvari.eu)
