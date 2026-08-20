---
"@claudexor/schema": patch
"@claudexor/core": patch
"@claudexor/orchestrator": patch
"@claudexor/cli": patch
"@claudexor/control-api": patch
"@claudexor/workspace": patch
"@claudexor/util": patch
"@claudexor/mcp-server": patch
"@claudexor/harness-agy": patch
"@claudexor/harness-claude": patch
"@claudexor/harness-codex": patch
"@claudexor/harness-cursor": patch
"@claudexor/harness-opencode": patch
---

Remove the engine-owned outer Seatbelt wrapper and restore each harness's
native access policy. Delegated mutating runs now keep stable project identity
separate from their disposable execution workspace, active requests use
`readonly`, `workspace_write`, or explicitly trusted `full`, and historical
outer-confinement artifacts remain readable without enabling new retired-mode
runs.
