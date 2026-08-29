---
"@claudexor/cli": minor
"@claudexor/mcp-server": minor
---

The `claudexor_accounts` MCP tool defaults to the server's cached credential-profiles listing instead of hardcoding the atomic snapshot; `fresh: true` opts into the expensive snapshot form (which itself now honors per-vendor rate-limit cooldowns). The tool description states the cost honestly and the output schema is the union of both forms.
