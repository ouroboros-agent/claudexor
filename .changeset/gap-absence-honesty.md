---
"@claudexor/schema": minor
"@claudexor/daemon": minor
---

Suppressed quota polls never fall silent: gap absences (rate_limited, probe_skipped_rate_limited, and the new derived poll_paced) coexist with stale snapshots and are silenced only by fresh ones, so downstream exhaustion readers stay fail-open while a vendor's poll pacing is cooling.
