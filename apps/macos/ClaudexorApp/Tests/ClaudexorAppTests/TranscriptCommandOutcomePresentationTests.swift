import AppKit
import Foundation
import SwiftUI
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// #450: the flat transcript must never present a command that is still
/// running in a background shell (or timed out) as one more finished call.
@MainActor
@Suite struct TranscriptCommandOutcomePresentationTests {
    private func env(_ seq: Int, _ json: String) -> BusEnvelope {
        let value = try! JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        return BusEnvelope(seq: seq, kind: value["type"]?.stringValue ?? "message", event: value)
    }

    /// Three finished shell calls, then one moved to a background shell after
    /// its 30 s timeout: the handoff must stand alone, not join a quiet
    /// «shell · 4 calls» group of finished calls.
    @Test func aBackgroundHandoffNeverJoinsTheFinishedToolGroup() {
        var reducer = TranscriptReducer()
        var seq = 1
        for index in 0..<4 {
            reducer.apply(env(seq, #"{"type":"harness.event","payload":{"type":"tool_call","tool":{"name":"shell","kind":"command","use_id":"c\#(index)","target":"find /workspace"}}}"#))
            seq += 1
            let outcome = index == 3
                ? #"{"state":"backgrounded","background_reason":"timeout","timeout_ms":30000,"shell_id":"3","pid":4242}"#
                : #"{"state":"exited"}"#
            reducer.apply(env(seq, #"{"type":"harness.event","payload":{"type":"tool_result","tool":{"name":"shell","kind":"command","use_id":"c\#(index)","status":"ok","command_outcome":"# + outcome + "}}}"))
            seq += 1
        }
        let rows = TranscriptPresentation.rows(reducer.blocks)
        #expect(rows.count == 4)
        if case .tool(_, let tool) = rows.last {
            #expect(tool.status.rawValue == "unconfirmed")
        } else {
            Issue.record("the background handoff must stand alone")
        }
    }

    /// The same words as the engine's `commandOutcomeLabel` (schema
    /// `tool-ref.test.ts` pins the identical strings): one vocabulary.
    @Test func theNoteUsesTheEngineVocabulary() {
        typealias Outcome = ToolBlock.CommandOutcome
        #expect(ToolRow.commandNote(Outcome(state: .backgrounded, timeoutMs: 30000, backgroundReason: .timeout,
                                            shellId: "3", pid: 4242))
                == "Moved to background after 30s · still running · shell 3 · pid 4242")
        #expect(ToolRow.commandNote(Outcome(state: .backgrounded, backgroundReason: .timeout))
                == "Moved to background after its timeout · still running")
        #expect(ToolRow.commandNote(Outcome(state: .backgrounded, timeoutMs: 0, backgroundReason: .timeout))
                == "Running in background")
        #expect(ToolRow.commandNote(Outcome(state: .backgrounded, backgroundReason: .requested, pid: 7))
                == "Running in background · pid 7")
        #expect(ToolRow.commandNote(Outcome(state: .timedOut, timeoutMs: 90000))
                == "Timed out after 1m 30s · exit status unknown")
        #expect(ToolRow.commandNote(Outcome(state: .timedOut)) == "Timed out · exit status unknown")
        #expect(ToolRow.commandNote(Outcome(state: .unknown)) == "Command outcome not reported")
        #expect(ToolRow.commandNote(nil) == "Command outcome not reported")
    }

    /// Reuses the app's warning mark and caution tone: never the success
    /// check, the failure cross, or a spinner that would never stop.
    @Test func theUnconfirmedGlyphIsARealDistinctWarningMark() {
        let glyph = ToolRow.statusGlyph(.unconfirmed)
        #expect(NSImage(systemSymbolName: glyph, accessibilityDescription: nil) != nil)
        #expect(Set([ToolRow.statusGlyph(.running), ToolRow.statusGlyph(.ok), ToolRow.statusGlyph(.error)])
            .contains(glyph) == false)
        for scheme in [ColorScheme.light, .dark] {
            var environment = EnvironmentValues()
            environment.colorScheme = scheme
            #expect(ToolRow.statusColor(.unconfirmed).resolve(in: environment)
                    == Theme.status(.caution).resolve(in: environment))
        }
    }
}

/// The rows the engine stores for the synthetic Cursor shell fixture,
/// generated from the Cursor normalizer and the orchestrator's `harness.event`
/// projection by `scripts/gen-cursor-transcript-fixture.ts` (kept fresh by
/// `pnpm fixtures:swift:check`; the orchestrator integration test proves the
/// tool rows equal those a real run persisted).
@MainActor
enum CursorTranscriptReplay {
    private struct Fixture: Decodable {
        let generatedBy: [String]
        let rows: [JSONValue]
    }

    static func rows() throws -> [JSONValue] {
        let url = try #require(
            Bundle.module.url(forResource: "cursor-command-outcome-transcript", withExtension: "json"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        #expect(fixture.generatedBy == ["createCursorParser", "harnessEventPayload"])
        return fixture.rows
    }

    /// Fold the stored rows in order through the app's reducer, optionally
    /// only the first `count` of them (a mid-run snapshot).
    static func reducer(_ rows: [JSONValue], first count: Int? = nil) -> TranscriptReducer {
        var reducer = TranscriptReducer()
        for row in rows.prefix(count ?? rows.count) {
            let seq = Int(row["seq"]?.doubleValue ?? 0)
            reducer.apply(BusEnvelope(seq: seq, kind: row["type"]?.stringValue ?? "", event: row))
        }
        return reducer
    }

    /// The number of rows up to and including the stored call of `useId`.
    static func rowsThroughCall(_ useId: String, in rows: [JSONValue]) -> Int? {
        rows.firstIndex {
            $0["payload"]?["type"]?.stringValue == "tool_call"
                && $0["payload"]?["tool"]?["use_id"]?.stringValue == useId
        }.map { $0 + 1 }
    }

    static func tools(_ rows: [TranscriptPresentation.Row]) -> [ToolBlock] {
        rows.compactMap { row in
            if case .tool(_, let tool) = row { return tool }
            return nil
        }
    }
}

@MainActor
@Suite struct CursorTranscriptReplayTests {
    @Test func storedCursorRowsFoldIntoAnHonestFlatTranscript() throws {
        let stored = try CursorTranscriptReplay.rows()
        let blocks = CursorTranscriptReplay.reducer(stored).blocks
        let rows = TranscriptPresentation.chatRows(blocks).rows
        let tools = CursorTranscriptReplay.tools(rows)
        // One narration line; each of the seven shell calls stands on its own
        // (the typed final answer is the answer bubble, never a transcript row).
        #expect(rows.count == 8)
        #expect(!rows.contains { if case .toolGroup = $0 { true } else { false } })
        #expect(tools.map(\.target) == ["ls", "pnpm test", "find /repo -name '*.log'", "pnpm dev",
                                        "sleep 120", "pnpm build", "missing-tool --version"])
        #expect(tools.map(\.status) == [.ok, .error, .unconfirmed, .unconfirmed, .unconfirmed, .error, .error])
        #expect(tools.map(\.exitCode) == [0, 1, nil, nil, nil, nil, nil])
        #expect(TurnPresentation.activitySummary(blocks: blocks) == "7 tools")
    }

    /// The Swift note and the engine's own stored result text name the same
    /// state for every unconfirmed command of the replay.
    @Test func everyUnconfirmedNoteMatchesTheStoredEngineText() throws {
        let stored = try CursorTranscriptReplay.rows()
        var engineText: [String: String] = [:]
        for row in stored where row["payload"]?["type"]?.stringValue == "tool_result" {
            if let target = row["payload"]?["tool"]?["target"]?.stringValue,
               let text = row["payload"]?["text"]?.stringValue {
                engineText[target] = text
            }
        }
        let prefix = "tool_result: "
        let unconfirmed = CursorTranscriptReplay.tools(
            TranscriptPresentation.rows(CursorTranscriptReplay.reducer(stored).blocks))
            .filter { $0.status == .unconfirmed }
        #expect(unconfirmed.count == 3)
        for tool in unconfirmed {
            let text = try #require(engineText[tool.target ?? ""])
            #expect(text.hasPrefix(prefix))
            #expect(ToolRow.commandNote(tool.commandOutcome) == String(text.dropFirst(prefix.count)))
        }
    }

    /// Mid-run, a command still in its first 30 s keeps the spinner while an
    /// earlier handoff already reads as unconfirmed; the collapsed receipt
    /// line follows the newest call.
    @Test func midRunTheRunningCallAndTheHandoffStayDistinct() throws {
        let stored = try CursorTranscriptReplay.rows()
        let cut = try #require(CursorTranscriptReplay.rowsThroughCall("c-bg-request", in: stored))
        let blocks = CursorTranscriptReplay.reducer(stored, first: cut).blocks
        let tools = CursorTranscriptReplay.tools(TranscriptPresentation.rows(blocks))
        #expect(tools.map(\.status) == [.ok, .error, .unconfirmed, .running])
        #expect(TurnPresentation.lastActivityLine(blocks: blocks) == "pnpm pnpm dev")
    }
}

/// Opt-in pictures of the replayed transcript (no app model, daemon,
/// network, credentials or provider action; the window is never shown; the
/// output directory is explicit).
@MainActor @Suite(.serialized)
struct TranscriptCommandOutcomeRenderingTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CX_TOOL_ROW_RENDER_QA"] == "1"))
    func replayedTranscriptInBothAppearances() async throws {
        let output = try #require(ProcessInfo.processInfo.environment["CX_TOOL_ROW_RENDER_OUTPUT"])
        let application = NSApplication.shared
        let previousPolicy = application.activationPolicy()
        application.setActivationPolicy(.prohibited)
        defer { application.setActivationPolicy(previousPolicy) }
        let stored = try CursorTranscriptReplay.rows()
        let cut = try #require(CursorTranscriptReplay.rowsThroughCall("c-bg-request", in: stored))
        let scenes = [("mid-run", CursorTranscriptReplay.reducer(stored, first: cut).blocks),
                      ("settled", CursorTranscriptReplay.reducer(stored).blocks)]
        let width: CGFloat = 640, height: CGFloat = 300
        for (scene, blocks) in scenes {
            for (name, appearance, scheme) in [("light", NSAppearance.Name.aqua, ColorScheme.light),
                                                ("dark", .darkAqua, .dark)] {
                let content = VStack(alignment: .leading) {
                    TranscriptView(blocks: blocks)
                    Spacer(minLength: 0)
                }
                .padding(Theme.Spacing.lg)
                .frame(width: width, height: height)
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, scheme)
                .environment(\.locale, Locale(identifier: "en_US_POSIX"))
                let host = NSHostingView(rootView: content)
                let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                                      styleMask: [.borderless], backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.contentView = host
                host.frame = NSRect(x: 0, y: 0, width: width, height: height)
                host.appearance = NSAppearance(named: appearance)
                host.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(150))
                host.displayIfNeeded()
                let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                let png = try #require(bitmap.representation(using: .png, properties: [:]))
                let directory = URL(fileURLWithPath: output, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try png.write(to: directory.appendingPathComponent("transcript-\(scene)-\(name).png"))
                #expect(!window.isVisible && !window.isKeyWindow)
                window.close()
            }
        }
    }
}
