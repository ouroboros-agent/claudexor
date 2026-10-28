---
"@claudexor/schema": patch
"@claudexor/daemon": patch
"@claudexor/control-api": patch
"@claudexor/cli": patch
"@claudexor/mcp-server": patch
---

Fix multi-run waits and task-group recovery (#513, #514, #515).

A daemon that stops while `POST /v2/runs/wait-many` (`claudexor_runs_wait`, CLI `runs-wait`) is waiting now answers a retryable `503 daemon_stopping` at once instead of holding the shutdown until a forced exit; a launch whose run has not started yet gets its `202` receipt. `waitMs` bounds the wait between reads, never a read: a read under way at the deadline finishes and its facts and attention are the answer, so a short positive `waitMs` no longer returns every target `not_observed`. A problem row's `null` token can be echoed as `seen: null` to acknowledge that problem, so the wait continues for the healthy targets instead of returning at once; output shapes are unchanged. Observation tokens never match the secret scan that guards MCP input. A request body the daemon refuses keeps its connection until the typed `413` is read, on JSON routes and upload bytes alike, and stop closes only connections still sending such a body.

Waits wake from the store's post-commit notices for the watched jobs, runs and questions instead of a 250 ms poll that re-read every target, and they re-read only the targets a notice names. Group pages add each member once instead of re-serializing the page per member.

Task-group membership now ignores the letter case of the group UUID: engine schema 6 stores the canonical lower-case group in a `command.task_group_id` column, backfilled for live and archived rows, and answers keep the caller's spelling. Older engines refuse the upgraded store, and group cursors issued before the upgrade restart with `stale_cursor`. A tagged launch, retry or decision rerun is refused before acceptance when the store identity is unavailable; a decision rerun keeps its group and answers `newJobId` with the group receipt. A CLI wait that fails after acceptance keeps the job receipt in the error context. CLI `--wait-ms` and `--limit` accept only plain decimal integers.

Changes that controllers and embedders can see: CLI and MCP clients from 4.8.0 check `seen` locally and refuse `null`, and a 4.8.0 daemon refuses a request that carries it, so acknowledging a problem needs both sides upgraded. A token saved from 4.8.0 that the MCP secret scan refuses can be dropped from `seen` once to receive its re-derived replacement. A target hidden by pruning, archive or a generation change during a wait shows `not_found` at the deadline's read rather than at once. `GET /v2/task-groups/:id/runs` refuses a `limit` with a leading zero. The CLI's bounded observation reads report a malformed daemon answer as non-retryable `invalid_service_response` and a read timeout as `run_observation_timeout`. Embedders of `DaemonControlApiServer` can pass the new optional `runObservationChanges` feed; without it waits keep the 250 ms poll, and wait-many no longer subscribes to the `bus` option, which still drives the event streams.
