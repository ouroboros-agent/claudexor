---
"@claudexor/journal": patch
---

Keep prepared journal activation healthy for large compacted snapshots by
replaying records without one whole-array string conversion and treating an
unmaterializable opportunistic compaction as a no-op.
