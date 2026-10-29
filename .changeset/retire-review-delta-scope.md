---
"@claudexor/cli": major
"@claudexor/orchestrator": patch
"@claudexor/review": patch
---

**Breaking:** `claudexor review --delta-scope` is retired (#257). The flag belongs to the stable CLI surface that `claudexor help --json` declares, where it now stays listed only to be refused. It let the Cursor reviewer lane of a sealed release packet review only a sealed delta, a release ceremony the current review protocol no longer uses. A sealed packet review now covers the complete packet on every lane, Cursor included, and a packet that still carries delta evidence remains valid context. An invocation that still passes the flag, with or without a value, stops before any review work with exit code 2 and names both replacements: drop the flag to review the complete packet, or review a chosen delta as an ordinary diff with `git diff <base>..<candidate> > delta.patch` and `claudexor review --diff delta.patch`. Reviewer metadata no longer carries the `review_scope`, `delta_base_sha` and `delta_sha256` fields that only distinguished that lane. Archived signed review attestations are verified as before.
