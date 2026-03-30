// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  streamTextMock,
  generateObjectMock,
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
  generateObjectMock: vi.fn(),
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
  generateObject: generateObjectMock,
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
    delete process.env['OPENAI_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
    convertToModelMessagesMock.mockResolvedValue([]);
    streamTextMock.mockReturnValue({
      toUIMessageStreamResponse: () => new Response('ok'),
    });
    formatDomainSummaryMock.mockReturnValue('domain-summary');
    buildDomainAnswerComposerPromptMock.mockReturnValue('\nDOMAIN_PROMPT');
    formatEvidenceChainMock.mockReturnValue('formatted-chain');
    buildAnswerComposerSystemPromptMock.mockReturnValue('\nANSWER_PROMPT');
    assembleEvidenceChainMock.mockResolvedValue({
      items: [],
      totalCount: 0,
      truncated: false,
      queryType: 'IMPACT_ANALYSIS',
    });
  });

  afterEach(() => {
    delete process.env['ARCHI_NAVI_CHAT_MOCK'];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
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
    expect(assembleEvidenceChainMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ maxCount: 48 }),
    );
  });

  it('LLM intent router 결과를 우선 적용해 query type을 결정해야 한다', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key';
    generateObjectMock.mockResolvedValue({
      object: { intent: 'PATH_DISCOVERY' },
    });
    getDbMock.mockResolvedValue(
      createDbMock([
        [
          { id: 'svc-order', name: 'order-service', displayName: 'Order Service' },
          { id: 'svc-payment', name: 'payment-service', displayName: 'Payment Service' },
        ],
        [{ id: 'svc-payment', name: 'payment-service', displayName: 'Payment Service' }],
      ]),
    );
    executeQueryMock.mockResolvedValue({
      queryType: 'PATH_DISCOVERY',
      result: { nodes: [], edges: [] },
    });

    const response = await POST(createRequest('order-service와 payment-service 관계 분석해줘'));

    expect(response.status).toBe(200);
    expect(generateObjectMock).toHaveBeenCalled();
    expect(executeQueryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        queryType: 'PATH_DISCOVERY',
        params: expect.objectContaining({
          fromObjectId: 'svc-order',
          toObjectId: 'svc-payment',
        }),
      }),
    );
  });

  it('DOMAIN_SUMMARY에서 token-boundary 매칭으로 reorder 오탐 없이 domainId를 선택해야 한다', async () => {
    getDbMock.mockResolvedValue(
      createDbMock([
        [],
        [
          { id: 'dom-reorder', name: 'reorder-service', displayName: '재주문 도메인' },
          { id: 'dom-order', name: 'order', displayName: '주문 도메인' },
        ],
      ]),
    );
    executeQueryMock.mockResolvedValue({
      queryType: 'DOMAIN_SUMMARY',
      result: { summary: {} },
    });

    const response = await POST(createRequest('order 도메인 요약해줘'));

    expect(response.status).toBe(200);
    expect(executeQueryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        queryType: 'DOMAIN_SUMMARY',
        params: expect.objectContaining({
          domainId: 'dom-order',
        }),
      }),
    );
  });

  it('긴 evidence 컨텍스트면 maxOutputTokens를 자동으로 줄여야 한다', async () => {
    getDbMock.mockResolvedValue(
      createDbMock([
        [{ id: 'svc-1', name: 'payment-service', displayName: 'Payment Service' }],
      ]),
    );
    executeQueryMock.mockResolvedValue({
      queryType: 'IMPACT_ANALYSIS',
      result: { nodes: [], edges: [] },
    });
    assembleEvidenceChainMock.mockResolvedValue({
      queryType: 'IMPACT_ANALYSIS',
      totalCount: 12,
      truncated: true,
      items: Array.from({ length: 12 }, (_, idx) => ({
        type: 'rollup',
        sourceId: `s-${idx}`,
        sourceName: `s-${idx}`,
        targetId: `t-${idx}`,
        targetName: `t-${idx}`,
        relationType: 'call',
        confidence: Math.max(0.2, 0.95 - idx * 0.05),
        edgeWeight: 1,
        hop: 0,
        score: 1,
      })),
    });
    formatEvidenceChainMock.mockReturnValue('x'.repeat(8000));

    const response = await POST(createRequest('payment-service 수정 시 영향받는 서비스는?'));

    expect(response.status).toBe(200);
    const chainArg = buildAnswerComposerSystemPromptMock.mock.calls[0]?.[0] as {
      items: Array<{ confidence: number }>;
    };
    expect(chainArg.items.length).toBeLessThanOrEqual(8);
    expect(chainArg.items.every((item) => item.confidence >= 0.35)).toBe(true);
    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 1536,
      }),
    );
  });
});
