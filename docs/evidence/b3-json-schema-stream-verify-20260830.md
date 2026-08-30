# B3 live-verify receipt (2026-08-30, claude CLI 2.1.221, profile claude-proton-claude scoped CLAUDE_CONFIG_DIR, model claude-haiku-4-5-20251001, temp HOME, fresh git repo cwd)

## Probe 1: --json-schema x one-shot -p (readonly --tools Read,Glob,Grep)
Command: claude -p "Reply with answer='ok' and confidence=0.9" --json-schema '{"type":"object","properties":{"answer":{"type":"string"},"confidence":{"type":"number"}},"required":["answer","confidence"],"additionalProperties":false}' --output-format json --tools Read,Glob,Grep
Result: terminal_reason=completed, structured_output={"answer":"ok","confidence":0.9}, result='{"answer":"ok","confidence":0.9}' — PASS.

## Probe 2: --json-schema x stream-json (interactive transport shape)
Command: printf '<user frame>' | claude -p --input-format stream-json --output-format stream-json --verbose --json-schema '<same schema>' --tools Read,Glob,Grep
Result: assistant frame carries tool_use name=StructuredOutput input={"answer":"stream-ok","confidence":0.8} conforming to the schema; terminal result frame is_error:false — PASS.

Conclusion: the outputSchema x interactive refusal (orchestrator.ts:1556-1577, DT2.1-16) guards a combination the CLI now supports on BOTH transports. The refusal can be deleted without transport rerouting; AskUserQuestion is preserved on schema runs. The adapter's interactive path must pass --json-schema and read the structured result from the stream (verify in code during X-4).
