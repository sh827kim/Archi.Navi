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
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  inferRelationsFromConfigMock: vi.fn(),
  inferRelationsFromCodeSignalsMock: vi.fn(),
  bindConfigToCodeEndpointsMock: vi.fn(),
  extractCodeSignalsWithEngineMock: vi.fn(),
  extractDbSchemaSignalsMock: vi.fn(),
  normalizeCodeSignalEngineMock: vi.fn(() => 'hybrid'),
  crossValidatePendingRelationCandidatesMock: vi.fn(),
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
  };
});

import { POST } from '@/app/api/inference/run/route';

describe('POST /api/inference/run', () => {
  afterEach(() => {
    vi.clearAllMocks();
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
      { workspaceId: 'ws-1', repoRoots: [process.cwd()] },
    );
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
