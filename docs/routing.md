# Auto model routing

Jev can pick how each turn runs: the reasoning effort and, optionally, the model. Model routing engages only while the session sits on one of the plugin's picker entries: `Auto` or `Auto Review` (both registered by default), so a manual model pick always wins. On those entries effort routing is on by default (`effort.mode: "pair"`): the turn is routed to a `(model, level)` pair. For a hand-picked model it is opt-in via `effort.mode: "always"`, which then routes only that model's effort variant.

- Reasoning levels are the model's effort variants (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`). The host's thinking-off toggle id `none` is never routed: OpenCode replays a switch away from it as an invalid `output_config.effort` on the next request. Entry turns route the remaining levels by default (`"pair"`); `effort.mode: "always"` extends that to a hand-picked model, and `"off"` keeps entry turns model-only.
- `routes` is a record of routing meta models. `routes.default` ("Auto") and `routes.review` ("Auto Review") are built in and on by default; any other key registers an extra entry (`routes.triage`), which appears in the picker as `opencode-decisions/triage`. Each entry routes the model itself from its `candidates`: `provider/model` strings or `{ providerID, id }` objects. Typically a cheap fast model alongside the expensive one.
- An entry with `kind: "review"` (the built-in `routes.review`) routes from its own pool with review-oriented criteria, and can never offer a model that the `routes.default` pool holds.
- `agents` is a record of **agent profiles**. `agents.build`, `agents.plan`, and `agents.explore` are built in; any other key registers a profile for that agent or subagent id. The session's active agent refines the routing question for its turn: a profile can replace the stance text, raise the Console pool's context floor, and keep the offered effort levels inside a band ([Agent profiles](#agent-profiles)). Routing still happens only through an entry; an agent with no profile changes nothing.
- Left unconfigured, an entry routes from a **default pool**: the OpenCode Console models your session currently lists (`opencode`/`opencode-go`, enabled, chat, tool-capable), ranked by the public usage statistics behind [opencode.ai/data](https://opencode.ai/data). Both default pools skip models the Console gates behind a data-training opt-in: free tiers (`-free` ids or a $0 price) and `-contributor` models (`muse-spark-*-contributor`, `iceman-contributor-free`). Those answer with a data-policy error unless the matching Privacy switch is on, so list them under `candidates` to route to them with consent enabled. The review kind takes the most-used model plus the two strongest of the top 18 by benchmark score. The default kind is a union of three signals over the remainder: the lowest real cost, the highest public usage, and the next strongest. Cost ranks by observed per-session cost, then by cache-adjusted token cost (measured token prices where reported, else list and cache-read prices weighted by the measured cache ratio); strength reads the benchmark results on each model's opencode.ai/data page (one small fetch per window model, cached for a day), keeps every 0-100 pass rate, scores a model's best run per benchmark and version relative to the best model in that group, and averages the groups it reports, pulling models with thin coverage toward the neutral midpoint. A model reporting nothing sits at that midpoint; when no group has three models, strength falls back to the measured output price, then the list price. The default kind's picks are restricted to models with a large context window (at least 500k tokens); the filter falls back to the full remainder when it would leave the pool empty. The two built-in splits are always disjoint; a cut inlined on another entry is independent (see below). Nothing is baked in; with no Console chat provider the pool is empty and routing stays off. The pool never ranks another provider's models: name those under `candidates` or `favorites`. Leaderboard ids are matched structurally (free-tier alias, dated build suffix, `canonical_id` when the registry exposes it), never by a hard-coded model list, so an id the catalog cannot agree on is simply skipped.
- With both on, an entry turn is one combined `(model, level)` question, not two competing decisions.
- The routing question carries a `<candidate-models>` block: per offered model, context window, output limit, list token prices, the OpenCode Go monthly allowance for `opencode-go` entries when known (with its multiple of list price under the configured `goPlan`), measured cache-hit share, public usage rank, relative benchmark strength (only when the model reports usable benchmarks), release month, and tool/image-input flags. The values come from the live model catalog and the opencode.ai/data snapshots the pools already use, with missing values omitted rather than guessed; no extra request is made for them.
- Candidates are validated against your model catalog first; unusable ones are dropped, and routing stays off when none remain.
- Fail-safe: an unreachable endpoint, an 8 s timeout, or an uninterpretable answer keeps the turn on its base model; low confidence keeps the current pick. Between two plausible picks the cheaper one is preferred - a cheap turn can escalate later, wasted thinking cannot be taken back.
- Every real switch appends OpenCode's native `model-switched` status line, so routing stays visible and auditable.

## Routing entries (meta models)

`routes` is a record of pseudo-model entries. Two are built in:

| Key | Picker id | Default name | Kind |
| --- | --- | --- | --- |
| `default` | `opencode-decisions/auto` | `Auto` | `default` |
| `review` | `opencode-decisions/auto-review` | `Auto Review` | `review` |

Both are enabled by default. Any other key registers an extra entry: `"routes": { "triage": { "candidates": [...] } }` appears as `opencode-decisions/triage`. Selecting an entry is the only way routing engages; each prompt is routed to a real `(model, effort)` pair and the session returns to its entry at idle (only plugin-made switches are reset - a manual pick stays put).

Every entry accepts the same fields: `kind` (`default` or `review`), `name`, `aliases`, `candidates`, `favorites`, `pool`, `fallback`, and `minConfidence`. An entry is on unless its key is set to `false`. The built-in cuts live on the built-in entries: `routes.default.pool` (`1 cheap + 1 popular + 1 strong`) and `routes.review.pool` (`1 popular + 2 strong`). Every entry's `pool` accepts the same shape, so a custom entry inlines its own cut ([Pool cuts](#pool-cuts)).

- With no `candidates` and no enabled source (or with `pool: true`), the pool is the live Console catalog ranked by the public usage leaderboard. A `default`-kind entry takes the cheapest, the most-used and the strongest of its window, restricted to large models (>= 500k context) and with free and training-consent models removed. A `review`-kind entry takes the most-used model plus the two strongest of its window, without a size floor by default. Set `candidates` (or a source) to pin the pool instead; `pool: false` turns it off for that entry, and `pool: { ... }` inlines that entry's own cut for any kind.
- `routes.<id>.name` sets the display name; `routes.<id>.aliases` adds search aliases (shown in the name, e.g. `Auto (Jev)`), because the picker search only matches model and provider names. A custom entry defaults its name to its key.
- `routes.<id>.fallback` names the real model used when a turn on that entry cannot be routed. Without it, the session's last-used model is the fallback; a fresh session falls back to its first named candidate.
- `"routes": { "<id>": false }` drops an entry. `"routes": false` disables every entry. The entry stays listed in `/jev-status` as `off`.
- The routing decision is cached per prompt: repeating a prompt costs nothing; each new prompt costs one jev round-trip (8 s cap).

### The `review` entry

`opencode-decisions/auto-review` is the built-in review entry. It uses the same routing engine but a review-oriented question: correctness, thoroughness, and finding subtle defects outrank cost, and non-trivial reviews are steered toward higher reasoning effort.

Its pool is **always disjoint from the `default` entry's pool**, whatever the configuration says. After explicit candidates, pool picks, and favorites are merged, every model `routes.default` can route to - including its `fallback` - is removed from the review pool. If that leaves nothing, the review entry cannot route and follows its own fallback/emergency chain. A configured review fallback that belongs to the default pool is ignored for the same reason. Custom entries with `kind: "review"` follow the same rule; extra `default`-kind entries do not subtract each other, so pin their `candidates` when they must not overlap.

- With no `candidates` and no enabled source, the review entry derives its own default pool: the most-used model plus the two strongest (by benchmark score, falling back to output price) of its Console window (top 18 by default), with free and training-consent models removed; the default entry then picks from what review left.
- `routes.review` is on by default; set `"routes": { "review": false }` to drop the entry.
- Selecting `Auto Review` engages review routing; the idle reset returns the session to `auto-review` (the route pin records which entry it came from, so entries never restore into each other).
- A review turn with no unique candidates left falls back exactly like the default entry: configured fallback, then the session's last-used real model, then the first pool entry.

## Agent profiles

Routing also reads the session's **active agent** (`Session.Info.agent`): `build`, `plan`, `explore`, or any custom subagent id. The agent is the stance the user already chose, so a profile can refine the question without changing which entry or pool the turn routes through. A child session that inherits the `Auto` entry is routed with its own agent id (`explore`, or a custom subagent), so the same mechanism covers subagents; a child session on a model of its own is left alone unless `effort.mode` is `"always"`, and an agent with no profile (for example `general`) keeps the entry's criteria.

Built-in profiles (`agents` is a record of profiles keyed by agent id; three are built in):

| Agent | Stance | Effort band | Context floor |
| --- | --- | --- | --- |
| `build` | baseline: the entry kind's criteria | none | the entry's own |
| `plan` | scoping, decomposition, unknowns and risks before code | at least `medium` | 200k (applied only when above the entry's floor) |
| `explore` | search and read; cheapest model that follows instructions | `low` to `medium` | the entry's own |

Each field is optional:

- `criteria` replaces the entry kind's instruction text for this turn. It is the full stance, not a sentence appended to the kind's text. A `@name` value references a named stance (`@review`, `@plan`, `@explore`) instead of pasting its text; `@default` or `@build` restores the entry kind's baseline text.
- `minContext` is an additional context floor applied to the Console pool cut. It only raises the entry's own floor (a lower value never weakens the entry's cut), and it has no effect on explicit `candidates`, which are pinned as written.
- `effort` bands the offered `(model, level)` options. `{ "min": "medium" }` keeps medium and above, `{ "max": "low" }` keeps low and below, and `{ "min": "medium", "max": "high" }` keeps both ends. A single level string (`"effort": "high"`) is shorthand for a floor. Options outside the band are not offered, so the judge cannot pick them. When a model lists no level inside the band, its nearest level survives rather than the model dropping out. The band also applies when effort routing runs without model routing (no usable candidates).

Agents are matched by exact id from the live session; stances are never inferred from names. An absent or unmapped agent leaves routing exactly as configured. Add any other agent or subagent the same way, for example a custom review agent:

```jsonc
"agents": {
  "review": {
    "criteria": "@review",
    "effort": { "min": "medium" }
  },
  "my-planner": { "criteria": "@plan", "minContext": 320000 }
}
```

`@review` is a named stance, not an agent the plugin defines: OpenCode ships no `review` agent, so nothing acts on it until you create that agent yourself. The text it resolves to reads:

> This is a REVIEW turn: the assistant is inspecting a change for defects. Prioritize correctness, thoroughness, and subtle problems over speed and price: pick the model with the strongest reasoning and enough context to hold the whole diff and the code it touches, and use enough effort to catch what a quick skim misses.

The other named stances are the built-in texts of `plan` and `explore`, so a custom plan-like subagent can share the plan wording without copying it. `@default` and its alias `@build` are baselines rather than texts: they clear the profile's criteria so the entry kind's own text applies, which is how a built-in stance is turned off again (`"plan": { "criteria": "@default" }`). An unknown `@name` logs a warning and leaves the profile's criteria unchanged.

`"agents": { "<id>": false }` drops one profile (including a built-in), and `"agents": false` disables every profile. A user entry merges over the built-in for the same id, so overriding just `effort` keeps the built-in criteria and floor. Precedence: the entry owns the pool and candidates; the agent profile owns the stance text, the added context floor, and the effort band. When both apply, the profile wins on those three.

## Candidate sources

Besides the static list, an entry can draw from what the session already knows:

- `"favorites": true` merges the models starred in OpenCode's model picker.
- `"pool": true` merges the Console pool into the entry's configured candidates. `false` disables the pool for that entry; absent keeps the implicit rule (the pool applies only when the entry has no candidates and no other source); an object (`{ "cheap": 2, "strong": 1 }`) inlines that entry's own cut. The pool itself is Console-only: it ranks `opencode`/`opencode-go` models and never another provider's.

Sources are off unless enabled, additive to `candidates`, and fail open when the underlying file is unreadable. The leaderboard is fetched once per process and snapshotted. Each entry can enable its own `favorites` and `pool`; the process reads the favorites snapshot once and derives each entry's pool from it. New favorites appear after a restart; per-prompt routing then costs no extra I/O. `/jev-status` shows the resolved pool for every entry.

## Pool cuts

Every entry carries its own cut under its `pool` key; there is no separate pool registry. The two built-in cuts are the defaults:

| Entry | Default cut | Window | Context floor |
| --- | --- | --- | --- |
| `routes.default.pool` | `1 cheap + 1 popular + 1 strong` | top 18 | 500k |
| `routes.review.pool` | `1 popular + 2 strong` | top 18 | none |

A cut accepts `cheap`, `popular`, `strong`, `topK` (the leaderboard window it picks from, clamped 1-40), and `minContext` (context floor, `0` disables it). Omitted fields keep the kind's built-in value, so `"pool": { "strong": 3 }` only changes strength.

- `pool: true` (or an absent pool on a bare entry) uses the built-in cut for the entry's `kind`, so editing `routes.default.pool` also shapes every other `default`-kind entry that takes the kind cut.
- `pool: { ... }` on a custom entry is that entry's own cut: an independent slice of the same ranked window, which may overlap the built-in cuts. Review-kind entries still subtract the `default` entry's pool at route time.
- `pool: false` turns the pool off for that entry. An entry with no `candidates` and no source then has nothing to route to and uses its fallback chain.

An inlined cut does not replace `kind`: the entry keeps the review criteria and the review/default disjointness rule, and `kind` still decides which built-in cut `pool: true` inherits.

## How a pool is ordered

The window and the picks inside it are built in this order:

1. **Membership is usage.** The pool is the Console catalog matched against the public leaderboard, in leaderboard rank order and truncated to the split's `topK`. A model the leaderboard does not list is not in the pool at all. If nothing matches (the fetch failed, or no catalog model is ranked), the window fails open to the whole pool sorted by blended price, so routing still has candidates.
2. **One model, one provider.** When both `opencode` and `opencode-go` list the same model id, the cheaper entry (by listed price) represents it.
3. **Cheap, then popular, then strong.** Each split fills its `cheap` slots by ascending real cost (session cost, else cache-adjusted input plus output; ties by model id), then its `popular` slots from the rest in leaderboard order, then its `strong` slots by benchmark strength (ties toward the better usage rank, then model id). A model already taken by a slot cannot fill another.
4. **Order survives into the candidates.** The picks are appended to the entry after its explicit `candidates`, in that same cheap/popular/strong sequence, so "the first pool entry" in a fallback chain is the cheapest pick. `/jev-status` prints the resolved list in this order.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `routes` | `{ "default": {}, "review": {} }` | Record of routing meta models. `false` disables every entry. Built-in keys `default` and `review` keep the picker ids `opencode-decisions/auto` and `opencode-decisions/auto-review`; any other key registers `opencode-decisions/<key>` after them. |
| `routes.<id>.kind` | `default` (`review` for the `review` key) | `default` or `review`. Sets the routing criteria (a review turn is judged for correctness and thoroughness), keeps review-kind entries disjoint from the `default` entry's pool, and selects the built-in cut that `pool: true` inherits. An inlined cut replaces only that cut ([Pool cuts](#pool-cuts)). |
| `routes.<id>.name` | `Auto` / `Auto Review` / the key | Picker display name. |
| `routes.<id>.aliases` | `[]` | Extra search aliases, shown as a name suffix (`Auto (Jev)`). |
| `routes.<id>.candidates` | `[]` | Models jev may route to (`provider/model` strings or `{ providerID, id }`). Empty with no source = Console default pool. |
| `routes.<id>.favorites` | `false` | Merge your TUI-favorite models into this entry's pool. |
| `routes.<id>.pool` | `{}` | The Console pool source and this entry's own cut (omitted fields keep the kind default). Set `false` to disable the pool for this entry; `true` uses the kind's built-in cut instead. |
| `routes.<id>.pool.cheap` | `1` (`0` for `review`) | Lowest-real-cost picks; `0` disables the cost axis. |
| `routes.<id>.pool.popular` | `1` | Highest-public-usage picks left after the cost picks. |
| `routes.<id>.pool.strong` | `1` (`2` for `review`) | Strongest picks left after cost and usage. |
| `routes.<id>.pool.topK` | `18` | Leaderboard-ranked window this cut picks from, clamped 1-40. |
| `routes.<id>.pool.minContext` | `500000` (`0` for `review`) | Context floor for the cut; `0` disables it. |
| `routes.<id>.minConfidence` | `0.45` | Minimum confidence required to switch model; clamped 0.25-0.99. Pair mode splits probability across many options, so a pick needs a lower bar than a simple verdict would. |
| `routes.<id>.fallback` | - | Real model (`provider/model`) switched to when a turn on this entry cannot be routed; without it the session's last-used model is the fallback. |
| `agents` | `{ "build": {}, "plan": {}, "explore": {} }` | Record of agent profiles keyed by OpenCode agent id. Omitted or `true` uses the built-in set; `false` disables every profile. Built-in keys `build`, `plan`, and `explore` carry the stances above; any other key registers a profile for that agent or subagent id. |
| `agents.<id>.criteria` | `@build` for `build`, `@plan` for `plan`, `@explore` for `explore`, `@default` for other ids | Full routing instruction text for the agent's turns; replaces the entry kind's criteria. Each built-in defaults to its own named stance, and any other id defaults to `@default`; both `@build` and `@default` are the baseline, so the entry's text applies. A `@name` value references a named stance (`@review`, `@plan`, `@explore`); `@default`/`@build` restores the baseline. |
| `agents.<id>.minContext` | `0` (`200000` for `plan`) | Additional Console pool context floor; only raises the entry's floor. |
| `agents.<id>.effort` | none (`{ "min": "medium" }` for `plan`, `{ "min": "low", "max": "medium" }` for `explore`) | Effort band for offered options: `{ min, max }` or a level string (a floor). `false` clears it. |
| `effort.mode` | `"pair"` | Effort routing. `"pair"` pairs the model with a level on entry turns and leaves a hand-picked model alone; `"always"` also routes the effort variant of a hand-picked model; `"off"` turns effort routing off everywhere. An unknown value falls back to `"pair"` and logs a warning. |
| `effort.minConfidence` | `0.45` | Minimum confidence required to switch the reasoning variant. |
| `goPlan` | `"go"` | Which OpenCode Go plan's monthly-limit table prices the pool and the candidate rows: `"go"` ($10/mo), `"go-plus"` ($40/mo), or `"go-teams"` ($20/member/mo). The plan's price over a model's allowance turns its list price into the effective price the cheap axis and the judge see. Allowances ride only `opencode-go` entries, never the pay-as-you-go `opencode` provider; an unknown value keeps the default and logs a warning. |

The routing options live under `routes` because `model` is the judgment-model override (a string); one key must never carry a string and an object meaning.

## Deprecated and removed

These still load, but each logs a one-line notice; use the documented shape instead.

- `auto`: alias for `routes`. Ignored when `routes` is set.
- `effort.auto` (boolean): alias for `effort.mode`; `true` maps to `"always"`, `false` to `"off"`. `mode` wins when both are set.
- A flat legacy object (the old per-entry fields directly under `auto`, or directly under `routes`) is read as `routes.default`.
- `pools` (top-level): removed. Pool shapes are inlined on `routes.<id>.pool`, so there is no shared registry to select from.
- `routes.<id>.pool` as a string (`"big"`): named pools are gone. The string warns and fails closed; inline the cut as an object, or use `true` for the kind's built-in cut.
- `routes.<id>.sources`: removed. `favorites` and `pool` moved onto the entry itself; a leftover `sources` object warns and contributes nothing.
