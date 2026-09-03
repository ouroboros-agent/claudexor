---
"@claudexor/daemon": patch
"@claudexor/cli": patch
---

Background quota polling no longer lets one revoked, never-logged-in, or failing profile pin its vendor's healthy profiles to the 15-minute retry ceiling: a lane whose fresh evidence is about to expire renews on schedule even mid-ladder. The Claude OAuth source also remembers a proven vendor rejection per presented token and stops re-presenting it on background cycles — until the token changes, a login or profile change, an explicit refresh, or six hours, after which one remembered token is re-verified per cycle — so a rejected token reaches the vendor at most once per six hours instead of every cycle, removing the 401 storm behind the one-hour vendor 429 that blacked out every healthy sibling.
