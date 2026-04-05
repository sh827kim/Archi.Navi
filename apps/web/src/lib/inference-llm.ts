import { generateObject } from 'ai';
import type { LanguageModel } from 'ai';
import { openai, createOpenAI } from '@ai-sdk/openai';
import { anthropic, createAnthropic } from '@ai-sdk/anthropic';
import { google, createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import type {
  CandidateContext,
  GenerateAssessmentFn,
  GenerateBoostSuggestionFn,
  GenerateDomainLabelFn,
  GenerateExplanationFn,
  GenerateSmartResolutionFn,
  LlmAssessment,
  LlmBoostContext,
  LlmBoostSuggestion,
  LlmExplanation,
  DomainLabelContext,
  DomainLabelSuggestion,
  SmartPatchProposal,
} from '@archi-navi/inference';

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

const boostSuggestionSchema = z.union([
  z.object({
    targetServiceName: z.string(),
    relationType: z.enum(['call', 'depend_on', 'read', 'write', 'produce', 'consume']),
    confidence: z.number().min(0.5).max(0.7).optional(),
    reasoning: z.string(),
  }),
  z.null(),
]);

const domainLabelSchema = z.object({
  ko: z.string(),
  en: z.string(),
});

const smartAliasBindingProposalSchema = z.object({
  patchType: z.literal('alias_binding'),
  resolved: z.boolean(),
  selectedServiceId: z.string().nullable(),
  selectedServiceName: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  aliasBinding: z.object({
    aliasKey: z.string(),
    aliasValue: z.string(),
    bindingKind: z.enum(['base_url', 'service_discovery', 'gateway_target', 'property_alias']),
  }).nullable(),
});

const smartRouteTransformProposalSchema = z.object({
  patchType: z.literal('route_transform_patch'),
  resolved: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  routeTransform: z.object({
    gatewayKind: z.string().nullable(),
    matchPath: z.string().nullable(),
    targetServiceHint: z.string().nullable(),
    targetHostAlias: z.string().nullable(),
    priority: z.number().int().nullable(),
  }).nullable(),
});

const smartPatchProposalSchema = z.discriminatedUnion('patchType', [
  smartAliasBindingProposalSchema,
  smartRouteTransformProposalSchema,
]);

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

export function getInferenceModel(req: Request): { model: LanguageModel; modelName: string } | null {
  const headerProvider = req.headers.get('x-ai-provider');
  const headerApiKey = req.headers.get('x-ai-api-key');
  const headerModel = req.headers.get('x-ai-model');

  const provider = headerProvider ?? process.env['AI_PROVIDER'] ?? 'openai';
  const apiKey = resolveProviderApiKey(provider, headerApiKey);
  if (!apiKey) return null;

  switch (provider) {
    case 'anthropic': {
      const modelName = headerModel ?? 'claude-3-5-sonnet-20241022';
      const sdk = headerApiKey ? createAnthropic({ apiKey }) : anthropic;
      return { model: sdk(modelName), modelName };
    }
    case 'google': {
      const modelName = headerModel ?? 'gemini-1.5-pro';
      const sdk = headerApiKey ? createGoogleGenerativeAI({ apiKey }) : google;
      return { model: sdk(modelName), modelName };
    }
    default: {
      const modelName = headerModel ?? 'gpt-4o';
      const sdk = headerApiKey ? createOpenAI({ apiKey }) : openai;
      return { model: sdk(modelName), modelName };
    }
  }
}

export function resolveMaxCalls(requested?: number): number {
  const envValue =
    process.env['LLM_MAX_CALLS_PER_RUN']
    ?? process.env['llm_max_calls_per_run']
    ?? '50';
  const envMax = Number.parseInt(envValue, 10);
  const fallback = Number.isFinite(envMax) ? Math.max(envMax, 0) : 50;
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return fallback;
  return Math.max(0, Math.min(requested, fallback));
}

export function createGenerateAssessmentFn(
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

export function createGenerateExplanationFn(
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

export function createGenerateBoostSuggestionFn(
  aiModel: LanguageModel,
  modelName: string,
): GenerateBoostSuggestionFn {
  return async (context: LlmBoostContext): Promise<LlmBoostSuggestion | null> => {
    const prompt = [
      '당신은 코드 기반 서비스 호출 추론 보조기다.',
      '아래 정보만 보고 호출 대상 서비스를 하나 고르거나 확신이 없으면 빈 응답 대신 null 판단을 내려라.',
      `callerService=${context.callerServiceName}`,
      `calleeSymbol=${context.calleeSymbol}`,
      `filePath=${context.filePath ?? ''}`,
      `excerpt=${context.excerpt ?? ''}`,
      `candidateServices=${context.candidateServices.join(', ')}`,
      '출력 제약: relationType은 call/depend_on/read/write/produce/consume 중 하나, confidence는 0.5~0.7.',
    ].join('\n');

    const result = await generateObject({
      model: aiModel,
      schema: boostSuggestionSchema,
      prompt,
      temperature: 0.1,
    });

    if (!result.object) return null;

    const confidence = result.object.confidence;
    return {
      targetServiceName: result.object.targetServiceName,
      relationType: result.object.relationType,
      ...(typeof confidence === 'number' ? { confidence } : {}),
      reasoning: `[${modelName}] ${result.object.reasoning}`,
    };
  };
}

export function createGenerateDomainLabelFn(
  aiModel: LanguageModel,
  _modelName: string,
): GenerateDomainLabelFn {
  return async (context: DomainLabelContext): Promise<DomainLabelSuggestion | null> => {
    const prompt = [
      '아래 도메인 클러스터에 대해 한국어/영어 도메인 이름을 각각 하나씩 제안하라.',
      `domainName=${context.domainName}`,
      `memberNames=${context.memberNames.join(', ')}`,
      `labelCandidates=${context.labelCandidates.map((item) => item.text).join(', ')}`,
      '응답은 간결한 명사구로 작성한다.',
    ].join('\n');

    const result = await generateObject({
      model: aiModel,
      schema: domainLabelSchema,
      prompt,
      temperature: 0.2,
    });

    return result.object;
  };
}

export function createGenerateSmartResolutionFn(
  aiModel: LanguageModel,
  modelName: string,
): GenerateSmartResolutionFn<SmartPatchProposal> {
  return async (prompt: string) => {
    const result = await generateObject({
      model: aiModel,
      schema: smartPatchProposalSchema,
      prompt,
      temperature: 0.1,
    });

    const usage = (result as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;

    return {
      model: modelName,
      promptTokens: usage?.inputTokens ?? 0,
      completionTokens: usage?.outputTokens ?? 0,
      object: result.object,
    };
  };
}
