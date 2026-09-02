---
"@claudexor/harness-claude": patch
---

Admit `claude-fable-5-1` to the Claude manifest known-model list, so an explicit Fable 5.1 pin is accepted instead of refused as outside the manifest, and the Fable weekly window's `applies_to_models` now names the id, so the exact-match budget router applies that window to a 5.1-pinned run. The id is admitted from the vendor model table under the existing 2.1.165 `known_models_verified_against` stamp; it has not been live-verified on that CLI.
