# Exact landing and release-candidate binding

Recorded 14 October 2026 by Ouroboros, after reading the original report and actual GitHub/Git receipts. This supplements the historical [complete independent report and dispositions](README.md); no reviewer response or failed test is rewritten.

## Original PRs landed separately

- [PR #454](https://github.com/razzant/claudexor/pull/454) landed at `2026-10-14T07:52:39Z` as `fa6e27a52bd2de1dd02fa99e9d10da73d7f28955`, parents `e658c9a4f69ccb620944d4ec9a09e640e00ca97b` and original `88f62c639534028986b1bcc4cc3c757a6da6d226`, tree `7e6dfdefd8389f0d19dc3e83ab6cc0a19708c1f8`.
- The original #453 candidate `15903a112a2c0b572d0dd869b0828e29e7beb381` received an ancestry-only merge of that #454 landing: `9ed5bfaf6f9342558afd76f03a15c89ddb825476`. Its complete source tree stayed **byte-identical**: `85d7052979728a91b3ad64538898088171796575`. No test, runtime, manifest or document changed.
- [PR #453](https://github.com/razzant/claudexor/pull/453) landed at `2026-10-14T08:23:48Z` as **`9b937ec8637031b66d9c71ecd6f960750931533f`**, parents `fa6e27a52bd2de1dd02fa99e9d10da73d7f28955` and `9ed5bfaf6f9342558afd76f03a15c89ddb825476`. Its tree is again exactly `85d7052979728a91b3ad64538898088171796575`.

The author independently checked remote and fetched Git objects, mechanical merge trees, parent order and ancestry. Both original PR histories and authorship survive; no squash, rebase, forced update or administrator merge was used.

## Review and QA boundaries

The complete cumulative technical review in this directory covers that same source tree. I accept the exact landed tree on that evidence and its findings/dispositions. This is **not** a claim that a new whole-PR panel ran on each ancestry-only commit. Host merge receipts disclose declaration-only/unknown review coverage and a changed landing base; those diagnostics remain.

- Candidate15903: [CI run38527005804](https://github.com/razzant/claudexor/actions/runs/38527005804), all6 jobs successful.
- Ancestry-only9ed: [CI run38532178808](https://github.com/razzant/claudexor/actions/runs/38532178808), all6 jobs successful, read back08:20UTC.
- Earlier local NON_GREEN runs and platform/vendor limitations remain. CI success does not establish their causes.

## Release-candidate operation

Exact landed SHA `9b937ec8637031b66d9c71ecd6f960750931533f` was submitted once to the existing Release workflow in **candidate** mode08:30:55UTC. [Candidate run38535646188](https://github.com/razzant/claudexor/actions/runs/38535646188) was observed in progress08:32UTC. This is build/sign/notarize/attest, not completed publication.

The exact source SHA/tree above are the reviewed subject for later release confirmation. The candidate run must succeed; promoted bytes, attestations, both offline-signed runtime manifests, annotated tag/main identity and publication/NPM receipts need their own checks. No signature, release, installation or Ouroboros pin is certified by this addendum.
