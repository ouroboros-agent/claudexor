---
"claudexor": patch
---

Readonly claude runs keep AskUserQuestion; workspace_write can run commands (Bash pre-approved for workspace_write/full only, honoring caller deny and Bash(...) scoping) with the asymmetry typed as the new `write_mechanism` capability; zero-gate runs stop lying in both directions (counts from configured gates, "gates n/a (none configured)" wording, ranking demotion preserved); outputSchema rides interactive lanes (the DT2.1-16 refusal is lifted, live-verified); cancellations carry typed provenance (`RunControl.reason_code`: user_cancelled | host_cancelled | owner_task_gone, validated at both boundaries and threaded into the abort token).
