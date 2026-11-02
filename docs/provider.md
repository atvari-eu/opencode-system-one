# Provider & credentials

The `provider` option selects the System One deployment jev judges against; it is resolved once at plugin start.

- **`"opencode"`** (default) - the Console pay-as-you-go deployment: `jev-1.13` (bills Console credits) and `jev-1.13-free` (zero-cost, OpenCode clients only). The endpoint comes from the models.dev decision catalog, with a baked fallback for boots where the catalog is unreachable.
- **`"opencode-go"`** - the OpenCode Go subscription deployment; credentials via `OPENCODE_GO_API_KEY` and the legacy store's `"opencode-go"` entry.
- **Any other id** registered in your OpenCode config - the endpoint is the provider's `settings.baseURL` joined with `/systemone` (appended unless already present). Change the provider config and the next plugin start follows it; there is no plugin option to keep in sync. Console-managed connection providers (`console-*`, added when you connect an integration) work the same way and need no key of their own - their proxied System One route authenticates with your Console login.
- **An explicit URL** (`https://…`, or loopback `http://127.0.0.1/…`) points at the endpoint directly; keys pair via `TYPESAFE_API_KEY` only.
- **`JEV_ENDPOINT`** overrides everything endpoint-related and skips the provider registry.

Example: point jev at an inference provider you already registered for chat, so judged calls run on the same deployment:

```jsonc
{
  "providers": {
    "acme": {
      "name": "Acme",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://api.acme.dev/inference/v1" },
      "models": { "acme-ai/decider-v1.2": { "name": "decider-v1.2" } }
    }
  },
  "plugins": [
    {
      "package": "github:atvari-eu/opencode-system-one",
      "options": { "provider": "acme", "model": "acme-ai/decider-v1.2" }
    }
  ]
}
```

Model discovery: the picker's candidates come from models.dev's decision catalog; an unreachable catalog falls back to a mirrored snapshot, then to the Console models. A `"models"` plugin option replaces them outright for custom deployments, and every pick is ping-verified before it sticks.

Anything else is a fault: an unregistered provider, unreachable endpoint, or unverifiable model fails all judged features closed with the deployment's own diagnostic - never a silently guessed endpoint, never a fallback to another provider.

## Credentials

Resolved once per plugin start (the key is never logged or persisted):

1. **Env** - `TYPESAFE_API_KEY` / `OPENCODE_API_KEY` (Console deployments) or `OPENCODE_GO_API_KEY` (opencode-go); `TYPESAFE_API_KEY` for host-registered providers. It must pair with whatever endpoint is resolved.
2. **The OpenCode CLI credential store** - an API key or the active OAuth session. Console deployments read the `opencode` integration; host-registered providers read their own integration (`opencode auth login <provider-id>`). Re-read once when the endpoint rejects a cached key as expired/revoked/invalid. Skipped while `JEV_ENDPOINT` is set.
3. **The legacy auth store** (`~/.local/share/opencode/auth.json`) - V1 installs and hand-planted keys; the V2 CLI no longer updates it.

- `JEV_MODEL` sets the default judgment model (`jev-1.13-free`); the plugin's `model` option wins over the env, the env over the default.

A missing key or failed call never produces a "successful" judgment: screen marks `unavailable`, tools throw. Endpoint diagnostics surface as themselves: 401 = credential rejection (expired key or wrong deployment), 402 = lack of funds, 403 = pairing or free-tier gate. There is no fallback chain between deployments.

## Deployment verification & errors

The deployment is ping-checked once at plugin start; a fault (unknown model, missing or wrong credential, outage) fails every judged feature closed until the plugin restarts with a working config. A changed fault surfaces one `[jev-config-error]` toast per config change.

Failed judged calls surface `[jev-error]` toasts (per-call rows on hosts without an event surface). Actionable classes keep a stable remedy title - missing credential, 401 key rejection (expired API keys get their own advice: create a new one in the provider's console, since `opencode auth login` cannot renew an API key), 402, 403, wrong model, free-tier restriction - while anything else shows the flattened failure text. The same title repeats at most once per 60 s per session: a surfaced row wakes a turn, and an idle probe failing on a dead credential must not re-trigger itself. Routing, effort, and local-tool screening failures surface the same way.
