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
  createInferenceRun,
  executeSmartPipeline,
  getInferenceRunDetail,
  type ConfigAnalysisResult,
  type CallExtractionResult,
  type SmartAtomicAgentStep,
  type SmartAtomicAnalysisMode,
} from '@archi-navi/inference';
import {
  executeQueuedSmartInferenceRun,
  getSmartInferenceRunDetail,
} from '@/lib/smart-inference-runs';

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

const agentCallSchema = z.object({
  targetService: z.string(),
  httpMethod: z.string(),
  path: z.string(),
  sourceFile: z.string(),
  evidence: z.string(),
  confidence: z.number().min(0).max(1),
});

const smartAgentStepSchema = z.object({
  action: z.enum(['search_files', 'read_file', 'list_service_endpoints', 'finish']),
  serviceName: z.string().nullable(),
  query: z.string().nullable(),
  path: z.string().nullable(),
  limit: z.number().int().positive().max(10).nullable(),
  calls: z.array(agentCallSchema).nullable(),
  rationale: z.string().nullable(),
});

function normalizeSmartAgentStep(step: z.infer<typeof smartAgentStepSchema>): SmartAtomicAgentStep {
  return {
    action: step.action,
    ...(typeof step.serviceName === 'string' ? { serviceName: step.serviceName } : {}),
    ...(typeof step.query === 'string' ? { query: step.query } : {}),
    ...(typeof step.path === 'string' ? { path: step.path } : {}),
    ...(typeof step.limit === 'number' ? { limit: step.limit } : {}),
    ...(Array.isArray(step.calls) ? { calls: step.calls } : {}),
    ...(typeof step.rationale === 'string' ? { rationale: step.rationale } : {}),
  };
}

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
  async?: boolean;
  analysisMode?: SmartAtomicAnalysisMode;
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
    analysisMode?: SmartAtomicAnalysisMode;
    analyzedServiceCount: number;
    candidateCount: number;
    atomicCandidateCount?: number;
    serviceFallbackCount?: number;
    deepInspectionCount?: number;
    agentEscalatedPairCount?: number;
    agentRecoveredAtomicCount?: number;
    agentFailedPairCount?: number;
    agentToolUsageSummary?: {
      searchCalls?: number;
      readCalls?: number;
      endpointListCalls?: number;
      gatewayRouteCalls?: number;
      totalCalls?: number;
    };
    deepInspectionTrace?: {
      attemptedCount?: number;
      failureCount?: number;
      triggerBreakdown?: {
        lowConfidence?: number;
        insufficientContext?: number;
        pathNotMatched?: number;
        noEndpointObjects?: number;
      };
      details?: Array<{
        consumerServiceName?: string;
        providerServiceName?: string;
        trigger?: {
          lowConfidence?: boolean;
          insufficientContext?: boolean;
          pathNotMatched?: boolean;
          noEndpointObjects?: boolean;
        };
        status?: 'succeeded' | 'no_result' | 'failed';
        fallbackReasons?: Array<
          'NO_ENDPOINT_OBJECTS' | 'PATH_NOT_MATCHED' | 'METHOD_NOT_MATCHED' | 'INSUFFICIENT_CONTEXT'
        >;
        toolUsage?: {
          searchCalls?: number;
          readCalls?: number;
          endpointListCalls?: number;
          gatewayRouteCalls?: number;
          totalCalls?: number;
        };
        recoveredCall?: {
          httpMethod?: string;
          path?: string;
        } | null;
        recoveredCalls?: Array<{
          httpMethod?: string;
          path?: string;
        }>;
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
        pathNotMatched: detail.trigger?.pathNotMatched ?? false,
        noEndpointObjects: detail.trigger?.noEndpointObjects ?? false,
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
        gatewayRouteCalls: detail.toolUsage?.gatewayRouteCalls ?? 0,
        totalCalls: detail.toolUsage?.totalCalls ?? 0,
      },
      recoveredCalls: Array.isArray(detail.recoveredCalls)
        ? detail.recoveredCalls
          .filter((call) => typeof call?.httpMethod === 'string' && typeof call?.path === 'string')
          .map((call) => ({
            httpMethod: call.httpMethod as string,
            path: call.path as string,
          }))
        : detail.recoveredCall
          && typeof detail.recoveredCall.httpMethod === 'string'
          && typeof detail.recoveredCall.path === 'string'
            ? [{
              httpMethod: detail.recoveredCall.httpMethod,
              path: detail.recoveredCall.path,
            }]
            : [],
    }))
    : [];

  return {
    attemptedCount: trace?.attemptedCount ?? 0,
    failureCount: trace?.failureCount ?? 0,
    triggerBreakdown: {
      lowConfidence: trace?.triggerBreakdown?.lowConfidence ?? 0,
      insufficientContext: trace?.triggerBreakdown?.insufficientContext ?? 0,
      pathNotMatched: trace?.triggerBreakdown?.pathNotMatched ?? 0,
      noEndpointObjects: trace?.triggerBreakdown?.noEndpointObjects ?? 0,
    },
    details,
  };
}

function buildToolUsageSummary(
  toolUsage?: SmartSummarySource['phase3']['agentToolUsageSummary'],
) {
  return {
    searchCalls: toolUsage?.searchCalls ?? 0,
    readCalls: toolUsage?.readCalls ?? 0,
    endpointListCalls: toolUsage?.endpointListCalls ?? 0,
    gatewayRouteCalls: toolUsage?.gatewayRouteCalls ?? 0,
    totalCalls: toolUsage?.totalCalls ?? 0,
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
    analysisMode: result.phase3.analysisMode ?? 'pair_pack',
    bootstrapEndpointCount: result.phase1?.bootstrapEndpointCount ?? 0,
    servicePairCount: result.phase2.servicePairCount ?? 0,
    atomicCandidateCount: result.phase3.atomicCandidateCount ?? 0,
    serviceFallbackCount: result.phase3.serviceFallbackCount ?? 0,
    deepInspectionCount: result.phase3.deepInspectionCount ?? 0,
    agentEscalatedPairCount: result.phase3.agentEscalatedPairCount ?? 0,
    agentRecoveredAtomicCount: result.phase3.agentRecoveredAtomicCount ?? 0,
    agentFailedPairCount: result.phase3.agentFailedPairCount ?? 0,
    agentToolUsageSummary: buildToolUsageSummary(result.phase3.agentToolUsageSummary),
    deepInspectionTrace: buildDeepInspectionTrace(result.phase3.deepInspectionTrace),
    fallbackReasonBreakdown: buildFallbackReasonBreakdown(result.phase3.fallbackReasonBreakdown),
    candidatesCreated: result.phase3.candidateCount,
    phase2Count: result.phase2.analyzedServiceCount,
    phase3Count: result.phase3.analyzedServiceCount,
  };
}

async function collectSmartRepoRoots(
  workspaceId: string,
  body: SmartRunRequest,
) {
  const db = await getDb();

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

  const allRoots = [...new Set([...providedRoots, ...discoveredRoots])];
  const validRoots = allRoots
    .map((repoRoot) => {
      try {
        return resolve(repoRoot);
      } catch {
        return repoRoot;
      }
    })
    .filter((repoRoot) => {
      try {
        return existsSync(repoRoot) && statSync(repoRoot).isDirectory();
      } catch {
        return false;
      }
    });

  return {
    db,
    providedRoots,
    discoveredRoots,
    validRoots,
  };
}

// ── 라우트 핸들러 ───────────────────────────────────

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const workspaceId = url.searchParams.get('workspaceId')?.trim();
    const runId = url.searchParams.get('runId')?.trim();

    if (!workspaceId) {
      return NextResponse.json(
        { success: false, error: { code: 'BAD_REQUEST', message: 'workspaceId is required' } },
        { status: 400 },
      );
    }
    if (!runId) {
      return NextResponse.json(
        { success: false, error: { code: 'BAD_REQUEST', message: 'runId is required' } },
        { status: 400 },
      );
    }

    const db = await getDb();
    const { detail, summary } = await getSmartInferenceRunDetail({ db, workspaceId, runId });

    return NextResponse.json({
      success: true,
      summary,
      run: detail.run,
      sources: detail.sources,
      events: detail.events,
      data: summary ? { summary } : {},
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('찾을 수 없습니다')) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: error.message } },
        { status: 404 },
      );
    }

    console.error('[GET /api/inference/smart]', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Smart 추론 실행 상태 조회 중 오류가 발생했습니다.',
        },
      },
      { status: 500 },
    );
  }
}

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

    const {
      db,
      validRoots,
    } = await collectSmartRepoRoots(workspaceId, body);

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

    const generateAgentStep = async (prompt: string): Promise<SmartAtomicAgentStep> => {
      const result = await generateObject({
        model: modelInfo.model,
        schema: smartAgentStepSchema,
        prompt,
        temperature: 0.1,
      });
      return normalizeSmartAgentStep(result.object);
    };

    if (body.async === true) {
      const run = await createInferenceRun(db, {
        workspaceId,
        triggerType: 'SMART_PIPELINE',
        modes: ['config', 'code'],
        sources: validRoots.map((repoRoot) => ({ type: 'local', ref: repoRoot })),
      });

      queueMicrotask(() => {
        void executeQueuedSmartInferenceRun({
          db,
          workspaceId,
          runId: run.id,
          repoRoots: validRoots,
          modelName: modelInfo.modelName,
          buildSummary: buildSmartSummary,
          generateConfigAnalysis,
          generateCallExtraction,
          generateAgentStep,
          analysisMode: body.analysisMode ?? 'agent_assisted',
        }).catch((error) => {
          console.error('[POST /api/inference/smart] async execute failed', error);
        });
      });

      const detail = await getInferenceRunDetail(db, { workspaceId, runId: run.id });
      return NextResponse.json(
        {
          success: true,
          queued: true,
          runId: run.id,
          run: detail.run,
          sources: detail.sources,
        },
        { status: 202 },
      );
    }

    const pipelineResult = await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: validRoots,
      generateConfigAnalysis,
      generateCallExtraction,
      generateAgentStep,
      atomicAnalysisMode: body.analysisMode ?? 'pair_pack',
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
