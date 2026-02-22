/**
 * POST /api/inference/llm-filter — LLM 기반 추론 후보 필터링
 * Vercel AI SDK + Zod 구조화 응답으로 후보 검증
 * 설계 참조: docs/09-llm-inference-filtering.md §7
 */
import { NextResponse } from 'next/server';
import { generateObject } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { getDb } from '@archi-navi/db';
import { DEFAULT_WORKSPACE_ID } from '@archi-navi/shared';
import {
  filterCandidates,
  buildRelationAssessmentPrompt,
  type GenerateAssessmentFn,
  type CandidateContext,
  type LlmAssessment,
} from '@archi-navi/inference';

/** Zod 스키마: LLM 응답 구조 */
const assessmentSchema = z.object({
  verdict: z.enum(['LIKELY_VALID', 'UNCERTAIN', 'LIKELY_FALSE_POSITIVE']),
  confidenceAdjustment: z.number().min(-0.3).max(0.2),
  reasoning: z.string(),
  reviewPriority: z.enum(['HIGH', 'MEDIUM', 'LOW']),
});

/** AI 제공자 선택 (헤더 오버라이드 → 환경변수 fallback) */
function getModel(req: Request): { model: LanguageModel; modelName: string } | null {
  const headerProvider = req.headers.get('x-ai-provider');
  const headerApiKey = req.headers.get('x-ai-api-key');
  const headerModel = req.headers.get('x-ai-model');

  const provider = headerProvider ?? process.env['AI_PROVIDER'] ?? 'openai';

  // API 키 존재 여부 확인
  const hasKey =
    !!headerApiKey ||
    !!process.env['OPENAI_API_KEY'] ||
    !!process.env['ANTHROPIC_API_KEY'] ||
    !!process.env['GOOGLE_GENERATIVE_AI_API_KEY'];

  if (!hasKey) return null;

  switch (provider) {
    case 'anthropic': {
      const modelName = headerModel ?? 'claude-3-5-sonnet-20241022';
      if (headerApiKey) process.env['ANTHROPIC_API_KEY'] = headerApiKey;
      return { model: anthropic(modelName), modelName };
    }
    case 'google': {
      const modelName = headerModel ?? 'gemini-1.5-pro';
      if (headerApiKey) process.env['GOOGLE_GENERATIVE_AI_API_KEY'] = headerApiKey;
      return { model: google(modelName), modelName };
    }
    default: {
      const modelName = headerModel ?? 'gpt-4o';
      if (headerApiKey) process.env['OPENAI_API_KEY'] = headerApiKey;
      return { model: openai(modelName), modelName };
    }
  }
}

/** Vercel AI SDK 기반 GenerateAssessmentFn 생성 */
function createGenerateFn(
  aiModel: LanguageModel,
  modelName: string,
): GenerateAssessmentFn {
  return async (prompt: string, _context: CandidateContext): Promise<LlmAssessment> => {
    const result = await generateObject({
      model: aiModel,
      schema: assessmentSchema,
      prompt,
      temperature: 0.2,
    });

    return {
      ...result.object,
      model: modelName,
      assessedAt: new Date().toISOString(),
    };
  };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      workspaceId?: string;
      candidateIds?: string[];
      batchSize?: number;
    };

    // LLM 제공자 확인
    const modelInfo = getModel(req);
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

    const db = await getDb();
    const generateFn = createGenerateFn(modelInfo.model, modelInfo.modelName);

    const result = await filterCandidates(db, generateFn, {
      workspaceId: body.workspaceId ?? DEFAULT_WORKSPACE_ID,
      candidateIds: body.candidateIds,
      batchSize: body.batchSize,
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
