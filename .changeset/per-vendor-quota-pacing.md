---
"@claudexor/daemon": minor
"@claudexor/cli": minor
---

Quota poll pacing is now per vendor lane: each vendor's refreshers own an independent completion-anchored backoff, a typed rate_limited absence arms a persisted vendor Retry-After floor in daemon-private pacer state (never the quota journal), and a daemon restart or credential change no longer resets the vendor cooldown into a 429 amplifier.
