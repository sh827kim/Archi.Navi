// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  getDbMock,
  runDiscoveryMock,
  runSeedBasedInferenceMock,
  generateDomainLabelsMock,
  getActiveGenerationMock,
  rebuildRollupsMock,
  getInferenceModelMock,
  createGenerateDomainLabelFnMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  runDiscoveryMock: vi.fn(),
  runSeedBasedInferenceMock: vi.fn(),
  generateDomainLabelsMock: vi.fn(),
  getActiveGenerationMock: vi.fn(),
  rebuildRollupsMock: vi.fn(),
  getInferenceModelMock: vi.fn(),
  createGenerateDomainLabelFnMock: vi.fn(() => vi.fn()),
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
    runDiscovery: runDiscoveryMock,
    runSeedBasedInference: runSeedBasedInferenceMock,
    generateDomainLabels: generateDomainLabelsMock,
  };
});

vi.mock('@archi-navi/core', async () => {
  const actual = await vi.importActual<typeof import('@archi-navi/core')>('@archi-navi/core');
  return {
    ...actual,
    getActiveGeneration: getActiveGenerationMock,
    rebuildRollups: rebuildRollupsMock,
  };
});

vi.mock('@/lib/inference-llm', () => ({
  getInferenceModel: getInferenceModelMock,
  createGenerateDomainLabelFn: createGenerateDomainLabelFnMock,
}));

import { POST } from '@/app/api/inference/domain-run/route';

describe('POST /api/inference/domain-run', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('llmLabel.enabled=true 이면 discovery 이후 라벨 정제를 수행한다', async () => {
    getDbMock.mockResolvedValue({ kind: 'db' });
    getActiveGenerationMock.mockResolvedValue(7);
    runDiscoveryMock.mockResolvedValue({
      runId: 'run-1',
      clusterCount: 2,
    });
    getInferenceModelMock.mockReturnValue({
      model: { provider: 'openai' },
      modelName: 'gpt-4o',
    });
    const generateFn = vi.fn();
    createGenerateDomainLabelFnMock.mockReturnValue(generateFn);
    generateDomainLabelsMock.mockResolvedValue({
      processedCount: 2,
      labeledCount: 2,
      skippedCount: 0,
      callCount: 2,
      errorCount: 0,
    });

    const response = await POST(
      new NextRequest('http://localhost/api/inference/domain-run', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          profileId: 'profile-1',
          track: 'b',
          llmLabel: { enabled: true },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(runDiscoveryMock).toHaveBeenCalledWith(
      { kind: 'db' },
      expect.objectContaining({
        workspaceId: 'ws-1',
        profileId: 'profile-1',
        generationVersion: 7,
      }),
    );
    expect(createGenerateDomainLabelFnMock).toHaveBeenCalledWith(
      { provider: 'openai' },
      'gpt-4o',
    );
    expect(generateDomainLabelsMock).toHaveBeenCalledWith(
      { kind: 'db' },
      generateFn,
      {
        workspaceId: 'ws-1',
        runId: 'run-1',
      },
    );

    const payload = (await response.json()) as {
      result?: { discovery?: { llmLabel?: { labeledCount: number; applied: boolean } } };
    };
    expect(payload.result?.discovery?.llmLabel).toMatchObject({
      labeledCount: 2,
      applied: true,
    });
  });

  it('llmLabel.enabled=false 이면 라벨 정제를 호출하지 않는다', async () => {
    getDbMock.mockResolvedValue({});
    getActiveGenerationMock.mockResolvedValue(3);
    runDiscoveryMock.mockResolvedValue({
      runId: 'run-2',
      clusterCount: 1,
    });

    const response = await POST(
      new NextRequest('http://localhost/api/inference/domain-run', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          profileId: 'profile-1',
          track: 'b',
          llmLabel: { enabled: false },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(getInferenceModelMock).not.toHaveBeenCalled();
    expect(generateDomainLabelsMock).not.toHaveBeenCalled();
  });

  it('track=b 는 Track A seed run과 domain feedback 적용 경로를 건드리지 않는 no-op 이어야 한다', async () => {
    getDbMock.mockResolvedValue({});
    getActiveGenerationMock.mockResolvedValue(11);
    runDiscoveryMock.mockResolvedValue({
      runId: 'run-track-b',
      clusterCount: 5,
    });

    const response = await POST(
      new NextRequest('http://localhost/api/inference/domain-run', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          profileId: 'profile-1',
          track: 'b',
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(runSeedBasedInferenceMock).not.toHaveBeenCalled();
    expect(runDiscoveryMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        workspaceId: 'ws-1',
        profileId: 'profile-1',
        generationVersion: 11,
      }),
    );

    const payload = (await response.json()) as {
      result?: {
        track?: string;
        seed: null;
        discovery?: { clusterCount: number };
      };
    };
    expect(payload.result).toMatchObject({
      track: 'b',
      seed: null,
      discovery: {
        clusterCount: 5,
      },
    });
  });

  it('LLM 설정이 없어도 discovery 결과는 유지하고 200을 반환한다', async () => {
    getDbMock.mockResolvedValue({});
    getActiveGenerationMock.mockResolvedValue(5);
    runDiscoveryMock.mockResolvedValue({
      runId: 'run-3',
      clusterCount: 4,
    });
    getInferenceModelMock.mockReturnValue(null);

    const response = await POST(
      new NextRequest('http://localhost/api/inference/domain-run', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          profileId: 'profile-1',
          track: 'b',
          llmLabel: { enabled: true },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(generateDomainLabelsMock).not.toHaveBeenCalled();

    const payload = (await response.json()) as {
      result?: {
        discovery?: {
          clusterCount: number;
          llmLabel?: { applied: boolean; reason?: string; processedCount: number };
        };
      };
    };
    expect(payload.result?.discovery?.clusterCount).toBe(4);
    expect(payload.result?.discovery?.llmLabel).toMatchObject({
      applied: false,
      reason: 'not_configured',
      processedCount: 0,
    });
  });

  it('라벨 정제 중 예외가 나도 기존 discovery 결과는 유지한다', async () => {
    getDbMock.mockResolvedValue({});
    getActiveGenerationMock.mockResolvedValue(9);
    runDiscoveryMock.mockResolvedValue({
      runId: 'run-4',
      clusterCount: 3,
    });
    getInferenceModelMock.mockReturnValue({
      model: { provider: 'openai' },
      modelName: 'gpt-4o-mini',
    });
    createGenerateDomainLabelFnMock.mockReturnValue(vi.fn());
    generateDomainLabelsMock.mockRejectedValue(new Error('llm failed'));

    const response = await POST(
      new NextRequest('http://localhost/api/inference/domain-run', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          profileId: 'profile-1',
          track: 'b',
          llmLabel: { enabled: true },
        }),
      }),
    );

    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      result?: {
        discovery?: {
          clusterCount: number;
          llmLabel?: { applied: boolean; reason?: string; errorCount: number };
        };
      };
    };
    expect(payload.result?.discovery?.clusterCount).toBe(3);
    expect(payload.result?.discovery?.llmLabel).toMatchObject({
      applied: false,
      reason: 'error',
      errorCount: 0,
    });
  });
});
