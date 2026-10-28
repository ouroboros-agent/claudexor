---
"@claudexor/schema": patch
"@claudexor/control-api": patch
"@claudexor/cli": patch
---

`claudexor doctor` now ends with the daemon's route health for the terminal runs created in the last seven days: a summary line, then each route (one harness crossed with one effective access profile) that had failures with its failure share and most frequent failure, as facts without thresholds or alarms. The full answer, every route's succeeded, failed, cancelled and other counts with up to three failure groups, is `GET /v2/daemon/route-health` in the control API (listed in the operation catalog; an older engine answers 404, which doctor prints as unavailable) and `route_health` in `doctor --json`. It is computed on demand from the retained run records by a bounded newest-first scan that says when it stopped early (`complete`, `incompleteReason`), and each run contributes only a few small artifacts read once in the shared worker, never its event journal. Motivation: on one install about half of the readonly Antigravity runs failed for two months while claude and codex readonly runs almost never did, and no surface showed failure shares per route.
