# Auto model routing

Jev can pick how each turn runs: the reasoning effort and, optionally, the model. Model routing engages only while the session sits on the `Auto` picker entry (registered by default), so a manual model pick always wins. `effort.auto` (off by default) is independent of that gate: it routes the effort variant of whatever model is current, including a hand-picked one.

- `effort.auto` routes the reasoning variant of the current model (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` - the levels the UI's effort picker offers).
- `auto` routes the model itself from your candidates: `provider/model` strings or `{ providerID, id }` objects. Typically a cheap fast model alongside the expensive one.
- With both on, an auto-entry turn is one combined `(model, level)` question, not two competing decisions.
- Candidates are validated against your model catalog first; unusable ones are dropped, and routing stays off when none remain.
- Fail-safe: an unreachable endpoint, an 8 s timeout, or an uninterpretable answer keeps the turn on its base model; low confidence keeps the current pick. Between two plausible picks the cheaper one is preferred - a cheap turn can escalate later, wasted thinking cannot be taken back.
- Every real switch appends OpenCode's native `model-switched` status line, so routing stays visible and auditable.

## The `Auto` entry

`opencode-decisions/auto` is a pseudo-model registered in the picker. Selecting it is the only way routing engages; each prompt is routed to a real `(model, effort)` pair and the session returns to `auto` at idle (only plugin-made switches are reset - a manual pick stays put).

- `auto.name` sets the display name; `auto.aliases` adds search aliases (shown in the name, e.g. `Auto (Jev)`), because the picker search only matches model and provider names.
- `auto.fallback` names the real model used when an auto-entry turn cannot be routed. Without it, the session's last-used model is the fallback; a fresh session falls back to its first named candidate.
- Re-engaging is simply selecting `Auto` again. `"auto": { "enable": false }` removes the entry and disables all routing.
- The routing decision is cached per prompt: repeating a prompt costs nothing; each new prompt costs one jev round-trip (8 s cap).

## Candidate sources

Besides the static list, the pool can draw from what the session already knows:

- `"sources": { "favorites": true }` merges the models starred in OpenCode's model picker.
- `"sources": { "opencode": true }` merges OpenCode's models ranked by your own last-30-days usage: `true` or `{ "plan": "zen" | "go", "popular": true | count }` (plan defaults to `zen`, count to 10, range 1-40).

Sources are off unless enabled, additive to `candidates`, and fail open when the underlying file or database is unreadable. They are read once per server process, so new favorites or usage appear after a restart; per-prompt routing then costs no extra I/O.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `auto.enable` | `true` | Register the `opencode-decisions/auto` entry and enable per-turn routing. Auto engages only while the session sits on the entry; `false` drops the entry and all routing. |
| `auto.candidates` | `[]` | Models jev may route to (`provider/model` strings or `{ providerID, id }`). |
| `auto.sources.favorites` | `false` | Merge your TUI-favorite models into the routing pool. |
| `auto.sources.opencode` | `off` | Merge OpenCode's most-used models (30 d local usage): `true` or `{ "plan": "zen" \| "go", "popular": true \| count }`; plan defaults to `zen`, count to 10 (1-40). |
| `auto.minConfidence` | `0.45` | Minimum confidence required to switch model; clamped 0.25-0.99. Pair mode splits probability across many options, so a pick needs a lower bar than a simple verdict would. |
| `auto.fallback` | - | Real model (`provider/model`) switched to when an auto-entry turn cannot be routed; without it the session's last-used model is the fallback. |
| `auto.name` | `Auto` | Picker display name of the auto entry. |
| `auto.aliases` | `[]` | Extra search aliases, shown as a name suffix (`Auto (Jev)`). |
| `effort.auto` | `false` | Routes the plain per-variant thinking level of the current model; pairs with auto inside the loop. |
| `effort.minConfidence` | `0.45` | Minimum confidence required to switch the reasoning variant. |

The routing options live under `auto` because `model` is the judgment-model override (a string); one key must never carry a string and an object meaning.
