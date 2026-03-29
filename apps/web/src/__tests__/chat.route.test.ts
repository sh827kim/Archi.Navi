// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  streamTextMock,
  convertToModelMessagesMock,
  executeQueryMock,
  assembleEvidenceChainMock,
  formatEvidenceChainMock,
  buildAnswerComposerSystemPromptMock,
  formatDomainSummaryMock,
  buildDomainAnswerComposerPromptMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  streamTextMock: vi.fn(),
  convertToModelMessagesMock: vi.fn(),
  executeQueryMock: vi.fn(),
  assembleEvidenceChainMock: vi.fn(),
  formatEvidenceChainMock: vi.fn(),
  buildAnswerComposerSystemPromptMock: vi.fn(),
  formatDomainSummaryMock: vi.fn(),
  buildDomainAnswerComposerPromptMock: vi.fn(),
}));

vi.mock('ai', () => ({
  streamText: streamTextMock,
  convertToModelMessages: convertToModelMessagesMock,
  createUIMessageStream: vi.fn(({ execute }: { execute: (args: { writer: { write: (chunk: unknown) => void } }) => void }) => ({
    execute,
  })),
  createUIMessageStreamResponse: vi.fn(() => new Response('mock-stream')),
}));

vi.mock('@ai-sdk/openai', () => ({
  openai: (model: string) => ({ provider: 'openai', model }),
  createOpenAI: vi.fn(() => (model: string) => ({ provider: 'openai', model })),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: (model: string) => ({ provider: 'anthropic', model }),
  createAnthropic: vi.fn(() => (model: string) => ({ provider: 'anthropic', model })),
}));

vi.mock('@ai-sdk/google', () => ({
  google: (model: string) => ({ provider: 'google', model }),
  createGoogleGenerativeAI: vi.fn(() => (model: string) => ({ provider: 'google', model })),
}));

vi.mock('@archi-navi/db', async () => {
  const actual = await vi.importActual<typeof import('@archi-navi/db')>('@archi-navi/db');
  return {
    ...actual,
    getDb: getDbMock,
  };
});

vi.mock('@archi-navi/core', () => ({
  executeQuery: executeQueryMock,
  assembleEvidenceChain: assembleEvidenceChainMock,
  formatEvidenceChain: formatEvidenceChainMock,
  buildAnswerComposerSystemPrompt: buildAnswerComposerSystemPromptMock,
  formatDomainSummary: formatDomainSummaryMock,
  buildDomainAnswerComposerPrompt: buildDomainAnswerComposerPromptMock,
}));

import { POST } from '@/app/api/chat/route';

function createDbMock(results: unknown[]) {
  const queue = [...results];

  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const value = queue.shift() ?? [];
          const promise = Promise.resolve(value);
          return {
            limit: vi.fn(() => promise),
            then: promise.then.bind(promise),
            catch: promise.catch.bind(promise),
            finally: promise.finally.bind(promise),
          };
        }),
      })),
    })),
  };
}

function createRequest(message: string): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: 'ws-1',
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: message }],
        },
      ],
    }),
  });
}

describe('POST /api/chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    convertToModelMessagesMock.mockResolvedValue([]);
    streamTextMock.mockReturnValue({
      toUIMessageStreamResponse: () => new Response('ok'),
    });
    formatDomainSummaryMock.mockReturnValue('domain-summary');
    buildDomainAnswerComposerPromptMock.mockReturnValue('\nDOMAIN_PROMPT');
    formatEvidenceChainMock.mockReturnValue('formatted-chain');
    buildAnswerComposerSystemPromptMock.mockReturnValue('\nANSWER_PROMPT');
    assembleEvidenceChainMock.mockResolvedValue({ items: [] });
  });

  afterEach(() => {
    delete process.env['ARCHI_NAVI_CHAT_MOCK'];
  });

  it('서비스 API 질문이면 서비스 컨텍스트를 system prompt에 주입하고 executeQuery를 호출하지 않아야 한다', async () => {
    getDbMock.mockResolvedValue(
      createDbMock([
        [
          {
            id: 'svc-1',
            name: 'author-service',
            displayName: 'Author Service',
          },
        ],
        [
          {
            id: 'svc-1',
            name: 'author-service',
            displayName: 'Author Service',
            description: 'author aggregate API',
            metadata: { scanPath: '/repo/author-service' },
          },
        ],
        [
          {
            id: 'ep-1',
            name: 'GET /authors',
            displayName: 'GET /authors',
            metadata: { method: 'GET', path: '/authors' },
          },
          {
            id: 'ep-2',
            name: 'POST /authors',
            displayName: 'POST /authors',
            metadata: { method: 'POST', path: '/authors' },
          },
        ],
      ]),
    );

    const response = await POST(createRequest('지금 author-service 는 어떤 api 가 있지?'));

    expect(response.status).toBe(200);
    expect(executeQueryMock).not.toHaveBeenCalled();
    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('[서비스 API 목록]'),
      }),
    );
    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('GET /authors'),
      }),
    );
    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('/repo/author-service'),
      }),
    );
  });

  it('영향 질문이면 executeQuery 결과를 evidence chain prompt로 연결해야 한다', async () => {
    getDbMock.mockResolvedValue(
      createDbMock([
        [
          {
            id: 'svc-1',
            name: 'payment-service',
            displayName: 'Payment Service',
          },
        ],
      ]),
    );
    executeQueryMock.mockResolvedValue({
      queryType: 'IMPACT_ANALYSIS',
      result: { nodes: [], edges: [] },
    });

    const response = await POST(createRequest('payment-service 수정 시 영향받는 서비스는?'));

    expect(response.status).toBe(200);
    expect(executeQueryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        queryType: 'IMPACT_ANALYSIS',
        params: expect.objectContaining({
          targetObjectId: 'svc-1',
          direction: 'UPSTREAM',
        }),
      }),
    );
    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('formatted-chain'),
      }),
    );
    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('ANSWER_PROMPT'),
      }),
    );
  });
});
