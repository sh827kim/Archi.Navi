import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IntentProofBenchmarkBaseline } from '@/orchestration';
import {
  evaluateIntentProofBenchmarkReport,
  runIntentProofBenchmarkGate,
} from '@/orchestration';

const BASELINE_FIXTURE = join(
  process.cwd(),
  'src/__tests__/fixtures/intent-proof-benchmark-baseline.v1.json',
);
const BENCHMARK_GATE_TIMEOUT_MS = 15_000;
const BENCHMARK_GATE_MAX_RUNTIME_MS = 10_000;
const EXPECTED_SCENARIO_COUNT = 10;

describe('intent proof benchmark gate', () => {
  it(
    'restored benchmark gate stays at or above the ARC-16 baseline',
    async () => {
      const startedAt = Date.now();
      const baselineRaw = await readFile(BASELINE_FIXTURE, 'utf8');
      const baseline = JSON.parse(baselineRaw) as IntentProofBenchmarkBaseline;

      const report = await runIntentProofBenchmarkGate();
      const evaluation = evaluateIntentProofBenchmarkReport(report, baseline);
      const elapsedMs = Date.now() - startedAt;

      if (!evaluation.passed) {
        console.error(JSON.stringify(report, null, 2));
      } else {
        console.info(
          `[benchmark-gate] scenarios=${report.metrics.passedScenarios}/${report.metrics.totalScenarios} passRate=${report.metrics.scenarioPassRate} candidates=${report.metrics.candidateExpectationRate} frontier=${report.metrics.frontierExpectationRate} rejected=${report.metrics.rejectedExpectationRate} acceptedPatch=${report.metrics.acceptedPatchRate} rejectedPatch=${report.metrics.rejectedPatchRate} elapsedMs=${elapsedMs}`,
        );
      }

      expect(report.metrics.totalScenarios).toBe(EXPECTED_SCENARIO_COUNT);
      expect(elapsedMs).toBeLessThan(BENCHMARK_GATE_MAX_RUNTIME_MS);
      expect(evaluation.failures).toEqual([]);
    },
    BENCHMARK_GATE_TIMEOUT_MS,
  );
});
