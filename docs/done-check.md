# Auto done-check

`"doneCheck": { "auto": true }` runs the completion self-check whenever the session goes idle: did the last turn genuinely finish, or did the agent stop early? It is the one place where the plugin writes without being asked, so the notice is deliberately capped:

- It runs at idle only, never mid-turn.
- At most one notice per user message and at most three notices per session (the counter survives restarts) - every notice wakes a turn, so the ceiling is independent of the transcript.
- It stands down when the newest assistant message ends by asking you a question, or when the session rests on the `Auto` entry with no real model to move to (a notice must not wake a turn that would fail on the pseudo-entry).
- A repeating (looping) tail is reported as such - asking you to interrupt or send a new instruction - instead of re-asking for "the remaining work".
- Silence means done: a notice is posted only when completion looks unlikely, i.e. p(complete) at or below `notifyBelow` (default `0.35`).
- The judged transcript tail is secret-scrubbed before it leaves the process; unchanged tails are not judged twice, and the plugin's own notices are excluded so they can never re-trigger the check.

`/jev-done-check` runs the same judgment on demand.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `auto` | `false` | Off unless explicitly enabled. |
| `notifyBelow` | `0.35` | Post the incomplete-notice at or below this p(complete). |
