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
  GenerateDomainReviewFn,
  GenerateExplanationFn,
  GenerateSemanticProfileFn,
  GenerateSmartResolutionFn,
  LlmCandidateReview,
  LlmAssessment,
  LlmBoostContext,
  LlmBoostSuggestion,
  LlmExplanation,
  SemanticLlmDraft,
  SmartPatchProposal,
  SmartContradictionChallengeProposal,
  SmartProviderServiceSelectionProposal,
  SmartSummaryEnhancementProposal,
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

const smartEndpointDisambiguationProposalSchema = z.object({
  patchType: z.literal('endpoint_disambiguation'),
  resolved: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  endpointSelection: z.object({
    endpointId: z.string().nullable(),
    method: z.string().nullable(),
    path: z.string().nullable(),
  }).nullable(),
});

const smartMethodPathHintProposalSchema = z.object({
  patchType: z.literal('method_path_hint'),
  resolved: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  methodPathHint: z.object({
    method: z.string().nullable(),
    externalPath: z.string().nullable(),
  }).nullable(),
});

const smartProviderServiceSelectionProposalSchema = z.object({
  patchType: z.literal('provider_service_selection'),
  resolved: z.boolean(),
  selectedServiceId: z.string().nullable(),
  selectedServiceName: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  ranking: z.array(z.object({
    serviceId: z.string(),
    serviceName: z.string().nullable(),
    score: z.number().min(0).max(1).nullable(),
    reasoning: z.string().nullable(),
  })).nullable().optional().default(null),
});

const looseObjectSchema = z.object({}).passthrough();

const smartSummaryEnhancementProposalSchema = z.object({
  patchType: z.literal('function_summary_patch'),
  resolved: z.boolean(),
  functionId: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  summaryKind: z.enum(['http', 'db', 'message', 'mixed']).nullable().optional(),
  serviceId: z.string().nullable().optional(),
  outboundHttp: looseObjectSchema.nullable().optional(),
  outboundDb: looseObjectSchema.nullable().optional(),
  outboundMessage: looseObjectSchema.nullable().optional(),
  callChainHints: z.array(z.string()).nullable().optional(),
  aliasHints: z.array(z.string()).nullable().optional(),
  signalSources: z.array(z.string()).nullable().optional(),
  provenanceEvidenceIds: z.array(z.string()).nullable().optional(),
  extractionStrategy: z.string().nullable().optional(),
  unresolvedReasons: z.array(z.string()).nullable().optional(),
  summaryCompleteness: z.number().min(0).max(1).nullable().optional(),
  flags: looseObjectSchema.nullable().optional(),
  confidenceScore: z.number().min(0).max(1).nullable().optional(),
  evidenceIds: z.array(z.string()).nullable().optional(),
  patchRationale: z.string().nullable().optional(),
});

const smartContradictionChallengeProposalSchema = z.object({
  patchType: z.literal('contradiction_challenge'),
  shouldChallenge: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  challengeReasons: z.array(z.string()),
  expectedAction: z.enum(['reopen_frontier']).nullable(),
});

const smartPatchProposalSchema = z.object({
  patchType: z.enum([
    'alias_binding',
    'route_transform_patch',
    'endpoint_disambiguation',
    'method_path_hint',
    'provider_service_selection',
    'function_summary_patch',
    'contradiction_challenge',
  ]),
  resolved: z.boolean().optional(),
  selectedServiceId: z.string().nullable().optional(),
  selectedServiceName: z.string().nullable().optional(),
  functionId: z.string().optional(),
  shouldChallenge: z.boolean().optional(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  aliasBinding: smartAliasBindingProposalSchema.shape.aliasBinding.optional(),
  routeTransform: smartRouteTransformProposalSchema.shape.routeTransform.optional(),
  endpointSelection: smartEndpointDisambiguationProposalSchema.shape.endpointSelection.optional(),
  methodPathHint: smartMethodPathHintProposalSchema.shape.methodPathHint.optional(),
  ranking: smartProviderServiceSelectionProposalSchema.shape.ranking.optional(),
  summaryKind: smartSummaryEnhancementProposalSchema.shape.summaryKind.optional(),
  serviceId: smartSummaryEnhancementProposalSchema.shape.serviceId.optional(),
  outboundHttp: smartSummaryEnhancementProposalSchema.shape.outboundHttp.optional(),
  outboundDb: smartSummaryEnhancementProposalSchema.shape.outboundDb.optional(),
  outboundMessage: smartSummaryEnhancementProposalSchema.shape.outboundMessage.optional(),
  callChainHints: smartSummaryEnhancementProposalSchema.shape.callChainHints.optional(),
  aliasHints: smartSummaryEnhancementProposalSchema.shape.aliasHints.optional(),
  signalSources: smartSummaryEnhancementProposalSchema.shape.signalSources.optional(),
  provenanceEvidenceIds: smartSummaryEnhancementProposalSchema.shape.provenanceEvidenceIds.optional(),
  extractionStrategy: smartSummaryEnhancementProposalSchema.shape.extractionStrategy.optional(),
  unresolvedReasons: smartSummaryEnhancementProposalSchema.shape.unresolvedReasons.optional(),
  summaryCompleteness: smartSummaryEnhancementProposalSchema.shape.summaryCompleteness.optional(),
  flags: smartSummaryEnhancementProposalSchema.shape.flags.optional(),
  confidenceScore: smartSummaryEnhancementProposalSchema.shape.confidenceScore.optional(),
  evidenceIds: smartSummaryEnhancementProposalSchema.shape.evidenceIds.optional(),
  patchRationale: smartSummaryEnhancementProposalSchema.shape.patchRationale.optional(),
  challengeReasons: smartContradictionChallengeProposalSchema.shape.challengeReasons.optional(),
  expectedAction: smartContradictionChallengeProposalSchema.shape.expectedAction.optional(),
}).superRefine((proposal, ctx) => {
  if (proposal.patchType !== 'contradiction_challenge' && typeof proposal.resolved !== 'boolean') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${proposal.patchType} requires resolved`,
      path: ['resolved'],
    });
    return;
  }

  if (proposal.patchType === 'provider_service_selection') {
    if (proposal.resolved === false) return;

    if (typeof proposal.selectedServiceId === 'string' && proposal.selectedServiceId.length > 0) return;

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'provider_service_selection requires selectedServiceId when resolved is true',
      path: ['selectedServiceId'],
    });
    return;
  }

  if (proposal.patchType !== 'contradiction_challenge' || !proposal.shouldChallenge) return;
  if (Array.isArray(proposal.challengeReasons) && proposal.challengeReasons.length > 0) return;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'contradiction_challenge requires challengeReasons when shouldChallenge is true',
    path: ['challengeReasons'],
  });
});

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

function resolveGenerationSettings(modelName: string, temperature: number): { temperature?: number } {
  // GPT-5 계열은 temperature 파라미터를 지원하지 않아 warning 이 발생할 수 있다.
  if (modelName.toLowerCase().startsWith('gpt-5')) return {};
  return { temperature };
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
      ...resolveGenerationSettings(modelName, 0.2),
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
      ...resolveGenerationSettings(modelName, 0.2),
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
      ...resolveGenerationSettings(modelName, 0.1),
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

const domainSemanticDraftSchema = z.object({
  responsibility: z.string(),
  state: z.array(z.object({
    name: z.string(),
    type: z.string(),
    description: z.string(),
    evidenceIds: z.array(z.string()),
  })),
  actions: z.array(z.object({
    name: z.string(),
    description: z.string(),
    params: z.array(z.object({ name: z.string(), type: z.string() })),
    trigger: z.enum(['http', 'message', 'internal', 'scheduled']),
    evidenceIds: z.array(z.string()),
  })),
  invariants: z.array(z.object({
    description: z.string(),
    failureMode: z.string().nullable(),
    evidenceIds: z.array(z.string()),
  })),
  events: z.array(z.object({
    name: z.string(),
    direction: z.enum(['publish', 'consume']),
    channel: z.string(),
    description: z.string(),
    evidenceIds: z.array(z.string()),
  })),
  collaborators: z.array(z.object({
    targetDomainId: z.string().nullable(),
    targetObjectId: z.string(),
    targetName: z.string(),
    relationType: z.string(),
    reason: z.string(),
    evidenceIds: z.array(z.string()),
  })),
  scenarios: z.array(z.object({
    title: z.string(),
    steps: z.array(z.string()),
    entryPointObjectId: z.string(),
    evidenceIds: z.array(z.string()),
  })),
});

export function createGenerateSemanticProfileFn(
  aiModel: LanguageModel,
  modelName: string,
): GenerateSemanticProfileFn {
  return async (prompt: string, _inputs): Promise<SemanticLlmDraft> => {
    const result = await generateObject({
      model: aiModel,
      schema: domainSemanticDraftSchema,
      prompt,
      ...resolveGenerationSettings(modelName, 0.2),
    });
    return {
      ...result.object,
      invariants: result.object.invariants.map((invariant) => ({
        ...invariant,
        failureMode: invariant.failureMode ?? null,
      })),
    } as SemanticLlmDraft;
  };
}

const domainReviewSchema = z.object({
  coherent: z.boolean(),
  suggestedName: z.string(),
  responsibilityHint: z.string(),
  mergeWithCandidateId: z.string().nullable(),
});

export function createGenerateDomainReviewFn(
  aiModel: LanguageModel,
  modelName: string,
): GenerateDomainReviewFn {
  return async (prompt: string, _inputs): Promise<LlmCandidateReview> => {
    const result = await generateObject({
      model: aiModel,
      schema: domainReviewSchema,
      prompt,
      ...resolveGenerationSettings(modelName, 0.1),
    });
    return {
      ...result.object,
      mergeWithCandidateId: result.object.mergeWithCandidateId ?? null,
    } as LlmCandidateReview;
  };
}

export function createGenerateSmartResolutionFn(
  aiModel: LanguageModel,
  modelName: string,
): GenerateSmartResolutionFn<
  SmartPatchProposal | SmartSummaryEnhancementProposal | SmartProviderServiceSelectionProposal
> {
  return async (prompt: string) => {
    const result = await generateObject({
      model: aiModel,
      schema: smartPatchProposalSchema,
      prompt,
      ...resolveGenerationSettings(modelName, 0.1),
    });

    const usage = (result as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;

    return {
      model: modelName,
      promptTokens: usage?.inputTokens ?? 0,
      completionTokens: usage?.outputTokens ?? 0,
      object: result.object as
        | SmartPatchProposal
        | SmartSummaryEnhancementProposal
        | SmartProviderServiceSelectionProposal,
    };
  };
}
