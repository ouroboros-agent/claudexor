import Foundation
import ClaudexorKit

extension AppModel {
    func loadRunDetail(
        _ id: String,
        locationID requestedLocationID: ExecutionLocationID? = nil
    ) async {
        let locationID = requestedLocationID ?? selectedExecutionLocation
        if locationID != .local {
            await performRemoteRunDetailLoad(id, locationID: locationID)
            return
        }
        if let inFlight = runDetailLoads[id] {
            if runDetailAcceptingTrailing.contains(id) { runDetailTrailing.insert(id) }
            await inFlight.value
            return
        }
        runDetailAcceptingTrailing.insert(id)
        let load = Task { @MainActor [weak self] in
            guard let self else { return }
            self.runDetailTrailing.remove(id)
            await self.performRunDetailLoad(id)
            self.runDetailAcceptingTrailing.remove(id)
            if self.runDetailTrailing.remove(id) != nil {
                await self.performRunDetailLoad(id)
            }
            self.runDetailLoads[id] = nil
        }
        runDetailLoads[id] = load
        await load.value
    }

    private func performRemoteRunDetailLoad(
        _ id: String,
        locationID: ExecutionLocationID
    ) async {
        guard let requestClient = gateway(for: locationID),
              let original = remoteTasks[locationID]?.first(where: { $0.id == id })
        else { return }
        do {
            let detail = try await requestClient.runDetail(runId: id)
            guard selectedExecutionLocation == locationID,
                  let index = remoteTasks[locationID]?.firstIndex(where: { $0.id == id })
            else { return }
            var task = Self.liveTask(from: detail.summary)
            task.diff = original.diff
            task.operatorDecisionAction = detail.operatorDecisionAction
            task.outcomeBanner = detail.outcomeBanner
            task.applyEligibility = detail.applyEligibility
            task.planReadiness = detail.planReadiness
            task.planQuestions = detail.planQuestions
            task.council = detail.council
            task.pendingInteractions = detail.pendingInteractions
            task.waitingOnUser =
                detail.summary.waitingOnUser ?? !detail.pendingInteractions.isEmpty
            task.artifactPaths = detail.artifacts.map(\.path)
            if let planItems = RunDetailMapping.planItems(detail.planProgress) {
                task.plan = planItems
            }
            task.candidates = RunDetailMapping.candidates(
                detail.candidates, runPhase: task.phase)
            if let budget = detail.budget {
                if let cap = budget.maxUsd { task.capUsd = cap }
                if let spend = budget.spendUsd { task.spendUsd = spend }
                task.capKnown = budget.maxUsd != nil
                task.spendKnown = budget.spendUsd != nil
                task.spendEstimated = budget.estimated
                task.valuationUsd = budget.knownValuationUsd
            }
            if !detail.timeline.isEmpty {
                task.activity = detail.timeline.map(Self.activityEvent(from:))
            }
            if let primary = detail.primaryOutput,
               let text = primary.text,
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               primary.kind != "patch"
            {
                let rendered = primary.truncated == true
                    ? text
                        + "\n\n_Inline preview bounded; open \(primary.path) for the full output._"
                    : text
                if primary.kind == "diagnostic" {
                    task.diagnosticText = rendered
                } else {
                    task.answerText = rendered
                }
            }
            let failure = detail.failure ?? detail.summary.failure
            let findings = detail.reviewFindings.compactMap {
                Self.finding(from: $0, taskTitle: task.title)
            }
            if !findings.isEmpty { task.findings = findings }
            task.reviewVerdict = RunDetailMapping.reviewVerdict(
                decision: detail.decision,
                candidates: detail.candidates,
                findings: task.findings,
                failure: failure,
                phase: task.phase,
                outcomeFacts: task.outcomeFacts)
            task.diagnosticText = RunDiagnosticsPresentation.summary(
                detail: detail, error: task.engineError)
            remoteTasks[locationID]?[index] = task
        } catch {
            guard let index = remoteTasks[locationID]?.firstIndex(where: { $0.id == id })
            else { return }
            remoteTasks[locationID]?[index].engineError =
                "Could not load run detail: \(error)"
            remoteTasks[locationID]?[index].diagnosticText =
                remoteTasks[locationID]?[index].engineError
        }
    }

    private func performRunDetailLoad(_ id: String) async {
        guard let client, liveTasks.contains(where: { $0.id == id }) else { return }
        // Snapshot fence, write side: stream events arriving DURING this load
        // are deferred and re-applied after the snapshot lands. Without this,
        // the final `liveTasks[writeIdx] = task` write (built from a pre-await
        // copy) would erase them — and lastEventIds has already advanced past
        // their seq, so they would never be replayed.
        snapshotLoadDepth[id, default: 0] += 1
        defer {
            snapshotLoadDepth[id, default: 1] -= 1
            if snapshotLoadDepth[id] ?? 0 <= 0 {
                snapshotLoadDepth[id] = nil
                let deferred = deferredEnvelopes[id] ?? []
                deferredEnvelopes[id] = nil
                // Seq fence for the REPLAY too: the snapshot we just
                // merged reflects everything <= lastSeq; re-applying a
                // deferred envelope from that range would double-count spend
                // and duplicate timeline rows.
                let fence = snapshotReplayFences.removeValue(forKey: id) ?? 0
                for env in deferred where !(env.seq > 0 && env.seq <= fence) {
                    apply(env, to: id)
                }
                if deferredOverflow.remove(id) != nil {
                    // W23: envelopes were dropped at the cap — a replay would be
                    // incomplete, so a FRESH snapshot supersedes them instead.
                    Task { await self.loadRunDetail(id) }
                }
            }
        }
        do {
            let detail = try await client.runDetail(runId: id)
            // Re-resolve the row BY ID after the await: refreshes/inserts may
            // have reordered liveTasks, and a stale index would merge this
            // snapshot into (and copy hydrated fields from) a DIFFERENT run.
            guard let baseIdx = liveTasks.firstIndex(where: { $0.id == id }) else { return }
            // Concurrent detail loads race (release wave round-12): an OLDER
            // response resolving after a newer one must not roll the task
            // back — deferred events at or below the newer fence were already
            // consumed and cannot repair it. Older-than-fence responses are
            // no-ops.
            if detail.lastSeq < (snapshotReplayFences[id] ?? 0) { return }
            // Snapshot truth and stream progress are related but distinct: the
            // resume cursor may already be newer than this response.
            snapshotReplayFences[id] = max(snapshotReplayFences[id] ?? 0, detail.lastSeq)
            lastEventIds[id] = max(lastEventIds[id] ?? 0, detail.lastSeq)
            var task = liveTasks[baseIdx]
            task.phase = RunPhase(api: detail.summary.state)
            task.mode = RunMode(
                apiValue: detail.summary.mode,
                strategy: detail.summary.strategy)
            task.operatorDecisionAction = detail.operatorDecisionAction
            // v3 terminal-truth axes + Run Detail satellites (D8/D17/D18/D31):
            // the outcome facts, the server-owned banner rendered verbatim, the
            // single-producer apply eligibility, and plan/council projections.
            task.outcomeFacts = detail.summary.outcomeFacts ?? task.outcomeFacts
            task.outcomeBanner = detail.outcomeBanner
            task.applyEligibility = detail.applyEligibility
            task.planReadiness = detail.planReadiness
            task.planQuestions = detail.planQuestions
            task.council = detail.council
            if let result = detail.summary.result {
                task.applyState = result.applyState
                task.revertable = result.revertable
                task.adopted = result.adopted == true
            }
            task.prompt = detail.summary.prompt ?? task.prompt
            if !task.prompt.isEmpty { task.title = String(task.prompt.prefix(64)) }
            task.project =
                detail.summary.project?.projectName
                ?? detail.summary.project?.root.map {
                    URL(fileURLWithPath: $0).lastPathComponent
                }
                ?? task.project
            task.repoRoot = detail.summary.project?.root ?? task.repoRoot
            task.harnesses = (detail.summary.harnesses ?? []).compactMap {
                HarnessFamily(rawValue: $0)
            }
            task.applyPaidBudget(detail.summary.paidBudget)
            task.spendUsd = detail.summary.spendUsd ?? task.spendUsd
            task.spendKnown = detail.summary.spendUsd != nil || task.spendKnown
            task.spendEstimated = detail.summary.spendEstimated ?? task.spendEstimated
            let failure = detail.failure ?? detail.summary.failure
            task.engineError = failure?.safeMessage ?? detail.summary.error
            task.failureCategory = failure?.category
            task.runDir = detail.summary.runDir ?? failure?.runDir ?? task.runDir
            task.outputReadyState = detail.summary.outputReadyState
            task.pendingInteractions = detail.pendingInteractions
            task.waitingOnUser =
                detail.summary.waitingOnUser ?? !detail.pendingInteractions.isEmpty
            if let route = detail.summary.route {
                task.observedModel = route.observedModel
                task.routeProof = route.verified == true ? .verified : .unverified
            }
            task.authRoute = detail.summary.authRoute ?? task.authRoute
            task.requestedAccess = detail.summary.requestedAccess
            task.effectiveAccess = detail.summary.effectiveAccess
            task.externalContextPolicy = detail.summary.externalContextPolicy
            task.tests = detail.summary.tests ?? task.tests
            task.reviewerPanel = detail.summary.reviewerPanel
            task.protectedPathApprovals = detail.summary.protectedPathApprovals
            task.browserRequirementDetail = browserRequirementDetail(
                detail.summary.requestRequirements)
            if detail.summary.webEvidence?.available == false {
                task.webEvidenceStatus = nil
                task.webEvidenceDetail =
                    "Web/tool telemetry unavailable for this run "
                    + "(predates telemetry.yaml or still running)."
            } else {
                task.webEvidenceStatus = detail.summary.webEvidence?.status
                task.webEvidenceDetail = Self.webEvidenceDetail(detail.summary.webEvidence)
            }
            task.artifactPaths = detail.artifacts.map(\.path)
            // Live plan checklist + candidate cards: mapping owned
            // by RunDetailMapping.swift.
            if let planItems = RunDetailMapping.planItems(detail.planProgress) {
                task.plan = planItems
            }
            task.candidates = RunDetailMapping.candidates(
                detail.candidates, runPhase: task.phase)
            if let budget = detail.budget {
                if let cap = budget.maxUsd { task.capUsd = cap }
                if let spend = budget.spendUsd { task.spendUsd = spend }
                task.capKnown = budget.maxUsd != nil
                task.spendKnown = budget.spendUsd != nil
                task.spendEstimated = budget.estimated
                // QA-023c: the KNOWN subscription valuation only (unknown stays
                // absent, never a fabricated $0). Rendered beside cash so a $0
                // cash subscription run still shows what the work was worth.
                task.valuationUsd = budget.knownValuationUsd
            }
            // Seed the live box's spend from the snapshot (authoritative up to
            // lastSeq): post-fence budget.observation increments then add ON
            // TOP — same "seed from replay OR summary, never both" rule.
            if let box = liveBoxes[id], task.spendKnown {
                box.spendUsd = task.spendUsd
                box.spendKnown = true
                box.spendEstimated = task.spendEstimated
            }
            if let final = detail.finalSummary, !final.isEmpty,
               !task.activity.contains(where: { $0.title == "Final summary" })
            {
                task.activity.append(
                    ActivityEvent(.message, "Final summary", detail: final))
            }
            if let primary = detail.primaryOutput,
               let text = primary.text,
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                let displayedText = primary.truncated == true
                    ? text
                        + "\n\n_Inline preview bounded; open \(primary.path) for the full output._"
                    : text
                if primary.kind == "diagnostic" {
                    task.diagnosticText = displayedText
                    task.answerText = nil
                } else if primary.kind == "patch" {
                    // A raw diff is NEVER markdown-rendered as the Outcome; it
                    // belongs to the Diff tab (parsed below).
                    task.answerText = nil
                } else {
                    task.answerText = displayedText
                }
            } else {
                task.answerText = await firstArtifactText(
                    client: client,
                    runId: id,
                    paths: [
                        "final/answer.md", "final/explore.md", "final/report.md",
                        "final/plan.md", "final/summary.md",
                    ])
            }
            // Diff bytes are TAB-DEMAND payload (INV-136): hydration records
            // artifact existence; TaskDetail loads/parses only when Diff opens.
            if !detail.timeline.isEmpty {
                task.activity = detail.timeline.map(Self.activityEvent(from:))
                // A STREAMING run's feed lives in its box (views read the box
                // overlay): the snapshot timeline is authoritative up to
                // lastSeq, so it replaces the SSE-accumulated feed (the ring
                // counter resets with it — the server snapshot carries its own
                // truncation marker); deferred envelopes past the fence
                // re-append after this load.
                if let box = liveBoxes[id] {
                    box.activity = task.activity
                    box.activityDropped = 0
                }
            }
            task.diagnosticText = RunDiagnosticsPresentation.summary(
                detail: detail, error: task.engineError)
            let persistedFindings = detail.reviewFindings.compactMap {
                Self.finding(from: $0, taskTitle: task.title)
            }
            if !persistedFindings.isEmpty {
                task.findings = persistedFindings
            }
            task.reviewVerdict = RunDetailMapping.reviewVerdict(
                decision: detail.decision,
                candidates: detail.candidates,
                findings: task.findings,
                failure: failure,
                phase: task.phase,
                outcomeFacts: task.outcomeFacts)
            if !detail.artifacts.isEmpty, task.plan.isEmpty, task.mode == .plan {
                // Only the actual SpecPack artifact is a "plan" row; arbitrary
                // nested paths must not be synthesized into plan steps.
                task.plan = detail.artifacts
                    .filter { $0.kind == "file" && $0.path == "final/plan.md" }
                    .map {
                        PlanItem(
                            $0.path, .done,
                            note: $0.bytes.map { "\($0) bytes" })
                    }
            }
            // Re-resolve the row index at WRITE time: streams/refreshes may have
            // inserted or removed rows during the awaits above.
            if let writeIdx = liveTasks.firstIndex(where: { $0.id == id }) {
                liveTasks[writeIdx] = task
            }
        } catch {
            if let index = liveTasks.firstIndex(where: { $0.id == id }) {
                liveTasks[index].engineError = "Could not load run detail: \(error)"
                liveTasks[index].diagnosticText = liveTasks[index].engineError
                liveTasks[index].updatedAt = .now
            }
        }
    }

    private func firstArtifactText(
        client: GatewayClient,
        runId: String,
        paths: [String]
    ) async -> String? {
        for path in paths {
            if let text = try? await client.artifactText(runId: runId, path: path),
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                let limit = 256_000
                return text.count > limit
                    ? String(text.prefix(limit))
                        + "\n\n_Inline preview bounded; open \(path) for the full artifact._"
                    : text
            }
        }
        return nil
    }

    private static func activityEvent(from event: TimelineEvent) -> ActivityEvent {
        let kind: ActivityKind
        if event.type.contains("review") || event.type.contains("finding") {
            kind = .review
        } else if event.type.contains("gate") {
            kind = .gate
        } else if event.type.contains("harness") {
            let lowered = (event.detail ?? event.title).lowercased()
            kind =
                lowered.contains("file") ? .file
                : lowered.contains("tool") ? .tool
                : lowered.contains("think") ? .thinking : .message
        } else {
            kind = .system
        }
        // QA-070: disclose unsupported per-harness knobs the route could NOT honor
        // (INV-105) as a warning-shaped Activity detail — the wire already sets
        // severity=warning on the harness.started row, so a dropped max_turns /
        // tools / effort limit is visible, not a benign-looking start.
        let ignored = (event.ignoredSettings ?? []).isEmpty
            ? nil
            : "Ignored (unsupported by this harness): "
                + (event.ignoredSettings ?? []).joined(separator: "; ")
        let detailParts = [
            event.detail,
            ignored,
            event.target.map { "target: \($0)" },
            event.errorSummary.map { "error: \($0)" },
        ]
        .compactMap { $0 }
        .filter { !$0.isEmpty }
        return ActivityEvent(
            kind,
            harness: event.harnessId.flatMap { HarnessFamily(rawValue: $0) },
            event.title,
            detail: detailParts.isEmpty ? nil : detailParts.joined(separator: "\n"),
            severity: event.severity,
            code: event.rawRef,
            at: parseEventDate(event.ts) ?? .now)
    }
}
