---
name: claudexor
description: Use the local Claudexor control plane for harness-agnostic coding work across Claude Code, Codex, Cursor, and OpenCode. Use when a task benefits from doctor-backed harness selection, quota-aware account rotation, shared thread context, read-only planning or research, best-of-N execution, or cross-harness review.
---

# Claudexor

Use the MCP tools supplied by this plugin. They connect to the user's local
Claudexor installation; they do not provide accounts or remote model access.

## Preconditions

- Support macOS and Linux. Do not claim Windows support.
- Require Node.js 20.19 or newer and a preinstalled `claudexor` command. If the
  MCP server is missing, ask the user to run `npm install -g claudexor`, then
  restart the host. Do not download a runtime implicitly.
- If a generated Claudexor host integration already owns the current host's
  setup, leave it in place. Do not repair, replace, or uninstall it
  automatically.

## Choose a route

Start read-only unless the user explicitly asked to change or create files.

1. Call `claudexor_status` before choosing a harness. Treat a harness as usable
   for a requested intent only when its doctor-backed status is `ok` and that
   intent is enabled; this aggregate harness status does not prove a named
   credential profile or host/default login.
2. Call `claudexor_accounts` before choosing an account or reviewer identity.
   It is a read-only atomic snapshot of registered profiles, readiness, quota
   freshness, and the daemon's `next_up` routing projection. `available/passed`
   on the exact selected row is the usable route evidence; `unknown`,
   `not_run`, or stale quota means uncertain, not absent. Never substitute
   aggregate doctor status, another profile's probe, or a host/default login.
   Never initiate login or OAuth merely because a row is unknown; ask the user
   for explicit authority. An explicit reviewer `credentialProfileId` is
   strict and never falls back, while an omitted id uses the canonical account
   pool.
3. Call `claudexor_capabilities` when the task depends on the current modes,
   mutability, controls, models, setup transport, or tool surface. For a
   concrete harness model list, use `claudexor models --harness <id>` through
   the CLI; `source: none` or an unavailable inventory is an honest refusal,
   not permission to guess a model. A declared `setupLogin` transport of
   `external_terminal` means the host must provide that client transport;
   never silently treat it as `in_app`.
4. Use `claudexor_ask` for read-only answers and bounded research, or
   `claudexor_plan` for a read-only implementation plan.
5. Only for explicit implementation intent, use `claudexor_run`,
   `claudexor_best_of`, or `claudexor_create`. Pass an absolute `repoPath`
   whenever the target repository could be ambiguous.

Run tools enqueue work and return a durable handle, not terminal output or
proof of completion. Use `claudexor_runs`, `claudexor_inspect`,
`claudexor_run_status`, and `claudexor_run_result` to recover and follow it.
Use `claudexor_run_interactions` to read pending questions and
`claudexor_answer_interaction` only with answers supplied or approved by the
user. Use `claudexor_run_cancel` only when cancellation is requested.

Use `claudexor_apply_check` to dry-check delivery. MCP does not apply a patch.
Only when the user explicitly requests delivery and the server-owned
`applyEligibility.eligible` value is true may the host invoke the ordinary
Claudexor CLI apply path under its normal command permission.

For an explicit reviewer panel, pass entries such as
`{"harness":"cursor","model":"grok-4.6","credentialProfileId":"review-cursor"}`.
The CLI equivalent is `--reviewer-panel-json '<array>'`; the legacy compact
`--reviewer-panel` form stays unpinned and should not be extended with an
escaping-sensitive profile syntax. After review, verify the observed profile
and route proof in the result artifacts.

Use `claudexor_journal_recovery` for read-only journal inspection, validation,
or export. `claudexor_quarantine_journal` is destructive: invoke it only after
the user explicitly requests quarantine and provides the exact fingerprint and
confirmation required by its schema.

## Safety

- NEVER paste live credentials into prompts. Ask the user to use
  `claudexor auth login <harness>` or `claudexor secrets set` outside the
  conversation; do not collect or transform credentials.
- NEVER auto-answer `claudexor decision` for a blocked run. Risk acceptance and
  overrides are human decisions, even when the calling host otherwise permits
  mutation.
- Do not infer success, applyability, readiness, or completion from model
  prose. Use the typed status, result, and `applyEligibility` projections.
- Do not claim native vendor sessions move between credential profiles.
