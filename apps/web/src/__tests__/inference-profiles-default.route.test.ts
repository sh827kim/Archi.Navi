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

describe('inference profile default route', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('GET은 crossValidation 설정이 없을 때 기본값을 반환해야 한다', async () => {
    const row = {
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
      crossValidation: null,
    };
    const db = {
      select: vi.fn().mockReturnValue({
        from: () => ({
          where: () => ({
            limit: async () => [row],
          }),
        }),
      }),
      execute: vi.fn(async () => ({ rows: [{ cross_validation: null }] })),
    };
    getDbMock.mockResolvedValue(db);

    const response = await GET(
      new NextRequest('http://localhost/api/inference/profiles/default?workspaceId=ws-1'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      id: 'profile-1',
      crossValidation: {
        enabled: true,
        boostFactor: 0.3,
        penaltyFactor: 0.85,
      },
    }));
  });

  it('PUT은 crossValidation 설정을 저장하고 응답에 반영해야 한다', async () => {
    const current = {
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
      crossValidation: {
        enabled: true,
        boostFactor: 0.3,
        penaltyFactor: 0.85,
      },
    };
    const updated = {
      ...current,
      crossValidation: {
        enabled: false,
        boostFactor: 0.1,
        penaltyFactor: 0.9,
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
      .mockResolvedValueOnce({ rows: [{ cross_validation: current.crossValidation }] })
      .mockResolvedValueOnce({ rows: [{ cross_validation: updated.crossValidation }] });
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
        wCode: 0.5,
        wDb: 0.3,
        wMsg: 0.2,
        crossValidation: {
          enabled: false,
          boostFactor: 0.1,
          penaltyFactor: 0.9,
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
    expect(transactionExecuteMock).toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      crossValidation: {
        enabled: false,
        boostFactor: 0.1,
        penaltyFactor: 0.9,
      },
    }));
  });
});
