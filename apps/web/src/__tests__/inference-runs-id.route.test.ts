// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  getInferenceRunDetailMock,
  cancelInferenceRunMock,
  retryInferenceRunMock,
  executeInferenceRunMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getInferenceRunDetailMock: vi.fn(),
  cancelInferenceRunMock: vi.fn(),
  retryInferenceRunMock: vi.fn(),
  executeInferenceRunMock: vi.fn(),
}));

vi.mock('@archi-navi/db', () => ({
  getDb: getDbMock,
}));

vi.mock('@archi-navi/inference', () => ({
  getInferenceRunDetail: getInferenceRunDetailMock,
  cancelInferenceRun: cancelInferenceRunMock,
  retryInferenceRun: retryInferenceRunMock,
  executeInferenceRun: executeInferenceRunMock,
}));

import { GET, PATCH } from '@/app/api/inference/runs/[id]/route';

describe('GET /api/inference/runs/[id]', () => {
  afterEach(() => {
    delete process.env['INFERENCE_RUNS_API_TOKEN'];
    vi.clearAllMocks();
  });

  it('인증 헤더가 없으면 401을 반환해야 한다', async () => {
    process.env['INFERENCE_RUNS_API_TOKEN'] = 'secret-token';

    const response = await GET(
      new Request('http://localhost/api/inference/runs/run-1?workspaceId=ws-1', {
        method: 'GET',
      }) as never,
      { params: Promise.resolve({ id: 'run-1' }) },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(getInferenceRunDetailMock).not.toHaveBeenCalled();
  });

  it('workspaceId 쿼리가 없으면 400을 반환해야 한다', async () => {
    process.env['INFERENCE_RUNS_API_TOKEN'] = 'secret-token';

    const response = await GET(
      new Request('http://localhost/api/inference/runs/run-1', {
        method: 'GET',
        headers: { 'x-inference-runs-token': 'secret-token' },
      }) as never,
      { params: Promise.resolve({ id: 'run-1' }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'workspaceId is required' });
    expect(getInferenceRunDetailMock).not.toHaveBeenCalled();
  });

  it('인증과 파라미터가 유효하면 상세 조회 결과를 반환해야 한다', async () => {
    process.env['INFERENCE_RUNS_API_TOKEN'] = 'secret-token';
    getDbMock.mockResolvedValue({ db: 'mock' });
    getInferenceRunDetailMock.mockResolvedValue({
      run: { id: 'run-1', status: 'SUCCEEDED' },
      sources: [{ id: 'src-1' }],
      events: [{ id: 'evt-1' }],
    });

    const response = await GET(
      new Request('http://localhost/api/inference/runs/run-1?workspaceId=ws-1', {
        method: 'GET',
        headers: { authorization: 'Bearer secret-token' },
      }) as never,
      { params: Promise.resolve({ id: 'run-1' }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      run: { id: 'run-1', status: 'SUCCEEDED' },
      sources: [{ id: 'src-1' }],
      events: [{ id: 'evt-1' }],
    });
    expect(getInferenceRunDetailMock).toHaveBeenCalledWith({ db: 'mock' }, {
      workspaceId: 'ws-1',
      runId: 'run-1',
    });
  });

  it('상세 조회에서 not found 오류가 나면 404를 반환해야 한다', async () => {
    process.env['INFERENCE_RUNS_API_TOKEN'] = 'secret-token';
    getDbMock.mockResolvedValue({ db: 'mock' });
    getInferenceRunDetailMock.mockRejectedValue(new Error('대상 실행을 찾을 수 없습니다'));

    const response = await GET(
      new Request('http://localhost/api/inference/runs/run-1?workspaceId=ws-1', {
        method: 'GET',
        headers: { authorization: 'Bearer secret-token' },
      }) as never,
      { params: Promise.resolve({ id: 'run-1' }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: '대상 실행을 찾을 수 없습니다' });
  });

  it('상세 조회에서 예기치 못한 오류가 나면 500을 반환해야 한다', async () => {
    process.env['INFERENCE_RUNS_API_TOKEN'] = 'secret-token';
    getDbMock.mockResolvedValue({ db: 'mock' });
    getInferenceRunDetailMock.mockRejectedValue(new Error('database unavailable'));

    const response = await GET(
      new Request('http://localhost/api/inference/runs/run-1?workspaceId=ws-1', {
        method: 'GET',
        headers: { authorization: 'Bearer secret-token' },
      }) as never,
      { params: Promise.resolve({ id: 'run-1' }) },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Internal Server Error' });
  });
});

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
