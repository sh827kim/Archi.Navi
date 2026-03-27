// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  getDbMock,
  inferRelationsFromConfigMock,
  inferRelationsFromCodeSignalsMock,
  bindConfigToCodeEndpointsMock,
  extractCodeSignalsWithEngineMock,
  extractDbSchemaSignalsMock,
  normalizeCodeSignalEngineMock,
  crossValidatePendingRelationCandidatesMock,
  generateBoostCandidatesMock,
  getInferenceModelMock,
  createGenerateBoostSuggestionFnMock,
  resolveMaxCallsMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  inferRelationsFromConfigMock: vi.fn(),
  inferRelationsFromCodeSignalsMock: vi.fn(),
  bindConfigToCodeEndpointsMock: vi.fn(),
  extractCodeSignalsWithEngineMock: vi.fn(),
  extractDbSchemaSignalsMock: vi.fn(),
  normalizeCodeSignalEngineMock: vi.fn(() => 'hybrid'),
  crossValidatePendingRelationCandidatesMock: vi.fn(),
  generateBoostCandidatesMock: vi.fn(),
  getInferenceModelMock: vi.fn(),
  createGenerateBoostSuggestionFnMock: vi.fn(),
  resolveMaxCallsMock: vi.fn((value?: number) => value ?? 50),
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
    inferRelationsFromConfig: inferRelationsFromConfigMock,
    inferRelationsFromCodeSignals: inferRelationsFromCodeSignalsMock,
    bindConfigToCodeEndpoints: bindConfigToCodeEndpointsMock,
    extractCodeSignalsWithEngine: extractCodeSignalsWithEngineMock,
    extractDbSchemaSignals: extractDbSchemaSignalsMock,
    normalizeCodeSignalEngine: normalizeCodeSignalEngineMock,
    crossValidatePendingRelationCandidates: crossValidatePendingRelationCandidatesMock,
    generateBoostCandidates: generateBoostCandidatesMock,
  };
});

vi.mock('@/lib/inference-llm', () => ({
  getInferenceModel: getInferenceModelMock,
  createGenerateBoostSuggestionFn: createGenerateBoostSuggestionFnMock,
  resolveMaxCalls: resolveMaxCallsMock,
}));

import { POST } from '@/app/api/inference/run/route';

describe('POST /api/inference/run', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('llmBoost.codeIntentAnalysis가 활성화되면 code 추론 이후 LLM boost 후보 생성을 호출해야 한다', async () => {
    const boostGenerateFn = vi.fn();
    getDbMock.mockResolvedValue({});
    getInferenceModelMock.mockReturnValue({
      model: { provider: 'mock' },
      modelName: 'mock-model',
    });
    createGenerateBoostSuggestionFnMock.mockReturnValue(boostGenerateFn);
    resolveMaxCallsMock.mockReturnValue(2);
    extractCodeSignalsWithEngineMock.mockResolvedValue({
      fileCount: 1,
      artifactCount: 1,
      signalCount: 1,
      skippedCount: 0,
      engineUsed: 'hybrid',
      fallbackUsed: false,
      warning: null,
      scanFailures: [],
    });
    inferRelationsFromCodeSignalsMock.mockResolvedValue({
      candidateCount: 1,
    });
    generateBoostCandidatesMock.mockResolvedValue({
      scannedCount: 3,
      generatedCount: 1,
      skippedCount: 2,
      callCount: 2,
      errorCount: 0,
    });

    const response = await POST(
      new NextRequest('http://localhost/api/inference/run', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          modes: ['code'],
          repoRoots: [process.cwd()],
          useServiceMetadataPaths: false,
          llmBoost: {
            enabled: true,
            codeIntentAnalysis: true,
            generateExplanations: true,
            maxCalls: 5,
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(resolveMaxCallsMock).toHaveBeenCalledWith(5);
    expect(createGenerateBoostSuggestionFnMock).toHaveBeenCalledWith(
      { provider: 'mock' },
      'mock-model',
    );
    expect(generateBoostCandidatesMock).toHaveBeenCalledWith(
      {},
      boostGenerateFn,
      {
        workspaceId: 'ws-1',
        repoRoots: [process.cwd()],
        maxCalls: 2,
      },
    );

    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        results: expect.objectContaining({
          llmBoost: expect.objectContaining({
            request: {
              enabled: true,
              codeIntentAnalysis: true,
              generateExplanations: true,
              requestedMaxCalls: 5,
            },
            modelConfigured: true,
            effectiveMaxCalls: 2,
            skippedReason: null,
            codeIntentAnalysis: {
              scannedCount: 3,
              generatedCount: 1,
              skippedCount: 2,
              callCount: 2,
              errorCount: 0,
            },
          }),
        }),
        summary: expect.objectContaining({
          relationCandidatesCreated: 2,
        }),
      }),
    );
  });

  it('llmBoost.enabled=false 또는 codeIntentAnalysis=false 면 LLM boost를 호출하지 않아야 한다', async () => {
    getDbMock.mockResolvedValue({});
    extractCodeSignalsWithEngineMock.mockResolvedValue({
      fileCount: 1,
      artifactCount: 1,
      signalCount: 1,
      skippedCount: 0,
      engineUsed: 'hybrid',
      fallbackUsed: false,
      warning: null,
      scanFailures: [],
    });
    inferRelationsFromCodeSignalsMock.mockResolvedValue({
      candidateCount: 1,
    });

    const response = await POST(
      new NextRequest('http://localhost/api/inference/run', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          modes: ['code'],
          repoRoots: [process.cwd()],
          useServiceMetadataPaths: false,
          llmBoost: {
            enabled: true,
            codeIntentAnalysis: false,
            maxCalls: 5,
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(getInferenceModelMock).not.toHaveBeenCalled();
    expect(generateBoostCandidatesMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        results: expect.objectContaining({
          llmBoost: expect.objectContaining({
            skippedReason: 'CODE_INTENT_ANALYSIS_DISABLED',
          }),
        }),
      }),
    );
  });

  it('LLM 모델이 설정되지 않으면 graceful degradation으로 200을 반환해야 한다', async () => {
    getDbMock.mockResolvedValue({});
    getInferenceModelMock.mockReturnValue(null);
    resolveMaxCallsMock.mockReturnValue(4);
    extractCodeSignalsWithEngineMock.mockResolvedValue({
      fileCount: 1,
      artifactCount: 1,
      signalCount: 1,
      skippedCount: 0,
      engineUsed: 'hybrid',
      fallbackUsed: false,
      warning: null,
      scanFailures: [],
    });
    inferRelationsFromCodeSignalsMock.mockResolvedValue({
      candidateCount: 1,
    });

    const response = await POST(
      new NextRequest('http://localhost/api/inference/run', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          modes: ['code'],
          repoRoots: [process.cwd()],
          useServiceMetadataPaths: false,
          llmBoost: {
            enabled: true,
            codeIntentAnalysis: true,
            maxCalls: 4,
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(generateBoostCandidatesMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        warnings: expect.arrayContaining([
          'LLM 부스터(code intent analysis)를 건너뜁니다: AI 제공자 설정이 없습니다.',
        ]),
        results: expect.objectContaining({
          llmBoost: expect.objectContaining({
            modelConfigured: false,
            effectiveMaxCalls: 4,
            skippedReason: 'LLM_NOT_CONFIGURED',
            codeIntentAnalysis: null,
          }),
        }),
      }),
    );
  });

  it('LLM boost 생성 실패도 기존 code 결과를 유지한 채 warning으로 강등해야 한다', async () => {
    getDbMock.mockResolvedValue({});
    getInferenceModelMock.mockReturnValue({
      model: { provider: 'mock' },
      modelName: 'mock-model',
    });
    createGenerateBoostSuggestionFnMock.mockReturnValue(vi.fn());
    resolveMaxCallsMock.mockReturnValue(3);
    extractCodeSignalsWithEngineMock.mockResolvedValue({
      fileCount: 1,
      artifactCount: 1,
      signalCount: 1,
      skippedCount: 0,
      engineUsed: 'hybrid',
      fallbackUsed: false,
      warning: null,
      scanFailures: [],
    });
    inferRelationsFromCodeSignalsMock.mockResolvedValue({
      candidateCount: 1,
    });
    generateBoostCandidatesMock.mockRejectedValue(new Error('llm failure'));

    const response = await POST(
      new NextRequest('http://localhost/api/inference/run', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          modes: ['code'],
          repoRoots: [process.cwd()],
          useServiceMetadataPaths: false,
          llmBoost: {
            enabled: true,
            codeIntentAnalysis: true,
            maxCalls: 3,
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        warnings: expect.arrayContaining([
          'LLM 부스터(code intent analysis) 실패: llm failure',
        ]),
        results: expect.objectContaining({
          code: expect.objectContaining({
            candidateCount: 1,
          }),
          llmBoost: expect.objectContaining({
            modelConfigured: true,
            effectiveMaxCalls: 3,
            skippedReason: 'FAILED',
            codeIntentAnalysis: null,
          }),
        }),
        summary: expect.objectContaining({
          relationCandidatesCreated: 1,
        }),
      }),
    );
  });

  it('단일 mode 실행이면 cross validation을 호출하지 않아야 한다', async () => {
    getDbMock.mockResolvedValue({});
    extractDbSchemaSignalsMock.mockResolvedValue({
      tableCount: 0,
      fkCandidateCount: 0,
      implicitFkCandidateCount: 0,
    });

    const response = await POST(
      new NextRequest('http://localhost/api/inference/run', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          modes: ['db'],
          useServiceMetadataPaths: false,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(crossValidatePendingRelationCandidatesMock).not.toHaveBeenCalled();
  });

  it('code mode 없이 config+db 실행이면 cross validation을 호출하지 않아야 한다', async () => {
    getDbMock.mockResolvedValue({});
    inferRelationsFromConfigMock.mockResolvedValue({
      candidateCount: 1,
      objectCount: 0,
      fileCount: 1,
      processedFileCount: 1,
      skippedFileCount: 0,
    });
    extractDbSchemaSignalsMock.mockResolvedValue({
      tableCount: 0,
      fkCandidateCount: 0,
      implicitFkCandidateCount: 0,
    });
    crossValidatePendingRelationCandidatesMock.mockResolvedValue({
      candidateCount: 1,
      validatedCount: 1,
      skippedSingleSourceCount: 0,
    });

    const response = await POST(
      new NextRequest('http://localhost/api/inference/run', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          modes: ['config', 'db'],
          repoRoots: [process.cwd()],
          useServiceMetadataPaths: false,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(crossValidatePendingRelationCandidatesMock).not.toHaveBeenCalled();
  });

  it('code mode가 포함된 다중 mode 실행이면 cross validation을 호출해야 한다', async () => {
    getDbMock.mockResolvedValue({});
    extractCodeSignalsWithEngineMock.mockResolvedValue({
      fileCount: 1,
      artifactCount: 1,
      signalCount: 1,
      skippedCount: 0,
      engineUsed: 'hybrid',
      fallbackUsed: false,
      warning: null,
      scanFailures: [],
    });
    inferRelationsFromCodeSignalsMock.mockResolvedValue({
      candidateCount: 1,
    });
    extractDbSchemaSignalsMock.mockResolvedValue({
      tableCount: 0,
      fkCandidateCount: 0,
      implicitFkCandidateCount: 0,
    });
    crossValidatePendingRelationCandidatesMock.mockResolvedValue({
      candidateCount: 1,
      validatedCount: 1,
      skippedSingleSourceCount: 0,
      contradictionCount: 0,
      staleConfigCount: 0,
    });

    const response = await POST(
      new NextRequest('http://localhost/api/inference/run', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          modes: ['code', 'db'],
          repoRoots: [process.cwd()],
          useServiceMetadataPaths: false,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(crossValidatePendingRelationCandidatesMock).toHaveBeenCalledWith(
      {},
      { workspaceId: 'ws-1', repoRoots: [process.cwd()], includeSchemaCandidates: true },
    );
  });

  it('codeOptions가 주어지면 code 추출기에 interProcedural 옵션을 전달해야 한다', async () => {
    getDbMock.mockResolvedValue({});
    normalizeCodeSignalEngineMock.mockReturnValueOnce('ast');
    extractCodeSignalsWithEngineMock.mockResolvedValue({
      fileCount: 1,
      artifactCount: 1,
      signalCount: 1,
      skippedCount: 0,
      engineUsed: 'ast',
      fallbackUsed: false,
      warning: null,
      scanFailures: [],
    });
    inferRelationsFromCodeSignalsMock.mockResolvedValue({
      candidateCount: 1,
    });

    const response = await POST(
      new NextRequest('http://localhost/api/inference/run', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          modes: ['code'],
          repoRoots: [process.cwd()],
          useServiceMetadataPaths: false,
          codeEngine: 'ast',
          codeOptions: {
            interProcedural: true,
            maxCallChainDepth: 3,
            resolveProperties: true,
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(extractCodeSignalsWithEngineMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        workspaceId: 'ws-1',
        repoRoot: process.cwd(),
        codeEngine: 'ast',
        interProcedural: true,
        maxCallChainDepth: 3,
        resolveProperties: true,
      }),
    );
  });

  it('config+code 실행에서 config 추론이 실패하면 binding과 cross validation을 호출하지 않아야 한다', async () => {
    getDbMock.mockResolvedValue({});
    inferRelationsFromConfigMock.mockRejectedValue(new Error('config failed'));
    extractCodeSignalsWithEngineMock.mockResolvedValue({
      fileCount: 1,
      artifactCount: 1,
      signalCount: 1,
      skippedCount: 0,
      engineUsed: 'hybrid',
      fallbackUsed: false,
      warning: null,
      scanFailures: [],
    });
    inferRelationsFromCodeSignalsMock.mockResolvedValue({
      candidateCount: 1,
    });

    const response = await POST(
      new NextRequest('http://localhost/api/inference/run', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          modes: ['config', 'code'],
          repoRoots: [process.cwd()],
          useServiceMetadataPaths: false,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(bindConfigToCodeEndpointsMock).not.toHaveBeenCalled();
    expect(crossValidatePendingRelationCandidatesMock).not.toHaveBeenCalled();
  });

  it('code mode가 포함되어도 code 추론이 실패하면 cross validation을 호출하지 않아야 한다', async () => {
    getDbMock.mockResolvedValue({});
    inferRelationsFromConfigMock.mockResolvedValue({
      candidateCount: 1,
      objectCount: 0,
      fileCount: 1,
      processedFileCount: 1,
      skippedFileCount: 0,
    });
    extractCodeSignalsWithEngineMock.mockRejectedValue(new Error('parser failed'));

    const response = await POST(
      new NextRequest('http://localhost/api/inference/run', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          modes: ['config', 'code'],
          repoRoots: [process.cwd()],
          useServiceMetadataPaths: false,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(crossValidatePendingRelationCandidatesMock).not.toHaveBeenCalled();
  });

  it('code 신호 추출은 성공해도 relation inference가 실패하면 binding과 cross validation을 호출하지 않아야 한다', async () => {
    getDbMock.mockResolvedValue({});
    inferRelationsFromConfigMock.mockResolvedValue({
      candidateCount: 1,
      objectCount: 0,
      fileCount: 1,
      processedFileCount: 1,
      skippedFileCount: 0,
    });
    extractCodeSignalsWithEngineMock.mockResolvedValue({
      fileCount: 1,
      artifactCount: 1,
      signalCount: 1,
      skippedCount: 0,
      engineUsed: 'hybrid',
      fallbackUsed: false,
      warning: null,
      scanFailures: [],
    });
    inferRelationsFromCodeSignalsMock.mockRejectedValue(new Error('relation inference failed'));

    const response = await POST(
      new NextRequest('http://localhost/api/inference/run', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          modes: ['config', 'code'],
          repoRoots: [process.cwd()],
          useServiceMetadataPaths: false,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(bindConfigToCodeEndpointsMock).not.toHaveBeenCalled();
    expect(crossValidatePendingRelationCandidatesMock).not.toHaveBeenCalled();
  });

  it('선택한 code root 중 일부라도 relation inference가 실패하면 binding과 cross validation을 호출하지 않아야 한다', async () => {
    const repoA = process.cwd();
    const repoB = `${process.cwd()}/src`;
    getDbMock.mockResolvedValue({});
    inferRelationsFromConfigMock.mockResolvedValue({
      candidateCount: 1,
      objectCount: 0,
      fileCount: 1,
      processedFileCount: 1,
      skippedFileCount: 0,
    });
    extractCodeSignalsWithEngineMock.mockResolvedValue({
      fileCount: 1,
      artifactCount: 1,
      signalCount: 1,
      skippedCount: 0,
      engineUsed: 'hybrid',
      fallbackUsed: false,
      warning: null,
      scanFailures: [],
    });
    inferRelationsFromCodeSignalsMock
      .mockResolvedValueOnce({ candidateCount: 1 })
      .mockRejectedValueOnce(new Error('relation inference failed'));

    const response = await POST(
      new NextRequest('http://localhost/api/inference/run', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          modes: ['config', 'code'],
          repoRoots: [repoA, repoB],
          useServiceMetadataPaths: false,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(bindConfigToCodeEndpointsMock).not.toHaveBeenCalled();
    expect(crossValidatePendingRelationCandidatesMock).not.toHaveBeenCalled();
  });

  it('code+db 실행에서 db 추론이 실패하면 cross validation을 호출하지 않아야 한다', async () => {
    getDbMock.mockResolvedValue({});
    extractCodeSignalsWithEngineMock.mockResolvedValue({
      fileCount: 1,
      artifactCount: 1,
      signalCount: 1,
      skippedCount: 0,
      engineUsed: 'hybrid',
      fallbackUsed: false,
      warning: null,
      scanFailures: [],
    });
    inferRelationsFromCodeSignalsMock.mockResolvedValue({
      candidateCount: 1,
    });
    extractDbSchemaSignalsMock.mockRejectedValue(new Error('db failed'));

    const response = await POST(
      new NextRequest('http://localhost/api/inference/run', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          modes: ['code', 'db'],
          repoRoots: [process.cwd()],
          useServiceMetadataPaths: false,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(crossValidatePendingRelationCandidatesMock).not.toHaveBeenCalled();
  });

  it('config+code+db 실행에서 db 추론이 실패해도 binding은 수행하고 cross validation은 건너뛰어야 한다', async () => {
    getDbMock.mockResolvedValue({});
    inferRelationsFromConfigMock.mockResolvedValue({
      candidateCount: 1,
      objectCount: 0,
      fileCount: 1,
      processedFileCount: 1,
      skippedFileCount: 0,
    });
    extractCodeSignalsWithEngineMock.mockResolvedValue({
      fileCount: 1,
      artifactCount: 1,
      signalCount: 1,
      skippedCount: 0,
      engineUsed: 'hybrid',
      fallbackUsed: false,
      warning: null,
      scanFailures: [],
    });
    inferRelationsFromCodeSignalsMock.mockResolvedValue({
      candidateCount: 1,
    });
    extractDbSchemaSignalsMock.mockRejectedValue(new Error('db failed'));

    const response = await POST(
      new NextRequest('http://localhost/api/inference/run', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          modes: ['config', 'code', 'db'],
          repoRoots: [process.cwd()],
          useServiceMetadataPaths: false,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(bindConfigToCodeEndpointsMock).toHaveBeenCalledWith(
      {},
      { workspaceId: 'ws-1', repoRoots: [process.cwd()] },
    );
    expect(crossValidatePendingRelationCandidatesMock).not.toHaveBeenCalled();
  });

  it('code-only 실행에서 relation inference가 전부 실패하면 500을 반환해야 한다', async () => {
    getDbMock.mockResolvedValue({});
    extractCodeSignalsWithEngineMock.mockResolvedValue({
      fileCount: 1,
      artifactCount: 1,
      signalCount: 1,
      skippedCount: 0,
      engineUsed: 'hybrid',
      fallbackUsed: false,
      warning: null,
      scanFailures: [],
    });
    inferRelationsFromCodeSignalsMock.mockRejectedValue(new Error('relation inference failed'));

    const response = await POST(
      new NextRequest('http://localhost/api/inference/run', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          modes: ['code'],
          repoRoots: [process.cwd()],
          useServiceMetadataPaths: false,
        }),
      }),
    );

    expect(response.status).toBe(500);
  });
});
