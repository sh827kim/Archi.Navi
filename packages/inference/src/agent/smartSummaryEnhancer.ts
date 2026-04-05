import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
  functionSummaries,
  interactionIntents,
  objects,
  proofFrontiers,
  proofStates,
} from '@archi-navi/db';
import { smartProofLlmCalls } from '@archi-navi/db/schema';
import { generateId } from '@archi-navi/shared';
import type {
  ProofPatchType,
  ProofPatchValidationStatus,
} from '@/orchestration/intentProofEngine';
import { validateAndApplyProofPatch } from '@/orchestration/intentProofEngine';
import type { SmartProofConfig, SmartProofDecision } from './smartProofTypes';
import { resolveSmartProofDecision } from './smartProofTypes';
import type {
  GenerateSmartResolutionFn,
  SmartGenerateResolutionResult,
} from './smartFrontierResolver';

type JsonRecord = Record<string, unknown>;

export interface SmartSummaryEnhancementProposal {
  patchType: 'function_summary_patch';
  resolved: boolean;
  functionId: string;
  confidence: number;
  reasoning: string;
  summaryKind?: 'http' | 'db' | 'message' | 'mixed' | null;
  serviceId?: string | null;
  outboundHttp?: Record<string, unknown> | null;
  outboundDb?: Record<string, unknown> | null;
  outboundMessage?: Record<string, unknown> | null;
  callChainHints?: string[] | null;
  aliasHints?: string[] | null;
  signalSources?: string[] | null;
  provenanceEvidenceIds?: string[] | null;
  extractionStrategy?: string | null;
  unresolvedReasons?: string[] | null;
  summaryCompleteness?: number | null;
  flags?: Record<string, unknown> | null;
  confidenceScore?: number | null;
  evidenceIds?: string[] | null;
  patchRationale?: string | null;
}

export interface SmartSummaryEnhancementCandidate {
  proofStateId: string;
  intentId: string;
  frontierReason: string;
  functionId: string;
  functionName: string | null;
  serviceId: string;
  serviceName: string | null;
  sourceFilePath: string | null;
  snippet: string | null;
  snippetSource: string | null;
  currentSummary: {
    id: string;
    summaryVersion: number;
    summaryKind: string;
    extractionStrategy: string;
    summaryCompleteness: number;
    outboundHttp: Record<string, unknown> | null;
    outboundDb: Record<string, unknown> | null;
    outboundMessage: Record<string, unknown> | null;
    callChainHints: string[];
    aliasHints: string[];
    signalSources: string[];
    provenanceEvidenceIds: string[];
    unresolvedReasons: string[];
    flags: Record<string, unknown>;
    confidence: number;
  };
  intentContext: {
    intentType: string;
    methodHint: string | null;
    externalPathHint: string | null;
    hostHint: string | null;
  };
}

export interface ResolveSmartSummaryEnhancementInput {
  workspaceId: string;
  runId?: string | null;
  config: SmartProofConfig;
  candidate: SmartSummaryEnhancementCandidate;
  generateFn: GenerateSmartResolutionFn<SmartSummaryEnhancementProposal>;
}

export interface ResolveSmartSummaryEnhancementResult {
  proofStateId: string;
  functionId: string;
  attempted: boolean;
  enhanced: boolean;
  confidence: number;
  reasoning: string;
  decision: SmartProofDecision;
  patch: {
    patchType: 'function_summary_patch';
    payload: Record<string, unknown>;
    sourceKind: 'smart_agent';
  } | null;
  tokensUsed: {
    input: number;
    output: number;
  };
  validationStatus: ProofPatchValidationStatus | null;
  errors: string[];
  resolution: Awaited<ReturnType<typeof validateAndApplyProofPatch>>['resolution'] | null;
  llmCallId: string | null;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => asString(entry)).filter((entry): entry is string => entry !== null))];
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function getFilePathCandidates(input: {
  sourceFilePath: string | null;
  functionMetadata: Record<string, unknown> | null;
}): string[] {
  const metadata = input.functionMetadata ?? {};
  return [
    input.sourceFilePath,
    asString(metadata['sourceFilePath']),
    asString(metadata['filePath']),
    asString(metadata['absolutePath']),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function getSnippetLineRange(functionMetadata: Record<string, unknown> | null): { start: number; end: number } | null {
  const metadata = functionMetadata ?? {};
  const start =
    asNumber(metadata['startLine'])
    ?? asNumber(metadata['lineStart'])
    ?? asNumber(metadata['start'])
    ?? null;
  const end =
    asNumber(metadata['endLine'])
    ?? asNumber(metadata['lineEnd'])
    ?? asNumber(metadata['end'])
    ?? null;
  if (start === null || end === null) return null;
  const normalizedStart = Math.max(1, Math.floor(start));
  const normalizedEnd = Math.max(normalizedStart, Math.floor(end));
  return { start: normalizedStart, end: normalizedEnd };
}

function loadBestEffortSnippet(input: {
  sourceFilePath: string | null;
  functionMetadata: Record<string, unknown> | null;
}): { snippet: string | null; snippetSource: string | null } {
  for (const filePath of getFilePathCandidates(input)) {
    if (!existsSync(filePath)) continue;
    const fileContent = readFileSync(filePath, 'utf-8');
    const lines = fileContent.split(/\r?\n/u);
    const lineRange = getSnippetLineRange(input.functionMetadata);
    if (lineRange) {
      const sliceStart = Math.max(0, lineRange.start - 4);
      const sliceEnd = Math.min(lines.length, lineRange.end + 3);
      return {
        snippet: lines.slice(sliceStart, sliceEnd).join('\n').trim() || null,
        snippetSource: `${filePath}:${lineRange.start}-${lineRange.end}`,
      };
    }

    return {
      snippet: lines.slice(0, Math.min(lines.length, 40)).join('\n').trim() || null,
      snippetSource: filePath,
    };
  }

  return { snippet: null, snippetSource: null };
}

export function isSmartSummaryEnhancementCandidate(input: {
  extractionStrategy: string | null;
  summaryCompleteness: number | null;
  flags: unknown;
}): boolean {
  const flags = asRecord(input.flags) ?? {};
  const hasWeakSignals =
    flags['dynamicPath'] === true
    || flags['dynamicHost'] === true
    || flags['truncated'] === true;

  return input.extractionStrategy === 'legacy_edges_fallback'
    && hasWeakSignals
    && (input.summaryCompleteness ?? 1) < 0.6;
}

export function buildSmartSummaryEnhancementPrompt(
  candidate: SmartSummaryEnhancementCandidate,
): string {
  const summary = candidate.currentSummary;
  const currentSignals = [
    summary.outboundHttp ? `outboundHttp=${JSON.stringify(summary.outboundHttp)}` : null,
    summary.outboundDb ? `outboundDb=${JSON.stringify(summary.outboundDb)}` : null,
    summary.outboundMessage ? `outboundMessage=${JSON.stringify(summary.outboundMessage)}` : null,
  ].filter((entry): entry is string => entry !== null);

  return [
    'You are selectively improving a low-quality function summary for the Smart Proof Engine.',
    'Respond with patchType=function_summary_patch.',
    `Proof frontier reason: ${candidate.frontierReason}`,
    `Function id: ${candidate.functionId}`,
    `Function name: ${candidate.functionName ?? 'unknown'}`,
    `Source service: ${candidate.serviceName ?? candidate.serviceId}`,
    `Intent type: ${candidate.intentContext.intentType}`,
    `Method hint: ${candidate.intentContext.methodHint ?? 'unknown'}`,
    `External path hint: ${candidate.intentContext.externalPathHint ?? 'unknown'}`,
    `Host hint: ${candidate.intentContext.hostHint ?? 'unknown'}`,
    `Current summary version: ${summary.summaryVersion}`,
    `Current summary kind: ${summary.summaryKind}`,
    `Current extraction strategy: ${summary.extractionStrategy}`,
    `Current completeness: ${summary.summaryCompleteness.toFixed(2)}`,
    `Current flags: ${JSON.stringify(summary.flags)}`,
    `Current unresolved reasons: ${JSON.stringify(summary.unresolvedReasons)}`,
    currentSignals.length > 0 ? currentSignals.join('\n') : 'Current outbound signals: none',
    candidate.snippetSource ? `Snippet source: ${candidate.snippetSource}` : 'Snippet source: unavailable',
    candidate.snippet ? `Code snippet:\n${candidate.snippet}` : 'Code snippet: unavailable',
    'Rules:',
    '- Keep functionId unchanged.',
    '- Prefer concrete outboundHttp/outboundDb/outboundMessage only when supported by the snippet/context.',
    '- If evidence is insufficient, set resolved=false.',
    '- Do not invent service ids or endpoint ids.',
    '- summaryCompleteness should reflect the improved summary quality between 0 and 1.',
  ].join('\n');
}

function buildFunctionSummaryPatchPayload(
  candidate: SmartSummaryEnhancementCandidate,
  proposal: SmartSummaryEnhancementProposal,
): { patchType: 'function_summary_patch'; payload: Record<string, unknown>; sourceKind: 'smart_agent' } | null {
  const outboundHttp = asRecord(proposal.outboundHttp);
  const outboundDb = asRecord(proposal.outboundDb);
  const outboundMessage = asRecord(proposal.outboundMessage);

  if (!outboundHttp && !outboundDb && !outboundMessage) {
    return null;
  }

  const currentSignals = new Set(candidate.currentSummary.signalSources);
  currentSignals.add('smart_summary_enhancer');

  return {
    patchType: 'function_summary_patch',
    sourceKind: 'smart_agent',
    payload: {
      functionId: candidate.functionId,
      serviceId: candidate.serviceId,
      summaryKind: proposal.summaryKind ?? candidate.currentSummary.summaryKind ?? 'mixed',
      outboundHttp,
      outboundDb,
      outboundMessage,
      callChainHints:
        proposal.callChainHints && proposal.callChainHints.length > 0
          ? proposal.callChainHints
          : candidate.currentSummary.callChainHints,
      aliasHints:
        proposal.aliasHints && proposal.aliasHints.length > 0
          ? proposal.aliasHints
          : candidate.currentSummary.aliasHints,
      signalSources:
        proposal.signalSources && proposal.signalSources.length > 0
          ? [...new Set([...proposal.signalSources, ...currentSignals])]
          : Array.from(currentSignals),
      provenanceEvidenceIds:
        proposal.provenanceEvidenceIds && proposal.provenanceEvidenceIds.length > 0
          ? proposal.provenanceEvidenceIds
          : candidate.currentSummary.provenanceEvidenceIds,
      extractionStrategy: proposal.extractionStrategy ?? 'mixed_signals',
      unresolvedReasons: proposal.unresolvedReasons ?? [],
      summaryCompleteness: clamp01(
        proposal.summaryCompleteness
        ?? Math.max(candidate.currentSummary.summaryCompleteness, 0.8),
      ),
      flags: {
        ...candidate.currentSummary.flags,
        ...(asRecord(proposal.flags) ?? {}),
        enhancedBySmartProof: true,
      },
      confidence: clamp01(
        proposal.confidenceScore
        ?? proposal.confidence
        ?? candidate.currentSummary.confidence,
      ),
      evidenceIds: proposal.evidenceIds ?? [],
      patchRationale: proposal.patchRationale ?? proposal.reasoning,
    },
  };
}

async function insertSmartSummaryEnhancementCall(
  db: DbClient,
  input: {
    workspaceId: string;
    runId: string | null;
    candidate: SmartSummaryEnhancementCandidate;
    prompt: string;
    response: SmartSummaryEnhancementProposal;
    generated: SmartGenerateResolutionResult<SmartSummaryEnhancementProposal>;
    accepted: boolean | null;
    patchId?: string | null;
  },
): Promise<string> {
  const id = generateId();
  await db.insert(smartProofLlmCalls).values({
    id,
    workspaceId: input.workspaceId,
    runId: input.runId ?? null,
    proofStateId: input.candidate.proofStateId,
    callCategory: 'pre_resolution_enhancement',
    frontierReason: input.candidate.frontierReason,
    model: input.generated.model,
    inputTokens: input.generated.promptTokens,
    outputTokens: input.generated.completionTokens,
    promptHash: sha256(input.prompt),
    responseHash: sha256(JSON.stringify(input.response)),
    promptSnapshot: { prompt: input.prompt },
    responseSnapshot: input.response,
    confidence: input.response.confidence,
    accepted: input.accepted,
    patchId: input.patchId ?? null,
  });
  return id;
}

function buildSkippedResult(
  input: ResolveSmartSummaryEnhancementInput,
  generated: SmartGenerateResolutionResult<SmartSummaryEnhancementProposal>,
  proposal: SmartSummaryEnhancementProposal,
  llmCallId: string,
): ResolveSmartSummaryEnhancementResult {
  return {
    proofStateId: input.candidate.proofStateId,
    functionId: input.candidate.functionId,
    attempted: true,
    enhanced: false,
    confidence: proposal.confidence,
    reasoning: proposal.reasoning,
    decision: 'SKIPPED',
    patch: null,
    tokensUsed: {
      input: generated.promptTokens,
      output: generated.completionTokens,
    },
    validationStatus: null,
    errors: [],
    resolution: null,
    llmCallId,
  };
}

export async function loadSmartSummaryEnhancementCandidates(
  db: DbClient,
  input: {
    workspaceId: string;
    proofStateIds: string[];
  },
): Promise<SmartSummaryEnhancementCandidate[]> {
  if (input.proofStateIds.length === 0) {
    return [];
  }

  const frontierRows = await db
    .select({
      proofStateId: proofStates.id,
      intentId: proofStates.intentId,
      frontierReason: proofFrontiers.frontierReason,
      sourceFunctionId: interactionIntents.sourceFunctionId,
      sourceFilePath: interactionIntents.sourceFilePath,
      intentType: interactionIntents.intentType,
      methodHint: interactionIntents.methodHint,
      externalPathHint: interactionIntents.externalPathHint,
      hostHint: interactionIntents.hostHint,
    })
    .from(proofStates)
    .innerJoin(proofFrontiers, eq(proofFrontiers.proofStateId, proofStates.id))
    .innerJoin(interactionIntents, eq(interactionIntents.id, proofStates.intentId))
    .where(
      and(
        eq(proofStates.workspaceId, input.workspaceId),
        eq(proofStates.status, 'FRONTIER'),
        inArray(proofStates.id, input.proofStateIds),
      ),
    );

  const functionIds = frontierRows
    .map((row) => row.sourceFunctionId)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (functionIds.length === 0) {
    return [];
  }

  const [summaryRows, functionRows] = await Promise.all([
    db
      .select()
      .from(functionSummaries)
      .where(
        and(
          eq(functionSummaries.workspaceId, input.workspaceId),
          eq(functionSummaries.status, 'ACTIVE'),
          inArray(functionSummaries.functionId, functionIds),
        ),
      ),
    db
      .select({
        id: objects.id,
        name: objects.name,
        parentId: objects.parentId,
        metadata: objects.metadata,
      })
      .from(objects)
      .where(and(eq(objects.workspaceId, input.workspaceId), inArray(objects.id, functionIds))),
  ]);
  const serviceIds = [...new Set(summaryRows.map((row) => row.serviceId))];
  const serviceRows = serviceIds.length === 0
    ? []
    : await db
      .select({
        id: objects.id,
        name: objects.name,
      })
      .from(objects)
      .where(and(eq(objects.workspaceId, input.workspaceId), inArray(objects.id, serviceIds)));

  const latestSummaryByFunction = new Map<string, typeof summaryRows[number]>();
  for (const row of summaryRows) {
    const current = latestSummaryByFunction.get(row.functionId);
    if (!current || row.summaryVersion > current.summaryVersion) {
      latestSummaryByFunction.set(row.functionId, row);
    }
  }
  const functionById = new Map(functionRows.map((row) => [row.id, row]));
  const serviceNameById = new Map(serviceRows.map((row) => [row.id, row.name]));

  const candidates: SmartSummaryEnhancementCandidate[] = [];
  for (const row of frontierRows) {
    if (!row.sourceFunctionId) continue;
    const summary = latestSummaryByFunction.get(row.sourceFunctionId);
    if (!summary) continue;
    if (!isSmartSummaryEnhancementCandidate({
      extractionStrategy: summary.extractionStrategy,
      summaryCompleteness: summary.summaryCompleteness,
      flags: summary.flags,
    })) {
      continue;
    }

    const functionObject = functionById.get(row.sourceFunctionId);
    const functionMetadata = asRecord(functionObject?.metadata);
    const { snippet, snippetSource } = loadBestEffortSnippet({
      sourceFilePath: row.sourceFilePath,
      functionMetadata,
    });

    candidates.push({
      proofStateId: row.proofStateId,
      intentId: row.intentId,
      frontierReason: row.frontierReason,
      functionId: row.sourceFunctionId,
      functionName: functionObject?.name ?? null,
      serviceId: summary.serviceId,
      serviceName: serviceNameById.get(summary.serviceId) ?? null,
      sourceFilePath: row.sourceFilePath,
      snippet,
      snippetSource,
      currentSummary: {
        id: summary.id,
        summaryVersion: summary.summaryVersion,
        summaryKind: summary.summaryKind,
        extractionStrategy: summary.extractionStrategy,
        summaryCompleteness: summary.summaryCompleteness,
        outboundHttp: asRecord(summary.outboundHttp),
        outboundDb: asRecord(summary.outboundDb),
        outboundMessage: asRecord(summary.outboundMessage),
        callChainHints: asStringArray(summary.callChainHints),
        aliasHints: asStringArray(summary.aliasHints),
        signalSources: asStringArray(summary.signalSources),
        provenanceEvidenceIds: asStringArray(summary.provenanceEvidenceIds),
        unresolvedReasons: asStringArray(summary.unresolvedReasons),
        flags: asRecord(summary.flags) ?? {},
        confidence: summary.confidence,
      },
      intentContext: {
        intentType: row.intentType,
        methodHint: row.methodHint,
        externalPathHint: row.externalPathHint,
        hostHint: row.hostHint,
      },
    });
  }

  return candidates;
}

export async function resolveSmartSummaryEnhancement(
  db: DbClient,
  input: ResolveSmartSummaryEnhancementInput,
): Promise<ResolveSmartSummaryEnhancementResult> {
  const prompt = buildSmartSummaryEnhancementPrompt(input.candidate);
  const generated = await input.generateFn(prompt);
  const proposal = generated.object;

  if (!proposal.resolved) {
    const llmCallId = await insertSmartSummaryEnhancementCall(db, {
      workspaceId: input.workspaceId,
      runId: input.runId ?? null,
      candidate: input.candidate,
      prompt,
      response: proposal,
      generated,
      accepted: false,
    });
    return buildSkippedResult(input, generated, proposal, llmCallId);
  }

  const disposition = resolveSmartProofDecision(input.config, proposal.confidence);
  const patch = buildFunctionSummaryPatchPayload(input.candidate, proposal);
  if (disposition === 'SKIPPED' || !patch) {
    const llmCallId = await insertSmartSummaryEnhancementCall(db, {
      workspaceId: input.workspaceId,
      runId: input.runId ?? null,
      candidate: input.candidate,
      prompt,
      response: proposal,
      generated,
      accepted: false,
    });
    return buildSkippedResult(input, generated, proposal, llmCallId);
  }

  const patchResult = await validateAndApplyProofPatch(db, {
    workspaceId: input.workspaceId,
    proofStateId: input.candidate.proofStateId,
    patchType: patch.patchType as ProofPatchType,
    payload: patch.payload,
    sourceKind: 'smart_agent',
    runId: input.runId ?? null,
    applyMode: disposition === 'PENDING_REVIEW' ? 'defer' : 'apply',
  });

  const decision: SmartProofDecision =
    patchResult.validationStatus === 'ACCEPTED'
      ? 'ACCEPTED'
      : patchResult.validationStatus === 'PENDING'
        ? 'PENDING_REVIEW'
        : 'SKIPPED';

  const llmCallId = await insertSmartSummaryEnhancementCall(db, {
    workspaceId: input.workspaceId,
    runId: input.runId ?? null,
    candidate: input.candidate,
    prompt,
    response: proposal,
    generated,
    accepted:
      patchResult.validationStatus === 'ACCEPTED'
        ? true
        : patchResult.validationStatus === 'PENDING'
          ? null
          : false,
    patchId: patchResult.patchId,
  });

  return {
    proofStateId: input.candidate.proofStateId,
    functionId: input.candidate.functionId,
    attempted: true,
    enhanced: patchResult.validationStatus === 'ACCEPTED',
    confidence: proposal.confidence,
    reasoning: proposal.reasoning,
    decision,
    patch,
    tokensUsed: {
      input: generated.promptTokens,
      output: generated.completionTokens,
    },
    validationStatus: patchResult.validationStatus,
    errors: patchResult.errors,
    resolution: patchResult.resolution,
    llmCallId,
  };
}
