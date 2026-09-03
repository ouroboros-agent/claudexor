---
"@claudexor/workspace": patch
---

Relativize a bare GNU diff 3.8 `Binary files … differ` record that follows a hunk with no `diff` echo (#252), so an owned binary artifact's absolute paths no longer escape the exact-prefix exclusion and repo-relative policy globs of captured workspace diffs.
