/**
 * POST /api/inference/smart — Smart 3-Phase 추론 파이프라인
 *
 * Phase 1: OpenAPI spec → provider endpoint 확정
 * Phase 1.5: Code expose → provider endpoint bootstrap
 * Phase 2: Config files → LLM → Compound 의존성 그래프
 * Phase 3: Consumer 소스코드 → LLM → endpoint-level call 추출
 *
 * Vercel AI SDK를 사용하여 LLM 호출을 처리한다.
 */
import { NextResponse } from 'next/server';
import { generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb, objects } from '@archi-navi/db';
import { and, eq } from 'drizzle-orm';
import {
  executeSmartPipeline,
  type ConfigAnalysisResult,
  type CallExtractionResult,
} from '@archi-navi/inference';

// ── Zod 스키마: LLM 응답 구조 ───────────────────────

/** Phase 2: config 분석 응답 */
const configAnalysisSchema = z.object({
  dependencies: z.array(z.object({
    targetService: z.string(),
    relationType: z.enum(['call', 'depend_on', 'read', 'write', 'produce', 'consume']),
    evidence: z.string(),
    confidence: z.number().min(0).max(1),
  })),
  detectedServiceName: z.string().nullable(),
});

/** Phase 3: 호출 추출 응답 */
const callExtractionSchema = z.object({
  calls: z.array(z.object({
    targetService: z.string(),
    httpMethod: z.string(),
    path: z.string(),
    sourceFile: z.string(),
    evidence: z.string(),
    confidence: z.number().min(0).max(1),
  })),
});

// ── AI 모델 선택 ────────────────────────────────────

function resolveProviderApiKey(provider: string, headerApiKey: string | null): string | null {
  if (headerApiKey) return headerApiKey;

  switch (provider) {
    case 'anthropic':
      return process.env['ANTHROPIC_API_KEY'] ?? null;
    case 'google':
      return process.env['GOOGLE_GENERATIVE_AI_API_KEY'] ?? null;
    default:
      return process.env['OPENAI_API_KEY'] ?? null;
  }
}

function getModel(req: Request): { model: LanguageModel; modelName: string } | null {
  const headerProvider = req.headers.get('x-ai-provider');
  const headerApiKey = req.headers.get('x-ai-api-key');
  const headerModel = req.headers.get('x-ai-model');

  const provider = headerProvider ?? process.env['AI_PROVIDER'] ?? 'openai';
  const apiKey = resolveProviderApiKey(provider, headerApiKey);
  if (!apiKey) return null;

  switch (provider) {
    case 'anthropic': {
      const modelName = headerModel ?? 'claude-haiku-4-5-20251001';
      const sdk = createAnthropic({ apiKey });
      return { model: sdk(modelName), modelName };
    }
    case 'google': {
      const modelName = headerModel ?? 'gemini-2.0-flash';
      const sdk = createGoogleGenerativeAI({ apiKey });
      return { model: sdk(modelName), modelName };
    }
    default: {
      const modelName = headerModel ?? 'gpt-4o-mini';
      const sdk = createOpenAI({ apiKey });
      return { model: sdk(modelName), modelName };
    }
  }
}

// ── 요청 타입 ───────────────────────────────────────

interface SmartRunRequest {
  workspaceId?: string;
  repoRoots?: string[];
  useServiceMetadataPaths?: boolean;
}

interface SmartSummarySource {
  phase1?: {
    openApi?: unknown;
    bootstrapEndpointCount?: number;
  };
  phase2: {
    analyzedServiceCount: number;
    servicePairCount?: number;
  };
  phase3: {
    analyzedServiceCount: number;
    candidateCount: number;
    atomicCandidateCount?: number;
    serviceFallbackCount?: number;
    deepInspectionCount?: number;
    deepInspectionTrace?: {
      attemptedCount?: number;
      failureCount?: number;
      triggerBreakdown?: {
        lowConfidence?: number;
        insufficientContext?: number;
      };
      details?: Array<{
        consumerServiceName?: string;
        providerServiceName?: string;
        trigger?: {
          lowConfidence?: boolean;
          insufficientContext?: boolean;
        };
        status?: 'succeeded' | 'no_result' | 'failed';
        fallbackReasons?: Array<
          'NO_ENDPOINT_OBJECTS' | 'PATH_NOT_MATCHED' | 'METHOD_NOT_MATCHED' | 'INSUFFICIENT_CONTEXT'
        >;
        toolUsage?: {
          searchCalls?: number;
          readCalls?: number;
          endpointListCalls?: number;
          totalCalls?: number;
        };
        recoveredCall?: {
          httpMethod?: string;
          path?: string;
        } | null;
      }>;
    };
    fallbackReasonBreakdown?: Partial<Record<
      'NO_ENDPOINT_OBJECTS' | 'PATH_NOT_MATCHED' | 'METHOD_NOT_MATCHED' | 'INSUFFICIENT_CONTEXT',
      number
    >>;
  };
}

function buildDeepInspectionTrace(
  trace?: SmartSummarySource['phase3']['deepInspectionTrace'],
) {
  const details = Array.isArray(trace?.details)
    ? trace.details.map((detail) => ({
      consumerServiceName: detail.consumerServiceName ?? '',
      providerServiceName: detail.providerServiceName ?? '',
      trigger: {
        lowConfidence: detail.trigger?.lowConfidence ?? false,
        insufficientContext: detail.trigger?.insufficientContext ?? false,
      },
      status:
        detail.status === 'failed'
          ? 'failed'
          : detail.status === 'no_result'
            ? 'no_result'
            : 'succeeded',
      fallbackReasons: Array.isArray(detail.fallbackReasons)
        ? detail.fallbackReasons.filter((reason) => (
          reason === 'NO_ENDPOINT_OBJECTS'
          || reason === 'PATH_NOT_MATCHED'
          || reason === 'METHOD_NOT_MATCHED'
          || reason === 'INSUFFICIENT_CONTEXT'
        ))
        : [],
      toolUsage: {
        searchCalls: detail.toolUsage?.searchCalls ?? 0,
        readCalls: detail.toolUsage?.readCalls ?? 0,
        endpointListCalls: detail.toolUsage?.endpointListCalls ?? 0,
        totalCalls: detail.toolUsage?.totalCalls ?? 0,
      },
      recoveredCall:
        detail.recoveredCall
        && typeof detail.recoveredCall.httpMethod === 'string'
        && typeof detail.recoveredCall.path === 'string'
          ? {
            httpMethod: detail.recoveredCall.httpMethod,
            path: detail.recoveredCall.path,
          }
          : null,
    }))
    : [];

  return {
    attemptedCount: trace?.attemptedCount ?? 0,
    failureCount: trace?.failureCount ?? 0,
    triggerBreakdown: {
      lowConfidence: trace?.triggerBreakdown?.lowConfidence ?? 0,
      insufficientContext: trace?.triggerBreakdown?.insufficientContext ?? 0,
    },
    details,
  };
}

function buildFallbackReasonBreakdown(
  breakdown?: SmartSummarySource['phase3']['fallbackReasonBreakdown'],
) {
  return {
    NO_ENDPOINT_OBJECTS: breakdown?.NO_ENDPOINT_OBJECTS ?? 0,
    PATH_NOT_MATCHED: breakdown?.PATH_NOT_MATCHED ?? 0,
    METHOD_NOT_MATCHED: breakdown?.METHOD_NOT_MATCHED ?? 0,
    INSUFFICIENT_CONTEXT: breakdown?.INSUFFICIENT_CONTEXT ?? 0,
  };
}

function buildSmartSummary(result: SmartSummarySource) {
  return {
    bootstrapEndpointCount: result.phase1?.bootstrapEndpointCount ?? 0,
    servicePairCount: result.phase2.servicePairCount ?? 0,
    atomicCandidateCount: result.phase3.atomicCandidateCount ?? 0,
    serviceFallbackCount: result.phase3.serviceFallbackCount ?? 0,
    deepInspectionCount: result.phase3.deepInspectionCount ?? 0,
    deepInspectionTrace: buildDeepInspectionTrace(result.phase3.deepInspectionTrace),
    fallbackReasonBreakdown: buildFallbackReasonBreakdown(result.phase3.fallbackReasonBreakdown),
    candidatesCreated: result.phase3.candidateCount,
    phase2Count: result.phase2.analyzedServiceCount,
    phase3Count: result.phase3.analyzedServiceCount,
  };
}

// ── 라우트 핸들러 ───────────────────────────────────

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as SmartRunRequest;
    const workspaceId = body.workspaceId;
    if (!workspaceId) {
      return NextResponse.json(
        { success: false, error: { code: 'BAD_REQUEST', message: 'workspaceId is required' } },
        { status: 400 },
      );
    }

    // LLM 모델 확인
    const modelInfo = getModel(req);
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

    // repoRoots 수집 (제공된 것 + 서비스 metadata에서 발견된 것)
    const providedRoots = (body.repoRoots ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
    const discoveredRoots: string[] = [];

    if (body.useServiceMetadataPaths !== false) {
      const services = await db
        .select({ metadata: objects.metadata })
        .from(objects)
        .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'service')));

      for (const svc of services) {
        const meta = (svc.metadata ?? {}) as Record<string, unknown>;
        const rawPath = meta['scanPath'];
        if (typeof rawPath === 'string' && rawPath.trim().length > 0) {
          discoveredRoots.push(rawPath.trim());
        }
      }
    }

    // 유효한 로컬 경로만 필터
    const allRoots = [...new Set([...providedRoots, ...discoveredRoots])];
    const validRoots = allRoots.filter((p) => {
      try {
        const resolved = resolve(p);
        return existsSync(resolved) && statSync(resolved).isDirectory();
      } catch {
        return false;
      }
    });

    if (validRoots.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'NO_REPO_ROOTS',
            message: 'Smart 추론을 실행할 유효한 로컬 경로가 없습니다.',
          },
        },
        { status: 400 },
      );
    }

    // LLM 함수 생성 (Vercel AI SDK generateObject)
    const generateConfigAnalysis = async (prompt: string): Promise<ConfigAnalysisResult> => {
      const result = await generateObject({
        model: modelInfo.model,
        schema: configAnalysisSchema,
        prompt,
        temperature: 0.1,
      });
      return result.object;
    };

    const generateCallExtraction = async (prompt: string): Promise<CallExtractionResult> => {
      const result = await generateObject({
        model: modelInfo.model,
        schema: callExtractionSchema,
        prompt,
        temperature: 0.1,
      });
      return result.object;
    };

    // Smart 파이프라인 실행
    const pipelineResult = await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: validRoots,
      generateConfigAnalysis,
      generateCallExtraction,
    });
    const summary = buildSmartSummary(pipelineResult);

    return NextResponse.json({
      success: true,
      summary,
      data: {
        ...pipelineResult,
        summary,
        model: modelInfo.modelName,
        repoRoots: validRoots,
      },
    });
  } catch (error) {
    console.error('[POST /api/inference/smart]', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Smart 추론 파이프라인 처리 중 오류가 발생했습니다.',
        },
      },
      { status: 500 },
    );
  }
}
