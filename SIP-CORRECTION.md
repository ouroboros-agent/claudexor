# Darwin census test correction — PR #456

This supplements, and does not rewrite, the earlier complete lifecycle report. Original PRs #453 and #454 remain landed at `9b937ec8637031b66d9c71ecd6f960750931533f` / tree `85d7052979728a91b3ad64538898088171796575`.

## Exact additional subject

[PR #456](https://github.com/razzant/claudexor/pull/456): base `9b937ec8637031b66d9c71ecd6f960750931533f`, head `a5dd5e7f9d9eba94e6b2ad459563e20664ea82de`, tree `ca4339715884169f1e10392e5ebfbafcc345c764`; two test files only, +100/−10, patch SHA256 `0110cbd71df2dae8af284fb74d3a51b59c4e40e7602f9188f5f4dbc990e3612c`. No production/schema/version behavior changes.

The first release candidate failed one old native macOS assertion: expected hidden environment, observed visible. Its full gate was 8080 passed / 1 failed / 13 skipped. The test now measures this host through a separate bounded ps/proc read, checks exact marker and foreign-marker membership, requires real PID/birth-bound reaping if visible or retention of the same identity if hidden, and always retains Darwin restricted/not_provable coverage. A deterministic fake-ps case covers both visibility branches and foreign membership. The actual SIP configuration causing the runner difference remains unknown.

## Complete independent criticism

- [18 Astra](18-sip-astra.md): CODE/coupling PASS with explicit cleanup/oracle/native-release limits.
- [19 Opus](19-sip-opus.md): separate critic, not the patch author; CODE/coupling PASS with platform, wording, early-warning and evidence qualifications.
- [20 Grok](20-sip-grok.json): normal native source-reading review `rl-20261014T114243-843ac1c6acf6`, CODE/coupling PASS. This one-seat host record does not impersonate a three-seat panel. A preceding unadmitted Grok child returned no review and was confirmed cancelled before this route.

Only local filesystem prefixes are replaced. The adjacent manifest binds full original and exported technical-text bytes; raw sessions, account identities, prompts and private owner dialogue are not included. These provenance labels are not public retrieval links.

## Author dispositions and qualification

I accept the correction for integration. The conservative discovery contract is unchanged; no global completeness gate or runtime workaround was added. Original local and release failures remain negative evidence, not relabelled.

Two complete local runs of both files passed 63/63 with no skips, before and after deliberate mutations. Always-true confirm, always-false confirm, and falsely complete Darwin coverage each failed the intended assertion. Workspace build, test-source typecheck and format passed. A separate host check re-parsed raw XML, compared the complete source and QA diffs to the pinned patch, and confirmed restoration of production bytes. The preserved harness contains the exact mutation substitutions; the result.json alone did not. An initial verifier assertion reversed the retained release-log wording and failed; correcting that expectation required no repeated product/test execution.

The local Mac exercised hidden-environment behavior. Linux and the shown-environment release Mac require their remote executions; no remote fixed-branch or complete-release PASS is claimed here. The existing numeric-PID finally cleanup has a residual PID-reuse/no-confirmation gap; it is retained, not declared proven safe. The oracle is independent of the production runner/parser, not of the kernel or ps. Existing recorded-group native coverage depends on marker visibility; deterministic group tests remain. Slightly absolute SIP wording is conservative, not a justification to promote coverage to complete or redesign lifecycle here.

At this report, PR456's first ordinary merge was refused before effect by branch policy while CI was running. No admin, force or auto-merge was used. The required signed-release pipeline, immutable tag, both offline manifests, artifact/publication/npm proof, verified Ouroboros consumer pin and installed qualification are still separate, unfinished obligations.
