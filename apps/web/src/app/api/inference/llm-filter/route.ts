/**
 * POST /api/inference/llm-filter — LLM 기반 추론 후보 필터링
 * Vercel AI SDK + Zod 구조화 응답으로 후보 검증
 * 설계 참조: docs/09-llm-inference-filtering.md §7
 */
import { NextResponse } from 'next/server';
import { generateObject } from 'ai';
import { openai, createOpenAI } from '@ai-sdk/openai';
import { anthropic, createAnthropic } from '@ai-sdk/anthropic';
import { google, createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { getDb } from '@archi-navi/db';
import {
  filterCandidates,
  generateCandidateExplanations,
  type GenerateAssessmentFn,
  type GenerateExplanationFn,
  type CandidateContext,
  type LlmAssessment,
  type LlmExplanation,
} from '@archi-navi/inference';

/** Zod 스키마: LLM 응답 구조 */
const assessmentSchema = z.object({
  verdict: z.enum(['LIKELY_VALID', 'UNCERTAIN', 'LIKELY_FALSE_POSITIVE']),
  confidenceAdjustment: z.number().min(-0.3).max(0.2),
  reasoning: z.string(),
  reviewPriority: z.enum(['HIGH', 'MEDIUM', 'LOW']),
});

const explanationSchema = z.object({
  explanations: z.array(z.object({
    candidateId: z.string(),
    summary: z.string(),
  })),
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

  // W-8.2: process.env 동적 덮어쓰기 대신 SDK factory로 인스턴스 생성
  switch (provider) {
    case 'anthropic': {
      const modelName = headerModel ?? 'claude-3-5-sonnet-20241022';
      const sdk = headerApiKey ? createAnthropic({ apiKey: headerApiKey }) : anthropic;
      return { model: sdk(modelName), modelName };
    }
    case 'google': {
      const modelName = headerModel ?? 'gemini-1.5-pro';
      const sdk = headerApiKey ? createGoogleGenerativeAI({ apiKey: headerApiKey }) : google;
      return { model: sdk(modelName), modelName };
    }
    default: {
      const modelName = headerModel ?? 'gpt-4o';
      const sdk = headerApiKey ? createOpenAI({ apiKey: headerApiKey }) : openai;
      return { model: sdk(modelName), modelName };
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

function createGenerateExplanationFn(
  aiModel: LanguageModel,
  modelName: string,
): GenerateExplanationFn {
  return async (prompt: string): Promise<Record<string, LlmExplanation>> => {
    const result = await generateObject({
      model: aiModel,
      schema: explanationSchema,
      prompt,
      temperature: 0.2,
    });

    const explainedAt = new Date().toISOString();
    return Object.fromEntries(
      result.object.explanations.map((item) => [
        item.candidateId,
        {
          summary: item.summary,
          model: modelName,
          explainedAt,
        },
      ]),
    );
  };
}

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

    const generateFn = createGenerateFn(modelInfo.model, modelInfo.modelName);
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
