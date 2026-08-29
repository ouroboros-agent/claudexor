---
"@claudexor/harness-cursor": minor
"@claudexor/schema": minor
---

The cursor adapter can now host the delegation belt: engine-owned MCP servers are injected by reconciling `mcp.json` inside the Claudexor-owned lane `CURSOR_CONFIG_DIR` (sidecar-manifest reconcile; the host `~/.cursor` is never written; stale managed entries are removed on non-delegate runs) with `--approve-mcps`, and `capability_profile.mcp_injection` is declared true. Pending the live delegated E2E recorded in docs/FEATURES.md.
