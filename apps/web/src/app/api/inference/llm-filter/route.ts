/**
 * POST /api/inference/llm-filter — LLM 기반 추론 후보 필터링
 * Vercel AI SDK + Zod 구조화 응답으로 후보 검증
 * 설계 참조: docs/09-llm-inference-filtering.md §7
 */
import { NextResponse } from 'next/server';
import { getDb } from '@archi-navi/db';
import {
  filterCandidates,
  generateCandidateExplanations,
} from '@archi-navi/inference';
import {
  createGenerateAssessmentFn,
  createGenerateExplanationFn,
  getInferenceModel,
} from '@/lib/inference-llm';

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      workspaceId?: string;
      candidateIds?: string[];
      batchSize?: number;
      generateExplanations?: boolean;
      maxCalls?: number;
    };

    const workspaceId = body.workspaceId;
    if (!workspaceId) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'BAD_REQUEST',
            message: 'workspaceId is required',
          },
        },
        { status: 400 },
      );
    }

    const isExplanationRequest = Object.prototype.hasOwnProperty.call(
      body,
      'generateExplanations',
    );

    const db = await getDb();

    if (isExplanationRequest && body.generateExplanations === false) {
      const result = await generateCandidateExplanations(
        db,
        async () => ({}),
        {
          workspaceId,
          ...(body.candidateIds ? { candidateIds: body.candidateIds } : {}),
          generateExplanations: false,
          ...(typeof body.maxCalls === 'number' ? { maxCalls: body.maxCalls } : {}),
        },
      );

      return NextResponse.json({ success: true, data: result });
    }

    // LLM 제공자 확인
    const modelInfo = getInferenceModel(req);
    if (!modelInfo) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'LLM_NOT_CONFIGURED',
            message:
              'AI 제공자가 설정되지 않았습니다. 설정 > AI Settings에서 API 키를 입력해주세요.',
          },
        },
        { status: 400 },
      );
    }

    if (isExplanationRequest) {
      const result = await generateCandidateExplanations(
        db,
        createGenerateExplanationFn(modelInfo.model, modelInfo.modelName),
        {
          workspaceId,
          ...(body.candidateIds ? { candidateIds: body.candidateIds } : {}),
          generateExplanations: body.generateExplanations === true,
          ...(typeof body.maxCalls === 'number' ? { maxCalls: body.maxCalls } : {}),
        },
      );

      return NextResponse.json({ success: true, data: result });
    }

    const generateFn = createGenerateAssessmentFn(modelInfo.model, modelInfo.modelName);
    const result = await filterCandidates(db, generateFn, {
      workspaceId,
      ...(body.candidateIds ? { candidateIds: body.candidateIds } : {}),
      ...(body.batchSize ? { batchSize: body.batchSize } : {}),
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error('[POST /api/inference/llm-filter]', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'LLM 필터링 처리 중 오류가 발생했습니다.',
        },
      },
      { status: 500 },
    );
  }
}
