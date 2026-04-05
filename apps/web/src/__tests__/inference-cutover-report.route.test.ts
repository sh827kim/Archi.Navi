// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  getInferenceRunDetailMock,
  buildIntentProofCutoverReportMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getInferenceRunDetailMock: vi.fn(),
  buildIntentProofCutoverReportMock: vi.fn(() => ({
    version: 'intent-proof-cutover-report-v1',
    generatedAt: '2026-04-01T00:00:00.000Z',
    metadata: {
      commitSha: 'abc1234',
      corpusRef: 'fixtures/cutover.json',
      baselineCommand: 'pnpm baseline',
      candidateCommand: 'pnpm candidate',
      baselineArtifactPath: '/tmp/baseline.json',
      candidateArtifactPath: '/tmp/candidate.json',
    },
    metrics: {
      truthRelationCount: 1,
      baselineRelationCount: 1,
      candidateRelationCount: 1,
      baselineTruePositives: 1,
      candidateTruePositives: 1,
      baselineFalsePositives: 0,
      candidateFalsePositives: 0,
      baselineFalseNegatives: 0,
      candidateFalseNegatives: 0,
      baselinePrecision: 1,
      candidatePrecision: 1,
      precisionDelta: 0,
      baselineRecall: 1,
      candidateRecall: 1,
      recallDelta: 0,
      baselineFrontierRecoverability: null,
      candidateFrontierRecoverability: null,
      frontierRecoverabilityDelta: null,
      baselineApprovalCount: 1,
      candidateApprovalCount: 1,
      approvalCountDelta: 0,
    },
    failedChecks: [],
    recommendation: {
      decision: 'GO',
      reasons: ['ok'],
    },
  })),
}));

vi.mock('@archi-navi/db', async () => {
  const actual = await vi.importActual<typeof import('@archi-navi/db')>('@archi-navi/db');
  return {
    ...actual,
    getDb: getDbMock,
  };
});

vi.mock('@archi-navi/inference', async () => {
  const actual = await vi.importActual<typeof import('@archi-navi/inference')>('@archi-navi/inference');
  return {
    ...actual,
    buildIntentProofCutoverReport: buildIntentProofCutoverReportMock,
    getInferenceRunDetail: getInferenceRunDetailMock,
  };
});

import { POST } from '@/app/api/inference/cutover-report/route';

describe('POST /api/inference/cutover-report', () => {
  afterEach(() => {
    delete process.env['INFERENCE_RUNS_API_TOKEN'];
    vi.clearAllMocks();
  });

  it('returns a cutover report for a valid authenticated request', async () => {
    process.env['INFERENCE_RUNS_API_TOKEN'] = 'secret-token';

    const response = await POST(new Request('http://localhost/api/inference/cutover-report', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        metadata: {
          commitSha: 'abc1234',
          corpusRef: 'fixtures/cutover.json',
          baselineCommand: 'pnpm baseline',
          candidateCommand: 'pnpm candidate',
          baselineArtifactPath: '/tmp/baseline.json',
          candidateArtifactPath: '/tmp/candidate.json',
        },
        truth: {
          relations: [{ subject: 'svc:a', relationType: 'calls', object: 'endpoint:x' }],
        },
        baseline: {
          label: 'legacy',
          relations: [{ subject: 'svc:a', relationType: 'calls', object: 'endpoint:x' }],
          approvalCount: 1,
        },
        candidate: {
          label: 'intent-proof',
          relations: [{ subject: 'svc:a', relationType: 'calls', object: 'endpoint:x' }],
          approvalCount: 1,
        },
      }),
    }) as never);

    expect(response.status).toBe(200);
    expect(buildIntentProofCutoverReportMock).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ commitSha: 'abc1234' }),
      baseline: expect.objectContaining({ label: 'legacy' }),
      candidate: expect.objectContaining({ label: 'intent-proof' }),
    }));
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      report: {
        version: 'intent-proof-cutover-report-v1',
        recommendation: { decision: 'GO' },
      },
    });
  });

  it('rejects malformed payloads before invoking the report builder', async () => {
    process.env['INFERENCE_RUNS_API_TOKEN'] = 'secret-token';

    const response = await POST(new Request('http://localhost/api/inference/cutover-report', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        metadata: {
          commitSha: '',
          corpusRef: 'fixtures/cutover.json',
          baselineCommand: 'pnpm baseline',
          candidateCommand: 'pnpm candidate',
          baselineArtifactPath: '/tmp/baseline.json',
          candidateArtifactPath: '/tmp/candidate.json',
        },
        truth: { relations: [] },
        baseline: { label: 'legacy', relations: [] },
        candidate: { label: 'intent-proof', relations: [] },
      }),
    }) as never);

    expect(response.status).toBe(400);
    expect(buildIntentProofCutoverReportMock).not.toHaveBeenCalled();
  });

  it('loads stored cutover artifacts from run ids when given a run-backed request', async () => {
    process.env['INFERENCE_RUNS_API_TOKEN'] = 'secret-token';
    getDbMock.mockResolvedValue({ db: 'mock' });
    getInferenceRunDetailMock
      .mockResolvedValueOnce({
        run: {
          id: 'baseline-run',
          stats: {
            cutoverArtifact: {
              label: 'legacy',
              relations: [{ subject: 'svc:a', relationType: 'calls', object: 'endpoint:x' }],
              approvalCount: 1,
            },
          },
        },
      })
      .mockResolvedValueOnce({
        run: {
          id: 'candidate-run',
          stats: {
            cutoverArtifact: {
              label: 'intent-proof',
              relations: [{ subject: 'svc:a', relationType: 'calls', object: 'endpoint:x' }],
              approvalCount: 1,
            },
          },
        },
      });

    const response = await POST(new Request('http://localhost/api/inference/cutover-report', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        baselineRunId: 'baseline-run',
        candidateRunId: 'candidate-run',
        metadata: {
          commitSha: 'abc1234',
          corpusRef: 'fixtures/cutover.json',
          baselineCommand: 'pnpm baseline',
          candidateCommand: 'pnpm candidate',
          baselineArtifactPath: 'run:baseline-run',
          candidateArtifactPath: 'run:candidate-run',
        },
        truth: {
          relations: [{ subject: 'svc:a', relationType: 'calls', object: 'endpoint:x' }],
        },
      }),
    }) as never);

    expect(response.status).toBe(200);
    expect(getInferenceRunDetailMock).toHaveBeenNthCalledWith(1, { db: 'mock' }, {
      workspaceId: 'ws-1',
      runId: 'baseline-run',
    });
    expect(getInferenceRunDetailMock).toHaveBeenNthCalledWith(2, { db: 'mock' }, {
      workspaceId: 'ws-1',
      runId: 'candidate-run',
    });
    expect(buildIntentProofCutoverReportMock).toHaveBeenCalledWith(expect.objectContaining({
      baseline: expect.objectContaining({ label: 'legacy' }),
      candidate: expect.objectContaining({ label: 'intent-proof' }),
    }));
  });
});
