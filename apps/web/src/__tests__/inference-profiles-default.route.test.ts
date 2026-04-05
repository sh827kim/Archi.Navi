// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getDbMock, domainInferenceProfilesMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  domainInferenceProfilesMock: {
    id: 'domain_inference_profiles.id',
    workspaceId: 'domain_inference_profiles.workspace_id',
    isDefault: 'domain_inference_profiles.is_default',
  },
}));

vi.mock('@archi-navi/db', () => ({
  getDb: getDbMock,
  domainInferenceProfiles: domainInferenceProfilesMock,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
}));

import { GET, PUT } from '@/app/api/inference/profiles/default/route';

function createDefaultProofConfidence() {
  return {
    name: 'intent-proof-default',
    version: 'v1',
    weights: {
      summaryQuality: 0.45,
      slotCompleteness: 0.25,
      corroborationPerSignal: 0.05,
      corroborationCap: 0.2,
      contradictionPenaltyPerItem: 0.2,
      contradictionPenaltyCap: 0.6,
    },
    slotWeights: {
      http: {
        method: 0.2,
        externalPath: 0.2,
        internalPath: 0.2,
        providerService: 0.2,
        targetObject: 0.2,
      },
      db: {
        action: 0.25,
        table: 0.25,
        schema: 0.15,
        datasource: 0.1,
        targetObject: 0.25,
      },
      message: {
        channel: 0.4,
        broker: 0.2,
        objectType: 0.15,
        targetObject: 0.25,
      },
    },
  };
}

function createDefaultSmartProofConfig() {
  return {
    enabled: false,
    categories: {
      preResolutionEnhancement: false,
      frontierResolution: true,
      ambiguityResolution: false,
      crossProofCorrelation: false,
      contradictionDetection: false,
    },
    budget: {
      maxLlmCallsPerRun: 100,
      maxLlmCallsPerIntent: 5,
      maxInputTokensPerCall: 4000,
      maxTotalTokensPerRun: 500000,
    },
    thresholds: {
      autoAcceptConfidence: 0.8,
      reviewConfidence: 0.5,
      skipConfidence: 0.3,
    },
    temperature: 0.1,
  };
}

function createProfileRow() {
  return {
    id: 'profile-1',
    workspaceId: 'ws-1',
    name: 'default',
    kind: 'NAMED',
    isDefault: true,
    wCode: 0.5,
    wDb: 0.3,
    wMsg: 0.2,
    secondaryThreshold: 0.25,
    minClusterSize: 3,
    resolution: 1,
    edgeWCall: 1,
    edgeWRw: 0.8,
    edgeWMsg: 0.6,
    enabledLayers: ['call', 'db', 'msg', 'code'],
  };
}

function createProfileBaseRow(row: ReturnType<typeof createProfileRow>) {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    name: row.name,
    kind: row.kind,
    is_default: row.isDefault,
    w_code: row.wCode,
    w_db: row.wDb,
    w_msg: row.wMsg,
    secondary_threshold: row.secondaryThreshold,
    min_cluster_size: row.minClusterSize,
    resolution: row.resolution,
    edge_w_call: row.edgeWCall,
    edge_w_rw: row.edgeWRw,
    edge_w_msg: row.edgeWMsg,
    enabled_layers: row.enabledLayers,
  };
}

function getExecutedSql(mock: { mock: { calls: unknown[][] } }, index: number): { strings: string[] } {
  const statement = mock.mock.calls[index]?.[0];
  expect(statement).toBeDefined();
  return statement as { strings: string[] };
}

function createMissingColumnError(column: string) {
  return Object.assign(new Error(`column "${column}" does not exist`), { code: '42703' });
}

function createTransactionDb(
  current: ReturnType<typeof createProfileRow>,
  updated: ReturnType<typeof createProfileRow>,
  currentState: {
    cross_validation: unknown;
    proof_confidence_config?: unknown;
    smart_proof_config?: unknown;
    feedback_config: unknown;
    feedback_adjustments: unknown;
    domain_feedback_config: unknown;
    domain_feedback_adjustments: unknown;
  },
  updatedState: {
    cross_validation: unknown;
    proof_confidence_config?: unknown;
    smart_proof_config?: unknown;
    feedback_config: unknown;
    feedback_adjustments: unknown;
    domain_feedback_config: unknown;
    domain_feedback_adjustments: unknown;
  },
) {
  const executeMock = vi.fn()
    .mockResolvedValueOnce({ rows: [createProfileBaseRow(current)] })
    .mockResolvedValueOnce({ rows: [currentState] })
    .mockResolvedValueOnce({ rows: [createProfileBaseRow(updated)] })
    .mockResolvedValueOnce({ rows: [updatedState] });
  const transactionExecuteMock = vi.fn(async () => undefined);

  return {
    db: {
      select: vi.fn(),
      execute: executeMock,
      transaction: async (callback: (tx: {
        update: (table: unknown) => {
          set: (payload: unknown) => { where: () => Promise<void> };
        };
        execute: (statement: unknown) => Promise<void>;
      }) => Promise<void>) => {
        await callback({
          update: () => ({
            set: () => ({ where: async () => undefined }),
          }),
          execute: transactionExecuteMock,
        });
      },
    },
    transactionExecuteMock,
  };
}

describe('inference profile default route', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('GET은 relation/domain feedback 설정이 없을 때 분리된 기본값과 빈 summary를 반환해야 한다', async () => {
    const row = createProfileRow();
    const db = {
      select: vi.fn(),
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [createProfileBaseRow(row)] })
        .mockResolvedValueOnce({
          rows: [{
            cross_validation: null,
            smart_proof_config: null,
            feedback_config: null,
            feedback_adjustments: null,
            domain_feedback_config: null,
            domain_feedback_adjustments: null,
          }],
        }),
    };
    getDbMock.mockResolvedValue(db);

    const response = await GET(
      new NextRequest('http://localhost/api/inference/profiles/default?workspaceId=ws-1'),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual(expect.objectContaining({
      proofConfidence: createDefaultProofConfidence(),
      smartProofConfig: createDefaultSmartProofConfig(),
      relationFeedbackConfig: {
        enabled: true,
        minSamples: 10,
        maxAdjustment: 0.15,
      },
      relationFeedbackSummary: {
        totalKeys: 0,
        eligibleKeys: 0,
        approvedCount: 0,
        rejectedCount: 0,
        totalSamples: 0,
      },
      domainFeedbackConfig: {
        enabled: true,
        minSamples: 10,
        maxAdjustment: 0.15,
      },
      domainFeedbackSummary: {
        totalKeys: 0,
        eligibleKeys: 0,
        approvedCount: 0,
        rejectedCount: 0,
        totalSamples: 0,
      },
    }));
    expect(payload).not.toHaveProperty('feedbackConfig');
    expect(payload).not.toHaveProperty('feedbackSummary');
    expect(payload).not.toHaveProperty('relationFeedbackEntries');
    expect(payload).not.toHaveProperty('domainFeedbackEntries');
    expect(db.select).not.toHaveBeenCalled();
  });

  it('GET은 includeFeedbackEntries=true일 때 relation/domain detail list를 각각 정렬해 반환해야 한다', async () => {
    const row = createProfileRow();
    const db = {
      select: vi.fn(),
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [createProfileBaseRow(row)] })
        .mockResolvedValueOnce({
          rows: [{
            cross_validation: null,
            feedback_config: { enabled: true, minSamples: 5, maxAdjustment: 0.15 },
            feedback_adjustments: {
              'READ:db:query': { approved: 3, rejected: 9 },
              'CALL:code:call': { approved: 9, rejected: 3 },
            },
            domain_feedback_config: { enabled: true, minSamples: 2, maxAdjustment: 0.2 },
            domain_feedback_adjustments: {
              'TRACK_A:domain-b:LOW': { approved: 0, rejected: 2 },
              'TRACK_A:domain-a:HIGH': { approved: 3, rejected: 1 },
            },
          }],
        }),
    };
    getDbMock.mockResolvedValue(db);

    const response = await GET(
      new NextRequest(
        'http://localhost/api/inference/profiles/default?workspaceId=ws-1&includeFeedbackEntries=true',
      ),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.relationFeedbackEntries).toEqual([
      {
        key: 'CALL:code:call',
        approved: 9,
        rejected: 3,
        total: 12,
        approvalRate: 0.75,
        adjustment: 0.0375,
        eligible: true,
      },
      {
        key: 'READ:db:query',
        approved: 3,
        rejected: 9,
        total: 12,
        approvalRate: 0.25,
        adjustment: -0.0375,
        eligible: true,
      },
    ]);
    expect(payload.domainFeedbackEntries).toEqual([
      {
        key: 'TRACK_A:domain-a:HIGH',
        approved: 3,
        rejected: 1,
        total: 4,
        approvalRate: 0.75,
        adjustment: 0.05,
        eligible: true,
      },
      {
        key: 'TRACK_A:domain-b:LOW',
        approved: 0,
        rejected: 2,
        total: 2,
        approvalRate: 0,
        adjustment: -0.1,
        eligible: true,
      },
    ]);
    expect(payload).not.toHaveProperty('feedbackEntries');
    expect(db.select).not.toHaveBeenCalled();
  });

  it('PUT은 proofConfidence partial update를 적용하고 누락 필드는 유지해야 한다', async () => {
    const current = createProfileRow();
    const updated = createProfileRow();
    const currentProofConfidence = createDefaultProofConfidence();
    const updatedProofConfidence = {
      ...currentProofConfidence,
      name: 'intent-proof-custom',
      version: 'v2',
      weights: {
        ...currentProofConfidence.weights,
        summaryQuality: 0.5,
      },
      slotWeights: {
        ...currentProofConfidence.slotWeights,
        http: {
          ...currentProofConfidence.slotWeights.http,
          targetObject: 0.3,
        },
      },
    };
    const { db, transactionExecuteMock } = createTransactionDb(
      current,
      updated,
      {
        cross_validation: { enabled: true, boostFactor: 0.3, penaltyFactor: 0.85 },
        proof_confidence_config: currentProofConfidence,
        feedback_config: null,
        feedback_adjustments: null,
        domain_feedback_config: null,
        domain_feedback_adjustments: null,
      },
      {
        cross_validation: { enabled: true, boostFactor: 0.3, penaltyFactor: 0.85 },
        proof_confidence_config: updatedProofConfidence,
        feedback_config: null,
        feedback_adjustments: null,
        domain_feedback_config: null,
        domain_feedback_adjustments: null,
      },
    );
    getDbMock.mockResolvedValue(db);

    const response = await PUT(new NextRequest('http://localhost/api/inference/profiles/default', {
      method: 'PUT',
      body: JSON.stringify({
        workspaceId: 'ws-1',
        proofConfidence: {
          name: 'intent-proof-custom',
          version: 'v2',
          weights: {
            summaryQuality: 0.5,
          },
          slotWeights: {
            http: {
              targetObject: 0.3,
            },
          },
        },
      }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(200);
    expect(transactionExecuteMock).toHaveBeenCalledTimes(5);
    const proofConfidenceQuery = getExecutedSql(transactionExecuteMock, 1);
    expect(proofConfidenceQuery.strings.join('')).toContain('set proof_confidence_config = ');

    const payload = await response.json();
    expect(payload.proofConfidence).toEqual(updatedProofConfidence);
  });

  it('PUT은 smartProofConfig partial update를 병합 저장하고 응답에 반영해야 한다', async () => {
    const current = createProfileRow();
    const updated = createProfileRow();
    const currentSmartProofConfig = createDefaultSmartProofConfig();
    const updatedSmartProofConfig = {
      ...currentSmartProofConfig,
      enabled: true,
      budget: {
        ...currentSmartProofConfig.budget,
        maxLlmCallsPerRun: 7,
      },
      thresholds: {
        ...currentSmartProofConfig.thresholds,
        autoAcceptConfidence: 0.9,
      },
    };
    const { db, transactionExecuteMock } = createTransactionDb(
      current,
      updated,
      {
        cross_validation: { enabled: true, boostFactor: 0.3, penaltyFactor: 0.85 },
        proof_confidence_config: createDefaultProofConfidence(),
        smart_proof_config: currentSmartProofConfig,
        feedback_config: null,
        feedback_adjustments: null,
        domain_feedback_config: null,
        domain_feedback_adjustments: null,
      },
      {
        cross_validation: { enabled: true, boostFactor: 0.3, penaltyFactor: 0.85 },
        proof_confidence_config: createDefaultProofConfidence(),
        smart_proof_config: updatedSmartProofConfig,
        feedback_config: null,
        feedback_adjustments: null,
        domain_feedback_config: null,
        domain_feedback_adjustments: null,
      },
    );
    getDbMock.mockResolvedValue(db);

    const response = await PUT(new NextRequest('http://localhost/api/inference/profiles/default', {
      method: 'PUT',
      body: JSON.stringify({
        workspaceId: 'ws-1',
        smartProofConfig: {
          enabled: true,
          budget: {
            maxLlmCallsPerRun: 7,
          },
          thresholds: {
            autoAcceptConfidence: 0.9,
          },
        },
      }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(200);
    expect(transactionExecuteMock).toHaveBeenCalledTimes(5);
    const smartProofQuery = getExecutedSql(transactionExecuteMock, 2);
    expect(smartProofQuery.strings.join('')).toContain('set smart_proof_config = ');

    const payload = await response.json();
    expect(payload.smartProofConfig).toEqual(updatedSmartProofConfig);
  });

  it('PUT은 relation/domain feedback 설정을 독립적으로 저장하고 summary를 분리해 반환해야 한다', async () => {
    const current = createProfileRow();
    const updated = createProfileRow();
    const { db, transactionExecuteMock } = createTransactionDb(
      current,
      updated,
      {
        cross_validation: { enabled: true, boostFactor: 0.3, penaltyFactor: 0.85 },
        feedback_config: { enabled: true, minSamples: 10, maxAdjustment: 0.15 },
        feedback_adjustments: {
          'CALL:code:call': { approved: 9, rejected: 1 },
        },
        domain_feedback_config: { enabled: true, minSamples: 8, maxAdjustment: 0.12 },
        domain_feedback_adjustments: {
          'TRACK_A:domain-a:HIGH': { approved: 4, rejected: 2 },
        },
      },
      {
        cross_validation: { enabled: true, boostFactor: 0.3, penaltyFactor: 0.85 },
        feedback_config: { enabled: false, minSamples: 5, maxAdjustment: 0.2 },
        feedback_adjustments: {
          'CALL:code:call': { approved: 9, rejected: 1 },
        },
        domain_feedback_config: { enabled: true, minSamples: 3, maxAdjustment: 0.18 },
        domain_feedback_adjustments: {
          'TRACK_A:domain-a:HIGH': { approved: 4, rejected: 2 },
        },
      },
    );
    getDbMock.mockResolvedValue(db);

    const response = await PUT(new NextRequest(
      'http://localhost/api/inference/profiles/default?includeFeedbackEntries=true',
      {
        method: 'PUT',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          relationFeedbackConfig: {
            enabled: false,
            minSamples: 5,
            maxAdjustment: 0.2,
          },
          domainFeedbackConfig: {
            enabled: true,
            minSamples: 3,
            maxAdjustment: 0.18,
          },
        }),
        headers: { 'Content-Type': 'application/json' },
      },
    ));

    expect(response.status).toBe(200);
    expect(transactionExecuteMock).toHaveBeenCalledTimes(5);
    const relationQuery = getExecutedSql(transactionExecuteMock, 3);
    const domainQuery = getExecutedSql(transactionExecuteMock, 4);
    expect(relationQuery.strings.join('')).toContain('set feedback_config = ');
    expect(relationQuery.strings.join('')).not.toContain('feedback_adjustments =');
    expect(domainQuery.strings.join('')).toContain('set domain_feedback_config = ');
    expect(domainQuery.strings.join('')).not.toContain('domain_feedback_adjustments =');

    const payload = await response.json();
    expect(payload.relationFeedbackConfig).toEqual({
      enabled: false,
      minSamples: 5,
      maxAdjustment: 0.2,
    });
    expect(payload.relationFeedbackSummary).toEqual({
      totalKeys: 1,
      eligibleKeys: 1,
      approvedCount: 9,
      rejectedCount: 1,
      totalSamples: 10,
    });
    expect(payload.domainFeedbackConfig).toEqual({
      enabled: true,
      minSamples: 3,
      maxAdjustment: 0.18,
    });
    expect(payload.domainFeedbackSummary).toEqual({
      totalKeys: 1,
      eligibleKeys: 1,
      approvedCount: 4,
      rejectedCount: 2,
      totalSamples: 6,
    });
  });

  it('PUT resetDomainFeedback는 relation feedback를 유지한 채 domain feedback만 초기화해야 한다', async () => {
    const current = createProfileRow();
    const updated = createProfileRow();
    const { db } = createTransactionDb(
      current,
      updated,
      {
        cross_validation: { enabled: true, boostFactor: 0.3, penaltyFactor: 0.85 },
        feedback_config: { enabled: false, minSamples: 5, maxAdjustment: 0.2 },
        feedback_adjustments: {
          'CALL:code:call': { approved: 4, rejected: 1 },
        },
        domain_feedback_config: { enabled: false, minSamples: 4, maxAdjustment: 0.1 },
        domain_feedback_adjustments: {
          'TRACK_A:domain-a:HIGH': { approved: 3, rejected: 1 },
        },
      },
      {
        cross_validation: { enabled: true, boostFactor: 0.3, penaltyFactor: 0.85 },
        feedback_config: { enabled: false, minSamples: 5, maxAdjustment: 0.2 },
        feedback_adjustments: {
          'CALL:code:call': { approved: 4, rejected: 1 },
        },
        domain_feedback_config: { enabled: true, minSamples: 10, maxAdjustment: 0.15 },
        domain_feedback_adjustments: {},
      },
    );
    getDbMock.mockResolvedValue(db);

    const response = await PUT(new NextRequest('http://localhost/api/inference/profiles/default', {
      method: 'PUT',
      body: JSON.stringify({
        workspaceId: 'ws-1',
        resetDomainFeedback: true,
      }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.relationFeedbackConfig).toEqual({
      enabled: false,
      minSamples: 5,
      maxAdjustment: 0.2,
    });
    expect(payload.relationFeedbackSummary).toEqual({
      totalKeys: 1,
      eligibleKeys: 1,
      approvedCount: 4,
      rejectedCount: 1,
      totalSamples: 5,
    });
    expect(payload.domainFeedbackConfig).toEqual({
      enabled: true,
      minSamples: 10,
      maxAdjustment: 0.15,
    });
    expect(payload.domainFeedbackSummary).toEqual({
      totalKeys: 0,
      eligibleKeys: 0,
      approvedCount: 0,
      rejectedCount: 0,
      totalSamples: 0,
    });
  });

  it('PUT은 generic alias feedbackConfig/resetAll을 public contract로 허용하지 않아야 한다', async () => {
    const current = createProfileRow();
    const updated = createProfileRow();
    const initialState = {
      cross_validation: { enabled: true, boostFactor: 0.3, penaltyFactor: 0.85 },
      feedback_config: { enabled: false, minSamples: 5, maxAdjustment: 0.2 },
      feedback_adjustments: {
        'CALL:code:call': { approved: 4, rejected: 1 },
      },
      domain_feedback_config: { enabled: false, minSamples: 4, maxAdjustment: 0.1 },
      domain_feedback_adjustments: {
        'TRACK_A:domain-a:HIGH': { approved: 3, rejected: 1 },
      },
    };
    const { db } = createTransactionDb(current, updated, initialState, initialState);
    getDbMock.mockResolvedValue(db);

    const response = await PUT(new NextRequest('http://localhost/api/inference/profiles/default', {
      method: 'PUT',
      body: JSON.stringify({
        workspaceId: 'ws-1',
        feedbackConfig: {
          enabled: true,
          minSamples: 999,
          maxAdjustment: 0.99,
        },
        resetAll: true,
      }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.relationFeedbackConfig).toEqual({
      enabled: false,
      minSamples: 5,
      maxAdjustment: 0.2,
    });
    expect(payload.relationFeedbackSummary).toEqual({
      totalKeys: 1,
      eligibleKeys: 1,
      approvedCount: 4,
      rejectedCount: 1,
      totalSamples: 5,
    });
    expect(payload.domainFeedbackConfig).toEqual({
      enabled: false,
      minSamples: 4,
      maxAdjustment: 0.1,
    });
    expect(payload.domainFeedbackSummary).toEqual({
      totalKeys: 1,
      eligibleKeys: 1,
      approvedCount: 3,
      rejectedCount: 1,
      totalSamples: 4,
    });
  });

  it('GET은 domain feedback 컬럼이 없어도 relation feedback 상태를 유지해야 한다', async () => {
    const row = createProfileRow();
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [createProfileBaseRow(row)] })
      .mockRejectedValueOnce(createMissingColumnError('domain_feedback_config'))
      .mockResolvedValueOnce({
        rows: [{
          cross_validation: null,
          feedback_config: { enabled: false, minSamples: 5, maxAdjustment: 0.2 },
          feedback_adjustments: {
            'CALL:code:call': { approved: 4, rejected: 1 },
          },
        }],
      });
    const db = {
      select: vi.fn(),
      execute,
    };
    getDbMock.mockResolvedValue(db);

    const response = await GET(
      new NextRequest('http://localhost/api/inference/profiles/default?workspaceId=ws-1'),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.relationFeedbackConfig).toEqual({
      enabled: false,
      minSamples: 5,
      maxAdjustment: 0.2,
    });
    expect(payload.relationFeedbackSummary).toEqual({
      totalKeys: 1,
      eligibleKeys: 1,
      approvedCount: 4,
      rejectedCount: 1,
      totalSamples: 5,
    });
    expect(payload.domainFeedbackSummary).toEqual({
      totalKeys: 0,
      eligibleKeys: 0,
      approvedCount: 0,
      rejectedCount: 0,
      totalSamples: 0,
    });
    expect(db.select).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('GET은 unrelated 42703 오류를 missing feedback column fallback으로 삼키지 않아야 한다', async () => {
    const row = createProfileRow();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = {
      select: vi.fn(),
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [createProfileBaseRow(row)] })
        .mockRejectedValueOnce(createMissingColumnError('unrelated_column')),
    };
    getDbMock.mockResolvedValue(db);

    const response = await GET(
      new NextRequest('http://localhost/api/inference/profiles/default?workspaceId=ws-1'),
    );

    expect(response.status).toBe(500);
    expect(db.select).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('GET은 default profile이 없어도 legacy-safe 승격 경로로 relation feedback를 유지해야 한다', async () => {
    const row = createProfileRow();
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [createProfileBaseRow({ ...row, isDefault: false })] })
      .mockRejectedValueOnce(createMissingColumnError('domain_feedback_config'))
      .mockResolvedValueOnce({
        rows: [{
          cross_validation: null,
          feedback_config: { enabled: false, minSamples: 5, maxAdjustment: 0.2 },
          feedback_adjustments: {
            'CALL:code:call': { approved: 4, rejected: 1 },
          },
        }],
      })
      .mockResolvedValueOnce({ rows: [createProfileBaseRow(row)] })
      .mockRejectedValueOnce(createMissingColumnError('domain_feedback_config'))
      .mockResolvedValueOnce({
        rows: [{
          cross_validation: null,
          feedback_config: { enabled: false, minSamples: 5, maxAdjustment: 0.2 },
          feedback_adjustments: {
            'CALL:code:call': { approved: 4, rejected: 1 },
          },
        }],
      });
    const updateWhereMock = vi.fn(async () => undefined);
    const db = {
      select: vi.fn(),
      execute,
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: updateWhereMock,
        })),
      })),
    };
    getDbMock.mockResolvedValue(db);

    const response = await GET(
      new NextRequest('http://localhost/api/inference/profiles/default?workspaceId=ws-1'),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.isDefault).toBe(true);
    expect(payload.relationFeedbackSummary).toEqual({
      totalKeys: 1,
      eligibleKeys: 1,
      approvedCount: 4,
      rejectedCount: 1,
      totalSamples: 5,
    });
    expect(payload.domainFeedbackSummary).toEqual({
      totalKeys: 0,
      eligibleKeys: 0,
      approvedCount: 0,
      rejectedCount: 0,
      totalSamples: 0,
    });
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(updateWhereMock).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(7);
  });

  it('PUT은 domain feedback 컬럼이 없어도 relation feedback 업데이트를 유지해야 한다', async () => {
    const current = createProfileRow();
    const updated = createProfileRow();
    const executeMock = vi.fn()
      .mockResolvedValueOnce({ rows: [createProfileBaseRow(current)] })
      .mockRejectedValueOnce(createMissingColumnError('domain_feedback_config'))
      .mockResolvedValueOnce({
        rows: [{
          cross_validation: { enabled: true, boostFactor: 0.3, penaltyFactor: 0.85 },
          feedback_config: { enabled: true, minSamples: 10, maxAdjustment: 0.15 },
          feedback_adjustments: {
            'CALL:code:call': { approved: 9, rejected: 1 },
          },
        }],
      })
      .mockResolvedValueOnce({ rows: [createProfileBaseRow(updated)] })
      .mockRejectedValueOnce(createMissingColumnError('domain_feedback_config'))
      .mockResolvedValueOnce({
        rows: [{
          cross_validation: { enabled: true, boostFactor: 0.3, penaltyFactor: 0.85 },
          feedback_config: { enabled: false, minSamples: 5, maxAdjustment: 0.2 },
          feedback_adjustments: {
            'CALL:code:call': { approved: 9, rejected: 1 },
          },
        }],
      });
    const transactionExecuteMock = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(createMissingColumnError('domain_feedback_config'));
    const db = {
      select: vi.fn(),
      execute: executeMock,
      transaction: async (callback: (tx: {
        update: (table: unknown) => {
          set: (payload: unknown) => { where: () => Promise<void> };
        };
        execute: (statement: unknown) => Promise<void>;
      }) => Promise<void>) => {
        await callback({
          update: () => ({
            set: () => ({ where: async () => undefined }),
          }),
          execute: transactionExecuteMock,
        });
      },
    };
    getDbMock.mockResolvedValue(db);

    const response = await PUT(new NextRequest('http://localhost/api/inference/profiles/default', {
      method: 'PUT',
      body: JSON.stringify({
        workspaceId: 'ws-1',
        relationFeedbackConfig: {
          enabled: false,
          minSamples: 5,
          maxAdjustment: 0.2,
        },
        domainFeedbackConfig: {
          enabled: true,
          minSamples: 3,
          maxAdjustment: 0.18,
        },
      }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(200);
    expect(db.select).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalledTimes(6);
    expect(transactionExecuteMock).toHaveBeenCalledTimes(5);
    const relationQuery = getExecutedSql(transactionExecuteMock, 3);
    const domainQuery = getExecutedSql(transactionExecuteMock, 4);
    expect(relationQuery.strings.join('')).toContain('feedback_config');
    expect(relationQuery.strings.join('')).not.toContain('domain_feedback_config');
    expect(relationQuery.strings.join('')).not.toContain('feedback_adjustments =');
    expect(domainQuery.strings.join('')).toContain('domain_feedback_config');

    const payload = await response.json();
    expect(payload.relationFeedbackConfig).toEqual({
      enabled: false,
      minSamples: 5,
      maxAdjustment: 0.2,
    });
    expect(payload.relationFeedbackSummary).toEqual({
      totalKeys: 1,
      eligibleKeys: 1,
      approvedCount: 9,
      rejectedCount: 1,
      totalSamples: 10,
    });
    expect(payload.domainFeedbackSummary).toEqual({
      totalKeys: 0,
      eligibleKeys: 0,
      approvedCount: 0,
      rejectedCount: 0,
      totalSamples: 0,
    });
  });
});
