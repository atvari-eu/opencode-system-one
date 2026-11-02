# Screening & secret scrubbing

Two guards run automatically, on by default: screening judges tool results before they enter context; scrubbing redacts known secret formats from tool inputs and prompts. The agent-facing on-demand screen (`jev_screen`, `/jev-screen`) is covered in [Jev tools](tools.md).

## `screen`

Tool results are judged for junk and prompt injection before they enter context: `webfetch` and `websearch` by default (the tools that ingest untrusted external content), every tool with `"screen": { "tools": "all" }`, or an explicit list such as `["webfetch", "read", "mcp/*"]`.

An unsafe verdict withholds the content (default `mode: "redact"`) for every screened tool - the result is replaced by a note naming why and how to override. `"mode": "annotate"` keeps all content instead.

A passing verdict writes nothing to the transcript - no row, no prefix - so screening every tool costs no context on clean content. Verdicts are UI-only, visible in `/jev-audit`. Anomalies land according to `"annotation"`: `"notice"` (default) posts a standalone `[jev-screen]` row; `"inline"` prefixes the result so the model sees the verdict where it reads it (`⚠ do-not-rely` over threshold).

Screened content is secret-scrubbed, sampled to 12 kB, and cached - the same content costs nothing on repeat. The plugin never screens its own judgment tools.

An extra check flags residual credential material, tuned by `secretThreshold`: at or above it the verdict rises to flagged. It is advisory only - it never withholds content or downgrades a higher verdict.

## `scrub`

Deterministic redaction (regex, never a model call) of known secret formats in tool inputs and user prompts: PEM private keys, `sk-…` API keys, GitHub (`ghp_`, `github_pat_`) and GitLab (`glpat-`) tokens, AWS `AKIA…`, Slack `xox…`, age keys, `npm_…`, bearer tokens, JWTs. Replaced with `[REDACTED:<label>]`.

Only the hit count and location (prompt or tool name) are surfaced; the matched text is never logged or written to the transcript.

## Jev-first latency

OpenCode always runs the primary model on a prompt - a plugin cannot skip that turn. When latency matters more than flexibility, prefer the zero-model paths: `/jev-screen` answers with no model turn at all, and a dedicated agent with a tool-first prompt in `opencode.json` can host judgment-only turns.
