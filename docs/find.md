# `jev_find` - semantic code search

`jev_find` is registered by default (`"find": { "enabled": false }` removes it): a jev-backed search for questions grep cannot phrase - "where is this *discussed*?", "which file decides how config X behaves?".

The cascade: a cheap lexical prefilter over the workspace (respects `.gitignore`, skips secret paths), then jev judges the shortlisted files by name, then promising files are cut into windows and judged by content. The report ranks files with heat, line ranges, and excerpts.

The report is a routing signal, not proof: it tells you which files to *read*, and excerpts are cut mid-function. Expect several jev calls and a few seconds - use it as a last resort after a failed grep. Repeated questions over the same tree are cached.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Register the tool. `false` (or a bare `"find": false`) removes it. |
