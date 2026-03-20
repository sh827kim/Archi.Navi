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

  it('2개 이상 mode 실행이면 cross validation을 호출해야 한다', async () => {
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
    expect(crossValidatePendingRelationCandidatesMock).toHaveBeenCalledWith({}, { workspaceId: 'ws-1' });
  });
});
