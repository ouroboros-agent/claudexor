---
"@claudexor/harness-agy": patch
---

Antigravity runs can now read files outside their workspace folder. Readonly runs mapped to agy's plan mode, which asks before such a read; a headless run cannot answer, so agy refused the read and usually ended the turn without an answer. On one install, 62 of 123 readonly agy runs between 14 and 28 October 2026 failed this way, against about 1% for claude and codex readonly. The adapter now ensures the profile's own `settings.json` allows `read_file(/)` before every run, keeping all other settings, so agy reads any POSIX path like the other harnesses; write confinement is unchanged. Settings it cannot parse are left alone and the run reports `agy_read_grant_unavailable`. Windows path rules are unproven and get no rule. Plan mode still has no approved shell path, so a readonly prompt now ends with an engine note telling the agent that shell commands are unavailable instead of letting a refused command end the run.
