# @claudexor/harness-agy

Adapter for Google's Antigravity CLI (`agy`): translates
`agy -p --output-format stream-json` into typed `HarnessEvent`s.

Accounts use NAMED credential-profile bindings only (there is no engine-default
agy credential). Every binding has a Claudexor-owned HOME that scopes vendor
state under `$HOME/.gemini/...`; credential custody is platform-defined.
Darwin and Linux declare the config-file/HOME transport. Windows uses the
current OS user's Credential Manager identity, permits one enabled binding,
and treats HOME as state scoping rather than an independent Google identity.
Readiness always comes from the bounded vendor `/model` probe, never from the
presence or absence of `antigravity-oauth-token`. See `src/profile.ts` for the
route and verification contract.

Fixtures under `fixtures/` pin the recorded 1.1.13 stream shapes; see
`fixtures/manifest.yaml` for provenance and stream-semantics expectations.
