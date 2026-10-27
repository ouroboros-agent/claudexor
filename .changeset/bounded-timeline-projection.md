---
"@claudexor/control-api": patch
---

Run detail now selects the newest 500 displayable timeline rows before redacting and validating them, so a long `events.jsonl` no longer pays the per-row projection cost of rows the bounded timeline omits. For valid, canonical events the response is unchanged: the same rows in the same order, the same omitted count and evidence markers, and budget, plan progress and `lastSeq` still read the complete event snapshot. A corrupted log can now behave differently. A malformed row whose projection throws, such as a `project.git.initialized` row whose `failed_stage` is an object without a callable `toString`, used to fail every detail request for the run; it now fails a request only while it is among the displayed rows and is otherwise counted as omitted. An event whose `type` cannot be converted to a string still fails the request wherever it appears.
