---
"@claudexor/daemon": patch
"@claudexor/control-api": patch
"@claudexor/cli": patch
---

`GET /v2/global/events` and `GET /v2/projects/:id/events` now replay and tail the retained journal in bounded pages (at most 256 events and 1 MiB of stored payload each) instead of reading, validating and writing the whole retained history before the first event. Replay stays complete and ordered with the same cursors and the same 409 `resnapshot` refusals; an event larger than a page is sent whole on its own. The daemon waits for a slow reader to drain before writing more, keeps one page read in flight per connection, and stops reading when the client leaves or the daemon stops. A stream whose partition generation is replaced now closes instead of continuing in the new epoch, including a stream that had not received an event yet. Motivation: issue #312, where back-to-back full snapshots of a dense root raised daemon RSS to 4.1 GB.
