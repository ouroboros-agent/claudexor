---
"@claudexor/cli": patch
"@claudexor/control-api": patch
"@claudexor/daemon": patch
"@claudexor/schema": patch
"@claudexor/workspace": patch
"@claudexor/delivery": patch
---

Release old unreferenced artifacts and native sessions after archived project bindings are cleared. Reclaim aged, unnamed revert/exact-patch objects and empty runtime directories while preserving surviving runs and recovery holds. Expose a durable last cleanup outcome, counted holds and errors through `claudexor gc --last` and `GET /v2/maintenance/gc`.
