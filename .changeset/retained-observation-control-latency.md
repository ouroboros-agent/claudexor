---
"@claudexor/control-api": patch
"@claudexor/event-log": patch
"@claudexor/schema": patch
"@claudexor/util": patch
---

Keep retained run observation off the control event loop: share request-local reads, preserve complete history for event folds, and use one lazy bulk worker for detail, summaries, artifact reads and finite event replay. Resume sequenced streams from the tail while preserving legacy cursors, redaction and terminal delivery. Expose route outcomes and separate worker queue/projection timing.
