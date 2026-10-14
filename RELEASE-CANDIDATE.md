# Verified release candidate — Claudexor 4.1.1

Recorded by Ouroboros, 14 October 2026, 23:33 UTC. This supplement binds the complete cumulative technical review in this repository to the actual release candidate. It preserves the historical reports and their negative findings; it does not manufacture a new whole-tree reviewer vote.

## Exact source and build

- Original #454 landed as `fa6e27a52bd2de1dd02fa99e9d10da73d7f28955`.
- Original #453 landed as `9b937ec8637031b66d9c71ecd6f960750931533f`, preserving both original histories.
- The independently reviewed, test-only #456 correction landed as `f82926c24f23b124197fc710a8aa9eb71aa9b0d9`, tree `ca4339715884169f1e10392e5ebfbafcc345c764`. Its full Astra, Opus and Grok reports are files18–20; [SIP-CORRECTION.md](SIP-CORRECTION.md) records the old failure and the precise correction.
- [Release candidate38564302532](https://github.com/razzant/claudexor/actions/runs/38564302532) completed successfully on exactly `f82926c24f23b124197fc710a8aa9eb71aa9b0d9`. It ran preparation, native Windows ConPTY authority, the complete macOS build/sign/notary gate, Linux OpenSSH runtime smoke and Windows Node24.16 packaged-runtime smoke. Publishing and npm jobs were intentionally skipped in candidate mode.
- The macOS raw log records8082 passing Node tests and13 skips,64 passing credential-free canaries, successful schema/docs/concept/invariant/format and other deterministic gates, and797 passing app Swift tests. Native app and DMG notarization were accepted. These are results on the release host, not a claim that prior local failures were explained.

## Independent artifact verification

The interrupted download was resumed by a confirmed HTTP206 range, not by rebuilding. The complete389054128-byte Actions ZIP matched the provider digest `2190af97cdbd08dd026090b5265a5d42885e3ea73051d25e755a0bc985975ea7`; its CRC and exact twelve-file membership were checked.

At23:30, a host-recorded parent check passed on those downloaded bytes:

- Every one of the twelve assets passed `gh attestation verify`, requiring repository `razzant/claudexor`, signer workflow `.github/workflows/release.yml`, source digest `f82926c24f23b124197fc710a8aa9eb71aa9b0d9` and the default SLSA provenance contract. A local DNS failure initially prevented Sigstore initialization. The same official CDN was then reached over verified TLS at an independently resolved address; `gh` verified its existing pinned TUF root through the signed rotation and current metadata. The resulting authenticated trusted root was supplied through its supported offline verification option. No signature, expiry, source or TLS check was disabled.
- All original SHA256SUMS entries and both unsigned manifests matched the actual archives. All four remote-runtime archive validators passed. Shipped SBOM identities and remote archive checksums were checked; their dependency inventory is covered by candidate provenance, not a newly regenerated local dependency inventory.
- The downloaded DMG and extracted app passed `codesign`, stapled-ticket validation and `spctl` assessment. The packaged daemon probe reported version4.1.1 and the exact source SHA. Packaged CLI help and a dry-run local harness-install plan passed without writing to their isolated HOME; no harness was installed or logged in.
- The packaged Windows ConPTY helper matched its native-build digest. All1997 regular files in the runtime closure matched the corresponding packaged app resources byte-for-byte.

At23:32, the original guarded offline signers sealed both manifest kinds using the existing runtime-update authority. The private key was neither copied nor printed. The publication-side verifiers independently accepted the pinned authority signatures, exact source/version, unchanged candidate fields and actual archive digests. The unsigned candidate files remain unchanged.

| Artifact | Verified SHA-256 |
|---|---|
| `Claudexor-4.1.1.dmg` | `67d0d18f2735927486751689dc0cf3cc9808f8dcc88cdea53e2a71ba2202159a` |
| `Claudexor-4.1.1.zip` | `24b07e0fab5c5f8341ed324d00d1e30a36171d75426264ab271040a874898bec` |
| `claudexor-runtime-4.1.1.tar.gz` | `6ce18eb6ece1a0e6273f0874415ba77edf266b53ea9e17053e4ebfa65143c40b` |
| Remote `linux-x64` archive | `a9767c4fdf84ad0d2d915038bd32e6fc93eb66c196db71081c5e66e5e84d0ace` |
| Remote `linux-arm64` archive | `dae0ee1ce83de570481c377d5476a94897f4acf132dac2964659114b79542a94` |
| Remote `darwin-x64` archive | `a80f7476195392687dbd02ef8c73746f57f66541e1482f8a58a73e0b67e7e0f3` |
| Remote `darwin-arm64` archive | `59f9002041bb1be8ccd3df7223857369020b3e5d4e501bb6ed799d307a464dfc` |

## Author decision and remaining boundaries

I accept this exact candidate for the normal immutable publication workflow, using the complete cumulative Astra/Grok/Anthropic review and the material-delta closures recorded here, plus the independently verified build and artifacts. This is an integrating author's decision, not another reviewer PASS. Publication must promote the same candidate bytes, recheck annotated tag/main identity and both runtime signatures, complete npm provenance/smokes, and only then publish the GitHub release.

At this supplement's timestamp, **tag, npm/GitHub publication and the Ouroboros consumer pin are not yet performed**. The current Ouroboros companion still needs composition with external work and final material qualification/review. No running installation, accounts or managed daemon was changed.

All prior local full-suite REDs, qualified review coverage, macOS/Linux discovery limitations, Windows unsupported-census policy and deferred real account-backed vendor/installed-host qualification remain as described in the original reports. A successful release-host gate does not erase those records or promise that no escaped descendant is possible on every platform.
