import { describe, expect, it } from 'vitest';
import { buildIntentProofCutoverReport } from '@/orchestration/intentProofCutoverReport';

describe('intent proof cutover report', () => {
  it('computes baseline vs candidate metrics and emits GO when thresholds pass', () => {
    const report = buildIntentProofCutoverReport({
      metadata: {
        commitSha: 'abc1234',
        corpusRef: 'fixtures/cutover-corpus.json',
        baselineCommand: 'pnpm baseline',
        candidateCommand: 'pnpm candidate',
        baselineArtifactPath: '/tmp/baseline.json',
        candidateArtifactPath: '/tmp/candidate.json',
      },
      truth: {
        relations: [
          { subject: 'svc:a', relationType: 'calls', object: 'endpoint:x' },
          { subject: 'svc:b', relationType: 'reads', object: 'table:y' },
        ],
      },
      baseline: {
        label: 'legacy',
        relations: [
          { subject: 'svc:a', relationType: 'calls', object: 'endpoint:x' },
          { subject: 'svc:a', relationType: 'calls', object: 'endpoint:z' },
        ],
        frontiers: [
          { key: 'f-1', recoverable: true, recovered: false },
          { key: 'f-2', recoverable: false, recovered: false },
        ],
        approvalCount: 5,
      },
      candidate: {
        label: 'intent-proof',
        relations: [
          { subject: 'svc:a', relationType: 'calls', object: 'endpoint:x' },
          { subject: 'svc:b', relationType: 'reads', object: 'table:y' },
        ],
        frontiers: [
          { key: 'f-1', recoverable: true, recovered: true },
        ],
        approvalCount: 3,
      },
      thresholds: {
        minPrecisionDelta: 0.4,
        minRecallDelta: 0.5,
        minCandidateFrontierRecoverability: 1,
        maxApprovalCountDelta: 0,
      },
    });

    expect(report.metrics.baselinePrecision).toBe(0.5);
    expect(report.metrics.candidatePrecision).toBe(1);
    expect(report.metrics.precisionDelta).toBe(0.5);
    expect(report.metrics.baselineRecall).toBe(0.5);
    expect(report.metrics.candidateRecall).toBe(1);
    expect(report.metrics.candidateFrontierRecoverability).toBe(1);
    expect(report.metrics.approvalCountDelta).toBe(-2);
    expect(report.failedChecks).toEqual([]);
    expect(report.recommendation.decision).toBe('GO');
  });

  it('emits NO_GO when candidate fails thresholds or carries failed checks', () => {
    const report = buildIntentProofCutoverReport({
      metadata: {
        commitSha: 'abc1234',
        corpusRef: 'fixtures/cutover-corpus.json',
        baselineCommand: 'pnpm baseline',
        candidateCommand: 'pnpm candidate',
        baselineArtifactPath: '/tmp/baseline.json',
        candidateArtifactPath: '/tmp/candidate.json',
      },
      truth: {
        relations: [
          { subject: 'svc:a', relationType: 'calls', object: 'endpoint:x' },
        ],
      },
      baseline: {
        label: 'legacy',
        relations: [
          { subject: 'svc:a', relationType: 'calls', object: 'endpoint:x' },
        ],
        approvalCount: 1,
      },
      candidate: {
        label: 'intent-proof',
        relations: [],
        approvalCount: 4,
        failedChecks: ['candidate execution produced warnings'],
      },
      thresholds: {
        minPrecisionDelta: 0,
        minRecallDelta: 0,
        maxApprovalCountDelta: 0,
      },
    });

    expect(report.failedChecks).toEqual([
      '[candidate] candidate execution produced warnings',
      'recallDelta -1 fell below 0',
      'approvalCountDelta 3 exceeded 0',
    ]);
    expect(report.recommendation.decision).toBe('NO_GO');
  });
});
