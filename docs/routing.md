# Auto model routing

Jev can pick how each turn runs: the reasoning effort and, optionally, the model. Model routing engages only while the session sits on one of the plugin's picker entries: `Auto` or `Auto Review` (both registered by default), so a manual model pick always wins. `effort.auto` (off by default) is independent of that gate: it routes the effort variant of whatever model is current, including a hand-picked one.

- `effort.auto` routes the reasoning variant of the current model (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` - the levels the UI's effort picker offers).
- `auto` is a record of routing meta models. `auto.default` ("Auto") and `auto.review` ("Auto Review") are built in and on by default; any other key registers an extra entry (`auto.triage`), which appears in the picker as `opencode-decisions/triage`. Each entry routes the model itself from its `candidates`: `provider/model` strings or `{ providerID, id }` objects. Typically a cheap fast model alongside the expensive one.
- An entry with `kind: "review"` (the built-in `auto.review`) routes from its own pool with review-oriented criteria, and can never offer a model that the `auto.default` pool holds.
- Left unconfigured, an entry routes from a **default pool**: the OpenCode Console models your session currently lists (`opencode`/`opencode-go`, enabled, chat, tool-capable), ranked by the public usage statistics behind [opencode.ai/data](https://opencode.ai/data). Both default pools skip models the Console gates behind a data-training opt-in: free tiers (`-free` ids or a $0 price) and `-contributor` models (`muse-spark-*-contributor`, `iceman-contributor-free`). Those answer with a data-policy error unless the matching Privacy switch is on, so list them under `candidates` to route to them with consent enabled. The review kind takes the most-used model plus the two strongest of the top 18 by benchmark score. The default kind is a union of three signals over the remainder: the lowest real cost, the highest public usage, and the next strongest. Cost ranks by observed per-session cost, then by cache-adjusted token cost (measured token prices where reported, else list and cache-read prices weighted by the measured cache ratio); strength reads the benchmark results on each model's opencode.ai/data page (one small fetch per window model, cached for a day), keeps every 0-100 pass rate, scores a model's best run per benchmark and version relative to the best model in that group, and averages the groups it reports, pulling models with thin coverage toward the neutral midpoint. A model reporting nothing sits at that midpoint; when no group has three models, strength falls back to the measured output price, then the list price. The default kind's picks are restricted to models with a large context window (at least 500k tokens); the filter falls back to the full remainder when it would leave the pool empty. The two splits are always disjoint. Nothing is baked in; with no Console chat provider the pool is empty and routing stays off. Leaderboard ids are matched structurally (free-tier alias, dated build suffix, `canonical_id` when the registry exposes it), never by a hard-coded model list, so an id the catalog cannot agree on is simply skipped.
- With both on, an entry turn is one combined `(model, level)` question, not two competing decisions.
- The routing question carries a `<candidate-models>` block: per offered model, context window, output limit, list token prices, measured cache-hit share, public usage rank, relative benchmark strength (only when the model reports usable benchmarks), release month, and tool/image-input flags. The values come from the live model catalog and the opencode.ai/data snapshots the pools already use, with missing values omitted rather than guessed; no extra request is made for them.
- Candidates are validated against your model catalog first; unusable ones are dropped, and routing stays off when none remain.
- Fail-safe: an unreachable endpoint, an 8 s timeout, or an uninterpretable answer keeps the turn on its base model; low confidence keeps the current pick. Between two plausible picks the cheaper one is preferred - a cheap turn can escalate later, wasted thinking cannot be taken back.
- Every real switch appends OpenCode's native `model-switched` status line, so routing stays visible and auditable.

## Routing entries (meta models)

`auto` is a record of pseudo-model entries. Two are built in:

| Key | Picker id | Default name | Kind |
| --- | --- | --- | --- |
| `default` | `opencode-decisions/auto` | `Auto` | `default` |
| `review` | `opencode-decisions/auto-review` | `Auto Review` | `review` |

Both are enabled by default. Any other key registers an extra entry: `"auto": { "triage": { "candidates": [...] } }` appears as `opencode-decisions/triage`. Selecting an entry is the only way routing engages; each prompt is routed to a real `(model, effort)` pair and the session returns to its entry at idle (only plugin-made switches are reset - a manual pick stays put).

Every entry accepts the same fields: `enable`, `kind` (`default` or `review`), `name`, `aliases`, `candidates`, `sources`, `fallback`, and `minConfidence`. The default-pool cuts come from the top-level `pool` option: top 18 by default, with `1 cheap + 1 popular + 1 strong` for `default`-kind entries and `1 popular + 2 strong` for `review`-kind ones; tune `pool.topK`, the per-split counts, or `pool.auto.minContext` there.

- With no `candidates` and no enabled sources, the pool is the live Console catalog ranked by the public usage leaderboard. A `default`-kind entry takes the cheapest, the most-used and the strongest of the top 18, restricted to large models (>= 500k context) and with free and training-consent models removed. A `review`-kind entry takes the most-used model plus the two strongest of the same window, without the size filter. Set `candidates` (or a source) to pin the pool instead.
- `auto.<id>.name` sets the display name; `auto.<id>.aliases` adds search aliases (shown in the name, e.g. `Auto (Jev)`), because the picker search only matches model and provider names. A custom entry defaults its name to its key.
- `auto.<id>.fallback` names the real model used when a turn on that entry cannot be routed. Without it, the session's last-used model is the fallback; a fresh session falls back to its first named candidate.
- `"auto": { "<id>": false }` or `"enable": false` drops an entry. `"auto": false` disables every entry. The entry stays listed in `/jev-status` as `off`.
- The routing decision is cached per prompt: repeating a prompt costs nothing; each new prompt costs one jev round-trip (8 s cap).

### The `review` entry

`opencode-decisions/auto-review` is the built-in review entry. It uses the same routing engine but a review-oriented question: correctness, thoroughness, and finding subtle defects outrank cost, and non-trivial reviews are steered toward higher reasoning effort.

Its pool is **always disjoint from the `default` entry's pool**, whatever the configuration says. After explicit candidates and sources are merged, every model `auto.default` can route to - including its `fallback` - is removed from the review pool. If that leaves nothing, the review entry cannot route and follows its own fallback/emergency chain. A configured review fallback that belongs to the default pool is ignored for the same reason. Custom entries with `kind: "review"` follow the same rule; extra `default`-kind entries do not subtract each other, so pin their `candidates` when they must not overlap.

- With no `candidates` and no enabled sources, the review entry derives its own default pool: the most-used model plus the two strongest (by benchmark score, falling back to output price) of the same Console top-18 window, without the size filter and with free and training-consent models removed; the default entry then picks from what review left.
- `auto.review.enable` defaults to `true`; set it to `false` (or `{ "enable": false }`) to drop the entry.
- Selecting `Auto Review` engages review routing; the idle reset returns the session to `auto-review` (the route pin records which entry it came from, so entries never restore into each other).
- A review turn with no unique candidates left falls back exactly like the default entry: configured fallback, then the session's last-used real model, then the first pool entry.

The legacy `autoReview` key is still accepted as an alias for `auto.review` with a one-line deprecation notice; `auto.review` wins when both are set.

## Candidate sources

Besides the static list, the pool can draw from what the session already knows:

- `"sources": { "favorites": true }` merges the models starred in OpenCode's model picker.
- `"sources": { "opencode": true }` merges the OpenCode Console models ranked by the **public usage leaderboard** behind [opencode.ai/data](https://opencode.ai/data), matched by model id against your catalog: `true` or `{ "plan": "zen" | "go", "popular": true | count }` (plan defaults to `zen`, count to 10, range 1-40).
- `"sources": { "opencode": { "local": true } }` additionally (or instead) ranks by **your own last-30-days usage** from the local session database: `true` or a count.

Sources are off unless enabled, additive to `candidates`, and fail open when the underlying file, database, or leaderboard fetch is unreadable. The leaderboard is fetched once per process and snapshotted; local usage is read once per process. Each entry can enable its own `sources`; the process reads the underlying snapshots once and derives each entry's pool from it. New favorites, usage, or leaderboard positions appear after a restart; per-prompt routing then costs no extra I/O. `/jev-status` shows the resolved pool for every entry.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `auto` | `{ "default": {}, "review": {} }` | Record of routing meta models. `false` disables every entry. Built-in keys `default` and `review` keep the picker ids `opencode-decisions/auto` and `opencode-decisions/auto-review`; any other key registers `opencode-decisions/<key>` after them. |
| `auto.<id>.enable` | `true` | Register this entry and enable its routing. Equivalent to `"auto": { "<id>": false }`. |
| `auto.<id>.kind` | `default`, or `review` for the `review` key | Criteria and default-pool split: `default` or `review`. |
| `auto.<id>.name` | `Auto` / `Auto Review` / the key | Picker display name. |
| `auto.<id>.aliases` | `[]` | Extra search aliases, shown as a name suffix (`Auto (Jev)`). |
| `auto.<id>.candidates` | `[]` | Models jev may route to (`provider/model` strings or `{ providerID, id }`). Empty with no source = Console default pool. |
| `auto.<id>.sources.favorites` | `false` | Merge your TUI-favorite models into this entry's pool. |
| `auto.<id>.sources.opencode` | `off` | Merge OpenCode Console models ranked by the public usage leaderboard: `true` or `{ "plan": "zen" \| "go", "popular": true \| count }`; plan defaults to `zen`, count to 10 (1-40). Add `"local": true \| count` for the local 30-day usage ranking. |
| `auto.<id>.minConfidence` | `0.45` | Minimum confidence required to switch model; clamped 0.25-0.99. Pair mode splits probability across many options, so a pick needs a lower bar than a simple verdict would. |
| `auto.<id>.fallback` | - | Real model (`provider/model`) switched to when a turn on this entry cannot be routed; without it the session's last-used model is the fallback. |
| `autoReview` | deprecated | Alias for `auto.review`. Ignored (with a notice) when `auto.review` is present. |
| `pool` | `true` | Owns the Console default pool. `false` or `{ "enable": false }` disables it; entries with no `candidates` and no sources then have nothing to route to (their fallback chain still applies). |
| `pool.topK` | `18` | Leaderboard-ranked window considered before the slot picks, clamped 1-40. |
| `pool.auto.cheap` | `1` | Lowest-real-cost picks for `default`-kind entries; `0` disables the cost axis. |
| `pool.auto.popular` | `1` | Highest-public-usage picks left after the cost picks. |
| `pool.auto.strong` | `1` | Strongest picks left after cost and usage. |
| `pool.auto.minContext` | `500000` | Context floor for `default`-kind picks; `0` disables it. |
| `pool.review.cheap` | `0` | Cost picks for `review`-kind entries (off by default: review needs capable models). |
| `pool.review.popular` | `1` | Highest-public-usage picks for `review`-kind entries. |
| `pool.review.strong` | `2` | Strongest picks for `review`-kind entries. |
| `effort.auto` | `false` | Routes the plain per-variant thinking level of the current model; pairs with auto inside the loop. |
| `effort.minConfidence` | `0.45` | Minimum confidence required to switch the reasoning variant. |

The routing options live under `auto` because `model` is the judgment-model override (a string); one key must never carry a string and an object meaning. A flat legacy `auto` object (the old per-entry fields directly under `auto`) is still read as `auto.default` with a notice.
