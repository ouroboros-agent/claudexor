---
"@claudexor/control-api": patch
"@claudexor/daemon": patch
"@claudexor/schema": patch
---

`POST /v2/runs` and Exact Retry for a project root that was never registered now answer a typed `404 project_not_registered` (not retryable, with the remedy: register the root with `POST /v2/projects` or declare `scope.ephemeral`) instead of a retryable `503 idempotency_status_unavailable`.
