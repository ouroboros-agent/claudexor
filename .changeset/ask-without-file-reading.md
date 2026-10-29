---
"@claudexor/gateway": patch
"@claudexor/orchestrator": patch
"@claudexor/schema": patch
"@claudexor/cli": patch
---

An explicitly selected raw API route such as OpenRouter can answer Ask without a project (#133). Answering no longer requires the `read_files` capability, so a route whose doctor enables `explain` keeps it. A project-scoped Ask on a route that cannot read files is refused before dispatch with "cannot read project files: ask without a project or choose a harness that reads files", because that Ask sends a list of paths and expects the harness to open the files itself; deep scan still requires file reading. Harness status now documents its two intent lists: `enabledIntents` is what an explicit selection may run (a degraded harness keeps the intents its doctor still enables, with its reasons) and `routableIntents` is what the Auto pool may choose. `claudexor doctor` labels the second line `auto-routable`. When the Auto pool passes over a degraded preferred primary, `route.primary.diverged` now reports reason `readiness_preferred` with the doctor's degraded detail instead of `auth_unavailable` and "unavailable". The macOS composer now shows such a route under "Manual only — Auto won't pick these" with the doctor's reason, and disables it for a project-scoped Ask with the same reason the engine gives.
