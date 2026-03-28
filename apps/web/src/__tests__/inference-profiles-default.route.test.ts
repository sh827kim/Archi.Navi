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

describe('inference profile default route', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('GET은 feedback/crossValidation 설정이 없을 때 기본값과 빈 summary를 반환해야 한다', async () => {
    const row = createProfileRow();
    const db = {
      select: vi.fn().mockReturnValue({
        from: () => ({
          where: () => ({
            limit: async () => [row],
          }),
        }),
      }),
      execute: vi.fn(async () => ({
        rows: [{
          cross_validation: null,
          feedback_config: null,
          feedback_adjustments: null,
        }],
      })),
    };
    getDbMock.mockResolvedValue(db);

    const response = await GET(
      new NextRequest('http://localhost/api/inference/profiles/default?workspaceId=ws-1'),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual(expect.objectContaining({
      id: 'profile-1',
      crossValidation: {
        enabled: true,
        boostFactor: 0.3,
        penaltyFactor: 0.85,
      },
      feedbackConfig: {
        enabled: true,
        minSamples: 10,
        maxAdjustment: 0.15,
      },
      feedbackSummary: {
        totalKeys: 0,
        eligibleKeys: 0,
        approvedCount: 0,
        rejectedCount: 0,
        totalSamples: 0,
      },
    }));
    expect(payload.feedbackSummary).not.toHaveProperty('entries');
  });

  it('PUT은 feedbackConfig를 저장하고 summary를 재계산해 응답에 반영해야 한다', async () => {
    const current = {
      ...createProfileRow(),
      crossValidation: {
        enabled: true,
        boostFactor: 0.3,
        penaltyFactor: 0.85,
      },
      feedbackConfig: {
        enabled: true,
        minSamples: 10,
        maxAdjustment: 0.15,
      },
      feedbackAdjustments: {
        'CALL:code:call': {
          approved: 9,
          rejected: 1,
          total: 10,
          approvalRate: 0.9,
          adjustment: 0.06,
        },
      },
    };
    const updated = {
      ...createProfileRow(),
      crossValidation: current.crossValidation,
      feedbackConfig: current.feedbackConfig,
      feedbackAdjustments: {
        'CALL:code:call': {
          approved: 9,
          rejected: 2,
          total: 11,
          approvalRate: 0.8181818181,
          adjustment: 0.06,
        },
      },
    };

    const selectMock = vi
      .fn()
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: async () => [current],
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: async () => [updated],
          }),
        }),
      });

    const setPayloads: unknown[] = [];
    const executeMock = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          cross_validation: current.crossValidation,
          feedback_config: current.feedbackConfig,
          feedback_adjustments: current.feedbackAdjustments,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          cross_validation: updated.crossValidation,
          feedback_config: {
            enabled: false,
            minSamples: 5,
            maxAdjustment: 0.2,
          },
          feedback_adjustments: updated.feedbackAdjustments,
        }],
      });
    const transactionExecuteMock = vi.fn(async () => undefined);
    const db = {
      select: selectMock,
      execute: executeMock,
      transaction: async (callback: (tx: {
        update: (table: unknown) => {
          set: (payload: unknown) => { where: () => Promise<void> };
        };
        execute: (statement: unknown) => Promise<void>;
      }) => Promise<void>) => {
        await callback({
          update: () => ({
            set: (payload: unknown) => {
              setPayloads.push(payload);
              return { where: async () => {} };
            },
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
        feedbackConfig: {
          enabled: false,
          minSamples: 5,
          maxAdjustment: 0.2,
        },
      }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(200);
    expect(setPayloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        isDefault: true,
      }),
    ]));
    expect(transactionExecuteMock).toHaveBeenCalledTimes(2);
    const feedbackConfigQuery = transactionExecuteMock.mock.calls[1]?.[0] as { strings: string[] };
    expect(feedbackConfigQuery.strings.join('')).toContain('set feedback_config = ');
    expect(feedbackConfigQuery.strings.join('')).not.toContain('feedback_adjustments =');
    const payload = await response.json();
    expect(payload).toMatchObject({
      feedbackConfig: {
        enabled: false,
        minSamples: 5,
        maxAdjustment: 0.2,
      },
      feedbackSummary: {
        totalKeys: 1,
        eligibleKeys: 1,
        approvedCount: 9,
        rejectedCount: 2,
        totalSamples: 11,
      },
    });
    expect(payload.feedbackSummary).not.toHaveProperty('entries');
  });

  it('PUT resetAll은 feedback 설정을 기본값으로 돌리고 summary를 비워야 한다', async () => {
    const current = {
      ...createProfileRow(),
      crossValidation: {
        enabled: true,
        boostFactor: 0.3,
        penaltyFactor: 0.85,
      },
      feedbackConfig: {
        enabled: false,
        minSamples: 5,
        maxAdjustment: 0.2,
      },
      feedbackAdjustments: {
        'CALL:code:call': {
          approved: 4,
          rejected: 1,
          total: 5,
          approvalRate: 0.8,
          adjustment: 0.06,
        },
      },
    };

    const selectMock = vi
      .fn()
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: async () => [current],
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: async () => [current],
          }),
        }),
      });
    const executeMock = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          cross_validation: current.crossValidation,
          feedback_config: current.feedbackConfig,
          feedback_adjustments: current.feedbackAdjustments,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          cross_validation: current.crossValidation,
          feedback_config: {
            enabled: true,
            minSamples: 10,
            maxAdjustment: 0.15,
          },
          feedback_adjustments: {},
        }],
      });
    const db = {
      select: selectMock,
      execute: executeMock,
      transaction: async (callback: (tx: {
        update: (table: unknown) => {
          set: (payload: unknown) => { where: () => Promise<void> };
        };
        execute: (statement: unknown) => Promise<void>;
      }) => Promise<void>) => {
        await callback({
          update: () => ({
            set: () => ({ where: async () => {} }),
          }),
          execute: vi.fn(async () => undefined),
        });
      },
    };
    getDbMock.mockResolvedValue(db);

    const response = await PUT(new NextRequest('http://localhost/api/inference/profiles/default', {
      method: 'PUT',
      body: JSON.stringify({
        workspaceId: 'ws-1',
        resetAll: true,
      }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual(expect.objectContaining({
      feedbackConfig: {
        enabled: true,
        minSamples: 10,
        maxAdjustment: 0.15,
      },
      feedbackSummary: {
        totalKeys: 0,
        eligibleKeys: 0,
        approvedCount: 0,
        rejectedCount: 0,
        totalSamples: 0,
      },
    }));
    expect(payload.feedbackSummary).not.toHaveProperty('entries');
  });
});
