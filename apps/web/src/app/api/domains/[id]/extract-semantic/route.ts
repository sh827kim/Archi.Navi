/**
 * POST /api/domains/[id]/extract-semantic — 도메인 의미 프로파일 추출 (LLM 호출)
 * 수동 트리거. body: { workspaceId, maxScenarios?, persist? }
 */
import { NextResponse } from 'next/server';
import { getDb } from '@archi-navi/db';
import { DomainNotFoundError, extractDomainSemanticProfile } from '@archi-navi/inference';
import {
    createGenerateSemanticProfileFn,
    getInferenceModel,
} from '@/lib/inference-llm';

export async function POST(
    req: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const { id: domainId } = await params;
        const body = (await req.json()) as {
            workspaceId?: string;
            maxScenarios?: number;
            persist?: boolean;
        };

        if (!body.workspaceId) {
            return NextResponse.json(
                { success: false, error: { code: 'BAD_REQUEST', message: 'workspaceId is required' } },
                { status: 400 },
            );
        }

        const modelInfo = getInferenceModel(req);
        if (!modelInfo) {
            return NextResponse.json(
                {
                    success: false,
                    error: {
                        code: 'LLM_NOT_CONFIGURED',
                        message: 'AI 제공자가 설정되지 않았습니다. 설정 > AI Settings에서 API 키를 입력해주세요.',
                    },
                },
                { status: 400 },
            );
        }

        const db = await getDb();
        const generate = createGenerateSemanticProfileFn(modelInfo.model, modelInfo.modelName);
        const result = await extractDomainSemanticProfile(db, generate, {
            workspaceId: body.workspaceId,
            domainId,
            llmModel: modelInfo.modelName,
            generatedBy: 'api',
            ...(typeof body.maxScenarios === 'number' ? { maxScenarios: body.maxScenarios } : {}),
            ...(typeof body.persist === 'boolean' ? { persist: body.persist } : {}),
        });

        return NextResponse.json({ success: true, data: result });
    } catch (error) {
        if (error instanceof DomainNotFoundError) {
            return NextResponse.json(
                { success: false, error: { code: 'DOMAIN_NOT_FOUND', message: error.message } },
                { status: 404 },
            );
        }
        console.error('[POST /api/domains/[id]/extract-semantic]', error);
        return NextResponse.json(
            {
                success: false,
                error: { code: 'INTERNAL_ERROR', message: '도메인 의미 추출 중 오류가 발생했습니다.' },
            },
            { status: 500 },
        );
    }
}
