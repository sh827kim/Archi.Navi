// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, cancelInferenceRunMock, retryInferenceRunMock, executeInferenceRunMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  cancelInferenceRunMock: vi.fn(),
  retryInferenceRunMock: vi.fn(),
  executeInferenceRunMock: vi.fn(),
}));

vi.mock('@archi-navi/db', () => ({
  getDb: getDbMock,
}));

vi.mock('@archi-navi/inference', () => ({
  getInferenceRunDetail: vi.fn(),
  cancelInferenceRun: cancelInferenceRunMock,
  retryInferenceRun: retryInferenceRunMock,
  executeInferenceRun: executeInferenceRunMock,
}));

import { PATCH } from '@/app/api/inference/runs/[id]/route';

describe('PATCH /api/inference/runs/[id]', () => {
  afterEach(() => {
    delete process.env['INFERENCE_RUNS_API_TOKEN'];
    vi.clearAllMocks();
  });

  it('인증 헤더가 없으면 401을 반환해야 한다', async () => {
    process.env['INFERENCE_RUNS_API_TOKEN'] = 'secret-token';

    const response = await PATCH(
      new Request('http://localhost/api/inference/runs/run-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws-1', action: 'cancel' }),
      }) as never,
      { params: Promise.resolve({ id: 'run-1' }) },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(cancelInferenceRunMock).not.toHaveBeenCalled();
  });

  it('올바른 인증 헤더가 있으면 cancel 액션을 수행해야 한다', async () => {
    process.env['INFERENCE_RUNS_API_TOKEN'] = 'secret-token';
    getDbMock.mockResolvedValue({ db: 'mock' });
    cancelInferenceRunMock.mockResolvedValue({ canceled: true, status: 'CANCELED' });

    const response = await PATCH(
      new Request('http://localhost/api/inference/runs/run-1', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-inference-runs-token': 'secret-token',
        },
        body: JSON.stringify({ workspaceId: 'ws-1', action: 'cancel' }),
      }) as never,
      { params: Promise.resolve({ id: 'run-1' }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      canceled: true,
      status: 'CANCELED',
    });
    expect(cancelInferenceRunMock).toHaveBeenCalledWith({ db: 'mock' }, {
      workspaceId: 'ws-1',
      runId: 'run-1',
    });
  });
});
