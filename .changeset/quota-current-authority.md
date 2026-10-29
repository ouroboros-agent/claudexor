---
"@claudexor/orchestrator": patch
"@claudexor/cli": patch
---

An account that hit its limit and moved its work to another account now chooses that next account from the quota it can see at that moment. Before, the continuation reused the quota list read when the attempt started, so an account whose five-hour window had reset in the meantime, or whose newer reading showed an early reset, was still skipped as over its limit, and the run could end with "no eligible replacement" (#457). The list is read once per decision, after the readiness checks, and the same reading explains the choice, the `route.profile.rotation_exhausted` event and the final error. A weekly or other limit that is still spent keeps blocking even when its reading has gone stale; pinned runs still never move, and an account already tried in the attempt is not tried again. When a reset makes the whole reading stale, a weekly reserve set below 100% is still not enforced until the next quota poll; that rule is unchanged.

Antigravity quota refresh now follows the daemon's refresh plan (#240, wiring only). A refresh of one account no longer starts the vendor's `/quota` and `/model` commands for every Antigravity account, a background poll skips accounts whose reading is still current, an account under a poll pause is reported as `poll_paced` without a vendor call, and each read or skip is written to the daemon log as a `quota.observation` record. Antigravity rate-limit responses are still not recognized as such: they remain ordinary refresh failures.
