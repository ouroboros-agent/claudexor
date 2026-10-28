---
"@claudexor/schema": patch
"@claudexor/control-api": patch
"@claudexor/cli": patch
---

`claudexor doctor` now ends with the daemon's route health: for the last seven days, how many terminal runs each route (one harness crossed with one effective access profile) ran, how many succeeded, failed or were cancelled, and each failing route's most frequent failures, as facts without thresholds or alarms. The same answer is `GET /v2/daemon/route-health` in the control API (listed in the operation catalog; an older engine answers 404, which doctor prints as unavailable) and `route_health` in `doctor --json`. It is computed on demand from the retained run records by a bounded newest-first scan that says when it stopped early (`complete`, `incompleteReason`). Motivation: on one install about half of the readonly Antigravity runs failed for two months while claude and codex readonly runs almost never did, and no surface showed failure shares per route.
