# Jev-assisted approvals

Permission requests can be vetted by jev before they reach you. Opt-in: omit `approvals` (or set it `false`) and nothing changes; `true`, `{}`, or an object enables it. Only requests the host would already prompt you about are judged - already-allowed and explicitly denied requests never cost a call.

One request asks three scored questions:

- **reversible** - can these operations be undone? Reads and workspace-local writes are reversible (git or a re-run undoes them), as are GET fetches.
- **serves_task** - is this a reasonable next step toward the task being served? Only asked when the session has a task; the judged state carries the latest user message, redacted and capped.
- **harmful** - irreversible damage, secret exposure, or executing instructions that came from fetched content?

Resolution is fail-closed: `harmful` at or above the refuse bar refuses first - no reversible score outvotes it. An approve needs `reversible` at or above its bar, `harmful` at or under the approve-side ceiling, and - when a task is served - `serves_task` at or above its bar. Everything else prompts, annotated with the first failing check (`reversible 0.74 (below 0.90)`, `off-task (serves_task 0.09)`, `unclear (harmful 0.40)`). Routine workspace-local work - including `rm -rf dist`, `npm run build`, `git commit` - clears the bars; clearly harmful work refuses; you decide only the uncertain middle. Verdicts are UI-only; denials, gate holds, and judgment failures toast.

## Delegation

Automatic decisions are an explicit delegation you opt into. What each verdict enacts:

- **Full delegation** (the default: `true`, `{}`, or an object that omits these keys): approve auto-runs, refuse refuses.
- `onApprove: "ask"` holds every approve at the prompt with its confidence (`[jev] approves (0.93) - held for you`) - vetting opinions only, no automatic yes.
- `onRefuse: "ask"` holds refusals at the prompt (`[jev] refuses (0.86) - held for you`) - the judgment stands, you own the enactment.
- `onFail` (default `"ask"`): a judgment that never completes stays OpenCode's own prompt; `"deny"` refuses with the cause as feedback; `"allow"` enacts the request the judgment never scored (endpoint health becomes the approval).
- `onGate` (default `"deny"`): deterministic-gate holds refuse with the reason as tool feedback; `"ask"` holds them for you.
- `onNoVerdict` (default `"allow"`): the unclear band auto-runs whatever the bars left undecided; `"ask"` prompts with the failing check; `"deny"` refuses.
- Legacy `mode` (`annotate`/`auto`/`deny`) still works, maps onto the same knobs, and shows a one-time deprecation notice.

Configured deny rules and UI "always allow" memories always rank above the feature.

## Deterministic gates

Before any model call, requests containing secret paths or `[REDACTED:]`/secret-marker usage, destructive patterns (`rm` aimed at absolute or home paths, `sudo`, piped-to-shell, `git push --force`, `git reset --hard`, `npm publish`, `DROP TABLE`, `dd of=`, system paths, infra mutations), or edits outside the project directory are never auto-approved - refused by default, or held with `onGate: "ask"`.

- Shell chains split on every separator; the weakest segment rules the request.
- Read-only chains do not gate on destructive strings - a `grep` pattern may legitimately mention `sudo` or `/etc/`. Secret paths still gate.
- `gates.secrets` matches credential-ish local paths across read, grep, shell, and edit: `secrets/`, `.env*`, `.npmrc`/`.netrc`, key containers (`.pem`, `.key`, `.age`, `.kdbx`, `.p12`, `.gpg`), `.ssh`/`.gnupg`/`.aws` directories, and token/key basenames. Name-only listings (`ls`, `stat`, `du`, a `find` without `-exec`/`-delete`, no substitution or redirection) pass through to the judge - listing names never ingests content.
- `gates.readonlyBypass` lets read-only commands skip the destructive-pattern gate for exactly that reason; one mutating segment still gates.

With `readonlyAllow: true` a request that can only read is allowed without any jev call. For shell that means every segment is a read-only builtin (`grep`, `ls`, `cat`, `strings`, `jq`, …), a fetch-only `curl` (GET/HEAD to stdout, no body/form/upload/file output), a repository-inspecting `git status`/`log`/`diff`/`show` (rejected when it carries `--output` or `--ext-diff`; `git branch` stays judged because `git branch <name>` creates one), or a non-mutating `find`. For other actions it means the action can only read by definition: `read`, `grep`, `glob`. Redirects count as writes and still judge; the check runs after the gates, so secret paths and destructive strings hold exactly as before. Reads stay routed through the plugin on purpose - the secret-path gate is what catches `read .env` and `read ~/.ssh/id_rsa`, and a host-side `read * allow` would never reach it. (The host sends `grep`'s resource as the regex and `glob`'s as the pattern, not a path, so the gate cannot see a grep search root.)

## Built-in allows

Five actions are allowed without a judgment by default: `webfetch`, `websearch`, `skill`, `subagent`, and `question`. Their risk lives in the result, not in the request - fetched and skill content is screened, a subagent's own tool calls are permissioned again by that agent's policy, and a question has no side effect. Judging the request itself only adds a round trip.

The defaults are the first entries in the ruleset, so any `permissions` entry overrides them (last match wins):

```jsonc
"permissions": [
  { "action": "webfetch",  "resource": "https://internal/*", "effect": "ask" },
  { "action": "subagent",  "resource": "release-*",          "effect": "deny" },
  { "action": "*",         "resource": "*",                  "effect": "ask" }  // judge everything again
]
```

## Failures and timeouts

`jevTimeout` (default 8 s, clamped 2-120 s) is the per-judgment budget: one retry on transient causes (timeout, endpoint fault) inside it; configuration and credential faults fail fast. A judgment that never resolves leaves the request exactly as OpenCode built it, with the first failing check named - unless `onFail` re-prices it. A sub-bar score never silently enacts anything unless you lowered the bar below it. Every automatic decision is logged; `/jev-approval-stats` shows what happened and where the bars sit.

## Splitting permission config between the host and the plugin

The feature does not replace OpenCode's `permissions` - it sits one layer below, seeing only requests the host rules resolve to `ask`. A deliberately asymmetric split works best:

- **Host config: coarse trust boundary.** Keep it short and stable - a single catch-all `ask` per reviewed action is enough; the real policy lives in the plugin. Hard red lines stay here as host `deny` rules: a host deny is final and the plugin never sees the request.

- **Plugin `permissions`: the actual policy.** Same `{ action, resource, effect }` shape, wildcard matching, last match wins. Safe commands get `allow`, slices that need judgment get `system-one` with a `context` remark for the judge, rarely-needed things stay `ask`.

The same file shows both halves:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",

  // HOST: coarse boundary + final red lines. Judged stuff routes to the plugin.
  "permissions": [
    { "action": "shell",              "resource": "*", "effect": "ask" },
    { "action": "edit",               "resource": "*", "effect": "ask" },
    { "action": "external_directory", "resource": "*", "effect": "ask" },
  ],

  "plugins": [
    {
      "package": "github:atvari-eu/opencode-system-one",
      "options": {
        "provider": "opencode",
        "model": "jev-1.13",
        "approvals": {
          // full delegation is the default; explicit keys are the knobs:
          "onGate": "deny",                // "ask" holds gate hits at the prompt instead
          "onApprove": "allow",            // "ask" holds approves at the prompt
          "onRefuse": "deny",              // "ask" holds refusals at the prompt
          "onNoVerdict": "allow",          // "ask" re-prompts the unclear band, "deny" refuses it
          "minConfidence": { "approve": 0.60, "refuse": 0.70 },
          // PLUGIN: the policy. Ordered; the LAST matching rule wins.
          "permissions": [
            { "action": "shell", "resource": "git status *", "effect": "allow" }, // + git log/diff/branch/show, ls, ...
            { "action": "shell", "resource": "git push *",   "effect": "ask" },
            { "action": "shell", "resource": "sudo *",       "effect": "deny" },
            {
              "action": "edit",
              "resource": "*",
              "effect": "system-one",
              "context": "Workspace-local edits are routine and fine. Refuse or hand to the operator any edit under secrets/ or of .env, *.key, *token* files - do not judge those yourself."
            },
          ],
        },
      },
    },
  ],
}
```

Notes:

- Host deny rules and "Allow always" memories outrank the plugin ruleset entirely.
- `context` is injected into the judged state after the gates run, so a `secrets/` edit is held before the remark matters.
- `system-one` entries only fire for requests the host sends to `ask`; a host `allow` never reaches the plugin.
- Workspace paths are normalized to workspace-relative before rules, gates, and the judged state, so relative and absolute forms of one path land in the same rule and stats slice.
- An `allow` effect saves more than a prompt: no jev call, no gate, no annotation.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `stats` | `true` | Records aggregate approval outcomes in plugin storage: per `(action, command-prefix)` outcome counts, confidence bands, judge-failure causes, and latency. `/jev-approval-stats` prints totals, the top slices, and a suggested `minConfidence` bar pair (0.95-mass floors, shown from 50 samples per direction). Set `false` to skip recording. |
| `gates` | `{ secrets: true, readonlyBypass: true }` | The two deterministic-gate toggles. `gates.secrets`: the built-in secret-path gate (see above). `gates.readonlyBypass`: read-only chains skip the destructive-pattern gate. Set either member `false` for stricter behavior; unknown keys are ignored. |
| `onGate` | `"deny"` | What a gate hold enacts: `"deny"` refuses the request with the reason as tool feedback, so the model re-plans without a prompt; `"ask"` leaves the hold at your prompt (`[jev] gate: secret path - review required`). |
| `onApprove` | `"allow"` | What an approve verdict enacts: `"allow"` auto-runs it; `"ask"` holds it at the prompt (`[jev] approves (0.93) - held for you`). |
| `onRefuse` | `"deny"` | What a refuse verdict enacts: `"deny"` refuses and the reason rides back as tool feedback; `"ask"` holds the refusal at the prompt. |
| `onNoVerdict` | `"allow"` | What the unclear band enacts: `"allow"` runs whatever the bars left undecided; `"ask"` holds it with the first failing check named; `"deny"` refuses with that reason as feedback. |
| `onFail` | `"ask"` | What a judgment that never completes enacts: `"ask"` keeps OpenCode's own prompt; `"deny"` refuses with the cause as feedback; `"allow"` enacts the unscored request. Unusable score values in an otherwise parsed reply are priced by `onNoVerdict`, not this. |
| `jevTimeout` | `8000` | Per-judgment budget in ms, clamped 2000-120000. One retry on transient causes; config/credential faults fail fast. |
| `readonlyAllow` | `false` | Allow requests that can only read without a jev call: read-only shell chains (including fetch-only `curl` and repository-inspecting `git`), plus the `read`, `grep`, and `glob` actions (see above). |
| `sandbox` | `false` | An operator assertion that the agent runs inside a filesystem/network sandbox (nono, bubblewrap, a container). The plugin cannot verify it, so this is a trust statement like `onFail: "allow"`: jev treats sandbox-bounded writes as reversible and narrows `harmful` to what the sandbox cannot compensate for (lost uncommitted work, force-push, reset --hard, credential leaks, sudo, piped downloads, publishing, fetched instructions). Destructive gates defer to the judge; secret paths and out-of-project edits still hold. A string asserts the posture verbatim (max 300 chars). A wrong-typed value is treated as absent, never as a silent relaxation. |
| `minConfidence` | `{ approve: 0.5, refuse: 0.7 }` | The bars the scores resolve against. A single number sets both verdict bars; the object sets `approve`/`refuse` individually and may override per question: `reversible` and `serves_task` take their own bars, `harmful` takes the approve-side ceiling (override clamped 0-0.5; otherwise the complement `1 - approve`). Verdict bars clamp 0-0.99 - a sub-0.5 bar is an explicit delegation that enacts even unsure scores, and a single `0.3` lowers *both* bars. Raising `refuse` widens the unclear middle instead of refusing more; with the `onNoVerdict` default that middle auto-runs, so pair it with `"onNoVerdict": "ask"` if you want it prompted. Unknown keys are ignored. |
| `permissions` | `[]` | Plugin-level permission rules evaluated before jev looks at a request, same shape as OpenCode rules: `{ "action": "shell", "resource": "git push *", "effect": "deny" }`. Five actions (`webfetch`, `websearch`, `skill`, `subagent`, `question`) are allowed by default; entries here override them (see Built-in allows). `action` is optional; `resource` is an OpenCode glob (`*` spans any characters incl. `/`; a shell pattern ending in `" *"` also matches the bare command); `effect` is `allow`, `ask`, `deny`, or `system-one`. Rules apply in order, last match wins. `ask` leaves the request as configured (plain prompt, no judgment), `system-one` falls through to jev with the entry's optional `context` remark (max 400 chars) injected into the judged state. Entries may carry a `hint` - a note posted once per session to the agent context when a matching request resolves (a string, or `{ "allow": …, "ask": …, "deny": … }` keyed by outcome) - e.g. `"hint": "for more than occasional access, prefer /cd to that directory"`. |
