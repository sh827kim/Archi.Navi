// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

const {
    getDbMock,
    extractDomainSemanticProfileMock,
    getInferenceModelMock,
    createGenerateSemanticProfileFnMock,
    DomainNotFoundErrorMock,
} = vi.hoisted(() => ({
    getDbMock: vi.fn(),
    extractDomainSemanticProfileMock: vi.fn(),
    getInferenceModelMock: vi.fn(),
    createGenerateSemanticProfileFnMock: vi.fn(() => vi.fn()),
    DomainNotFoundErrorMock: class DomainNotFoundErrorMock extends Error {},
}));

vi.mock('@archi-navi/db', () => ({
    getDb: getDbMock,
}));

vi.mock('@archi-navi/inference', () => ({
    DomainNotFoundError: DomainNotFoundErrorMock,
    extractDomainSemanticProfile: extractDomainSemanticProfileMock,
}));

vi.mock('@/lib/inference-llm', () => ({
    getInferenceModel: getInferenceModelMock,
    createGenerateSemanticProfileFn: createGenerateSemanticProfileFnMock,
}));

import { POST } from '@/app/api/domains/[id]/extract-semantic/route';

function makeContext(domainId = 'dom-1') {
    return { params: Promise.resolve({ id: domainId }) };
}

describe('POST /api/domains/[id]/extract-semantic', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('malformed JSON body 는 400 BAD_REQUEST 를 반환한다', async () => {
        const res = await POST(
            new Request('http://localhost/api/domains/dom-1/extract-semantic', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{',
            }),
            makeContext(),
        );

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({
            success: false,
            error: { code: 'BAD_REQUEST' },
        });
        expect(getInferenceModelMock).not.toHaveBeenCalled();
        expect(getDbMock).not.toHaveBeenCalled();
        expect(extractDomainSemanticProfileMock).not.toHaveBeenCalled();
    });

    it('workspaceId 가 없으면 400 BAD_REQUEST 를 반환한다', async () => {
        const res = await POST(
            new Request('http://localhost/api/domains/dom-1/extract-semantic', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ persist: true }),
            }),
            makeContext(),
        );

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({
            success: false,
            error: { code: 'BAD_REQUEST' },
        });
        expect(getInferenceModelMock).not.toHaveBeenCalled();
        expect(getDbMock).not.toHaveBeenCalled();
    });

    it('정상 요청은 semantic extraction 에 필요한 인자를 위임한다', async () => {
        const db = { name: 'db' };
        const generate = vi.fn();
        getDbMock.mockResolvedValue(db);
        getInferenceModelMock.mockReturnValue({
            model: { provider: 'openai' },
            modelName: 'gpt-4o',
        });
        createGenerateSemanticProfileFnMock.mockReturnValue(generate);
        extractDomainSemanticProfileMock.mockResolvedValue({
            profile: { responsibilities: ['주문 관리'] },
        });

        const res = await POST(
            new Request('http://localhost/api/domains/dom-1/extract-semantic', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspaceId: 'ws-1',
                    maxScenarios: 3,
                    persist: false,
                }),
            }),
            makeContext('dom-1'),
        );

        expect(res.status).toBe(200);
        expect(createGenerateSemanticProfileFnMock).toHaveBeenCalledWith(
            { provider: 'openai' },
            'gpt-4o',
        );
        expect(extractDomainSemanticProfileMock).toHaveBeenCalledWith(
            db,
            generate,
            expect.objectContaining({
                workspaceId: 'ws-1',
                domainId: 'dom-1',
                maxScenarios: 3,
                persist: false,
                llmModel: 'gpt-4o',
                generatedBy: 'api',
            }),
        );
        await expect(res.json()).resolves.toMatchObject({
            success: true,
            data: {
                profile: { responsibilities: ['주문 관리'] },
            },
        });
    });
});
