#!/usr/bin/env node
// Task-only instrumentation of the unchanged native acceptance scenario.
// Adds evidence before its existing cleanup; no runtime or oracle changes.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(process.argv[2]);
const report = resolve(process.argv[3]);
const expected = process.argv[4];
const git = (...args) => execFileSync('git', ['--no-optional-locks', '-C', root, ...args], { encoding: 'utf8' }).trim();
if (git('rev-parse', 'HEAD') !== expected) throw new Error('Unexpected diagnostic subject');
if (git('status', '--porcelain')) throw new Error('Subject is not clean before instrumentation');
const file = join(root, 'packages/harness-agy/src/win32-print-acceptance.test.ts');
const source = readFileSync(file, 'utf8');
let text = source;
const replacements = [
  ['import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";',
   'import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";'],
  ['    let summary: AcceptanceSummary | null = null;\n    try {\n      let completed: CollectedChild;',
   '    let summary: AcceptanceSummary | null = null;\n    let completed: CollectedChild | null = null;\n    try {'],
  ['    } finally {\n      const exactPids = new Set<number>([hostPid]);',
   `    } finally {
      // Only fixture-owned typed facts. Never OAuth input/URL, environment or raw output.
      // Diagnostic failure cannot prevent the original process cleanup.
      try {
        const diagnostic = {
          subject: process.env.CX_WINDOWS455_SUBJECT,
          node: process.version,
          platform: process.platform,
          hostPid,
          resultExists: existsSync(resultPath),
          summaryOk: summary?.ok ?? null,
          stage: summary?.stage ?? null,
          error: summary?.error ?? null,
          hostExit: completed?.code ?? null,
          hostSignal: completed?.signal ?? null,
          stdoutBytes: completed ? Buffer.byteLength(completed.stdout) : null,
          stderrBytes: completed ? Buffer.byteLength(completed.stderr) : null,
          inApp: inAppTimeoutDiagnostics(root, summary),
        };
        const reportDir = process.env.CX_WINDOWS455_REPORT_DIR;
        if (!reportDir) throw new Error("Diagnostic directory missing");
        mkdirSync(reportDir, { recursive: true });
        writeFileSync(join(reportDir, "native-observation.json"), JSON.stringify(diagnostic, null, 2) + "\\n");
        console.error("WINDOWS455_OBSERVATION " + JSON.stringify(diagnostic));
      } catch (error) {
        console.error("WINDOWS455_DIAGNOSTIC_ERROR " + String(error));
      }
      const exactPids = new Set<number>([hostPid]);`],
];
for (const [before, after] of replacements) {
  if (text.split(before).length !== 2) throw new Error('Instrumentation anchor changed');
  text = text.replace(before, after);
}
mkdirSync(report, { recursive: true });
writeFileSync(file, text);
const hash = (data) => createHash('sha256').update(data).digest('hex');
writeFileSync(join(report, 'subject.json'), JSON.stringify({
  head: expected,
  tree: git('rev-parse', 'HEAD^{tree}'),
  source_sha256: hash(source),
  instrumented_sha256: hash(text),
  node: process.version,
  platform: process.platform,
  purpose: 'One native Windows2022/Node24.15 scenario, evidence-only instrumentation; not a full CI or release result',
}, null, 2) + '\n');
writeFileSync(join(report, 'instrumentation.diff'), git('diff', '--', 'packages/harness-agy/src/win32-print-acceptance.test.ts') + '\n');
console.log('WINDOWS455_EXACT_SUBJECT_INSTRUMENTED ' + expected);
