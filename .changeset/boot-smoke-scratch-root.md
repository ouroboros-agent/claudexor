---
"claudexor": patch
---

The macOS packaging boot smoke now starts the bundled daemon in an empty environment with only a scratch `HOME` and a fixed `PATH`, watches for discovery in the root derived from that `HOME`, and stops and reaps the daemon before deleting that root. An exported `CLAUDEXOR_CONFIG_DIR`, socket or control-API override, `NODE_OPTIONS` or provider key in the builder's shell can no longer point the smoke at another root or reach the daemon.
