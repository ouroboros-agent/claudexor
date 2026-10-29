import Foundation
import Testing
@testable import ClaudexorKit

/// #450: a command result that left the command running in a background
/// shell, timed out, or reported an unrecognized outcome is not a finished
/// success. The envelopes mirror the `harness.event` rows the engine stores
/// (orchestrator `cursor-command-outcome.integration.test.ts`).
@Suite struct TranscriptCommandOutcomeTests {
    private func env(_ seq: Int, _ json: String) -> BusEnvelope {
        let value = try! JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        return BusEnvelope(seq: seq, kind: value["type"]?.stringValue ?? "message", event: value)
    }

    private func fold(_ tool: String, reducer: inout TranscriptReducer) -> ToolBlock? {
        reducer.apply(env(1, #"{"type":"harness.event","payload":{"type":"tool_call","tool":{"name":"shell","kind":"command","use_id":"c1","target":"find /repo -name '*.log'"}}}"#))
        reducer.apply(env(2, #"{"type":"harness.event","payload":{"type":"tool_result","tool":"# + tool + "}}"))
        guard reducer.blocks.count == 1, case .tool(_, let block) = reducer.blocks[0] else { return nil }
        return block
    }

    private func fold(_ tool: String) -> ToolBlock? {
        var reducer = TranscriptReducer()
        return fold(tool, reducer: &reducer)
    }

    @Test func unconfirmedCommandOutcomesAreNeverShownAsSuccess() {
        let outcomes = [
            #"{"state":"backgrounded","background_reason":"timeout","timeout_ms":30000,"shell_id":"3","pid":4242}"#,
            #"{"state":"timed_out","timeout_ms":30000}"#,
            #"{"state":"unknown"}"#,
            #"{"state":"suspended"}"#,
        ]
        for outcome in outcomes {
            let block = fold(#"{"name":"shell","kind":"command","use_id":"c1","status":"ok","command_outcome":"# + outcome + "}")
            #expect(block?.status.rawValue == "unconfirmed", "\(outcome)")
            #expect(block?.status == .unconfirmed, "\(outcome)")
            #expect(block?.exitCode == nil)
        }
    }

    @Test func theTypedFactsSurviveForPresentation() {
        let handoff = fold(#"{"name":"shell","kind":"command","use_id":"c1","status":"ok","command_outcome":{"state":"backgrounded","background_reason":"timeout","timeout_ms":30000,"shell_id":"3","pid":4242}}"#)
        #expect(handoff?.commandOutcome == ToolBlock.CommandOutcome(
            state: .backgrounded, timeoutMs: 30000, backgroundReason: .timeout, shellId: "3", pid: 4242))
        // A state from a newer engine is unknown, never an exit.
        let future = fold(#"{"name":"shell","kind":"command","use_id":"c1","status":"ok","command_outcome":{"state":"suspended","pid":0}}"#)
        #expect(future?.commandOutcome == ToolBlock.CommandOutcome(state: .unknown))
    }

    @Test func observedExitsErrorsAndLegacyResultsKeepTheirStatus() {
        let exited = fold(#"{"name":"shell","kind":"command","use_id":"c1","status":"ok","exit_code":0,"command_outcome":{"state":"exited"}}"#)
        #expect(exited?.status == .ok)
        #expect(exited?.exitCode == 0)
        #expect(fold(#"{"name":"shell","kind":"command","use_id":"c1","status":"ok"}"#)?.status == .ok)
        #expect(fold(#"{"name":"shell","kind":"command","use_id":"c1","status":"ok"}"#)?.commandOutcome == nil)
        let failed = fold(#"{"name":"shell","kind":"command","use_id":"c1","status":"error","exit_code":1,"command_outcome":{"state":"timed_out"}}"#)
        #expect(failed?.status == .error)
    }

    @Test func aStandaloneResultAfterReconnectIsStillUnconfirmed() {
        var reducer = TranscriptReducer()
        reducer.apply(env(5, #"{"type":"harness.event","payload":{"type":"tool_result","tool":{"name":"shell","kind":"command","use_id":"late","status":"ok","command_outcome":{"state":"timed_out","timeout_ms":30000}}}}"#))
        guard case .tool(_, let block) = reducer.blocks.first else { Issue.record("expected a tool block"); return }
        #expect(block.status == .unconfirmed)
        #expect(block.commandOutcome?.state == .timedOut)
    }

    @Test func theVendorShellHandleIsBoundedAndCounted() {
        var reducer = TranscriptReducer(cap: 200, blockCharCap: 1_000, totalCharBudget: 10_000, toolFieldCap: 16)
        let handle = String(repeating: "h", count: 500)
        let block = fold(#"{"name":"shell","kind":"command","use_id":"c1","status":"ok","command_outcome":{"state":"backgrounded","shell_id":""# + handle + #""}}"#, reducer: &reducer)
        #expect(block?.commandOutcome?.shellId?.count == 16)
        #expect(reducer.truncatedChars >= 500 - 16)
        // name + kind + the 16-character bounded target + the bounded handle.
        #expect(reducer.textChars == "shell".count + "command".count + 16 + 16)
    }
}
