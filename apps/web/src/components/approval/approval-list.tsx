/**
 * 승인 대기 목록 컴포넌트
 * PENDING 상태의 relation_candidates를 조회하고 승인/거부 처리
 *
 * - ATOMIC 후보: 소속 COMPOUND(서비스) 표시 + 승인/거부
 * - COMPOUND→COMPOUND 후보: 승인/거부 대신 "세부 매핑" 버튼 표시
 */
'use client';

import { useEffect, useState, useTransition, useCallback, useRef } from 'react';
import { Check, X, Sparkles, Link2, ChevronRight, Bot, FlaskConical, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Button, Badge, Spinner, ConfirmDialog,
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from '@archi-navi/ui';
import { useWorkspace } from '@/contexts/workspace-context';
import { EmptyStateGuide } from '@/components/shared/empty-state-guide';
import {
  getCrossValidationContradictionLabel,
  type CrossValidationContradiction,
} from '@/lib/cross-validation';
import { getClientAiRequestHeaders } from '@/lib/client-ai-settings';
import { buildInferencePipelineMeta, extractInferencePipelineMeta } from '@/lib/inference-pipeline';

/** 후보 관계 타입 (API 응답) */
interface RelationCandidate {
  id: string;
  subjectName: string;
  subjectGranularity: 'COMPOUND' | 'ATOMIC';
  subjectParentName: string | null;
  subjectObjectType: string | null;
  relationType: string;
  objectName: string;
  objectGranularity: 'COMPOUND' | 'ATOMIC';
  objectParentName: string | null;
  objectObjectType: string | null;
  objectId: string;
  subjectObjectId: string;
  confidence: number;
  source: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  llmExplanation?: {
    summary: string;
    model?: string;
    explainedAt?: string;
  };
  crossValidation?: {
    validated: boolean;
    supportCount: number;
    supportingSources: string[];
    contradictions?: CrossValidationContradiction[];
  };
  feedback?: RelationFeedbackMetadata;
  metadata?: {
    feedback?: RelationFeedbackMetadata;
    targetType?: 'api_endpoint' | 'db_table' | 'topic' | 'queue';
    [key: string]: unknown;
  };
}

interface RelationFeedbackMetadata {
  key: string;
  baseConfidence: number;
  adjustment: number;
  adjustedConfidence: number;
  applied: boolean;
  sampleCount: number;
}

interface ProofChainStep {
  id: string;
  type: string;
  status: string;
  summary: string;
}

interface FrontierEntry {
  id: string;
  reason: string;
  missingSlots: string[];
  snippets: string[];
  lastResolutionStep: string | null;
  agentPatched: boolean | null;
  retryable: boolean | null;
}

interface ProofPatchEntry {
  id: string;
  type: string;
  summary: string;
  status: string;
}

interface ProofChainMetadata {
  sourceService: string | null;
  sourceFunction: string | null;
  resolvedProviderEndpoint: string | null;
  routeChain: string[];
  supportingEvidence: string[];
  contradictions: string[];
  steps: ProofChainStep[];
  frontierHistory: FrontierEntry[];
  patchHistory: ProofPatchEntry[];
}

function getLlmExplanationSummary(candidate: RelationCandidate): string | null {
  const summary = candidate.llmExplanation?.summary;
  return typeof summary === 'string' && summary.trim().length > 0 ? summary.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asString(item)).filter((item): item is string => item !== null);
}

function getApiErrorMessage(payload: unknown, fallback: string): string {
  const record = asRecord(payload);
  if (!record) return fallback;

  if (typeof record.error === 'string' && record.error.trim().length > 0) {
    return record.error.trim();
  }

  const errorRecord = asRecord(record.error);
  if (typeof errorRecord?.message === 'string' && errorRecord.message.trim().length > 0) {
    return errorRecord.message.trim();
  }

  return fallback;
}

function parseProofChainSteps(value: unknown): ProofChainStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const record = asRecord(item);
    if (!record) return [];
    const type = asString(record.type ?? record.stepType) ?? 'step';
    const status = asString(record.status ?? record.state) ?? 'unknown';
    const summary = asString(record.summary ?? record.message ?? record.description) ?? '';
    return [{
      id: asString(record.id) ?? `step-${index}`,
      type,
      status,
      summary,
    }];
  });
}

function parseFrontierHistory(value: unknown): FrontierEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const record = asRecord(item);
    if (!record) return [];
    const reason = asString(
      record.reason ?? record.frontierReason ?? record.frontierCode ?? record.code,
    ) ?? 'UNKNOWN';
    const missingSlots = asStringArray(record.missingSlots ?? record.slots);
    const snippets = asStringArray(record.snippets ?? record.relevantSnippets);
    const lastResolutionStep = asString(record.lastResolutionStep ?? record.lastStep);
    const agentPatched = typeof record.agentPatched === 'boolean'
      ? record.agentPatched
      : typeof record.hasAgentPatch === 'boolean'
        ? record.hasAgentPatch
        : null;
    const retryable = typeof record.retryable === 'boolean'
      ? record.retryable
      : typeof record.recoverable === 'boolean'
        ? record.recoverable
        : null;

    return [{
      id: asString(record.id) ?? `frontier-${index}`,
      reason,
      missingSlots,
      snippets,
      lastResolutionStep,
      agentPatched,
      retryable,
    }];
  });
}

function parsePatchHistory(value: unknown): ProofPatchEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const record = asRecord(item);
    if (!record) return [];
    return [{
      id: asString(record.id) ?? `patch-${index}`,
      type: asString(record.type ?? record.patchType) ?? 'patch',
      summary: asString(record.summary ?? record.message ?? record.description) ?? '요약 없음',
      status: asString(record.status ?? record.state) ?? 'unknown',
    }];
  });
}

function getProofChainMetadata(candidate: RelationCandidate): ProofChainMetadata | null {
  const metadataRecord = asRecord(candidate.metadata);
  const proof = asRecord(metadataRecord?.proof);
  if (!proof) return null;

  const endpointRecord = asRecord(
    proof.resolvedProviderEndpoint
    ?? proof.providerEndpoint
    ?? proof.endpoint,
  );
  const endpointMethod = asString(endpointRecord?.method ?? proof.method);
  const endpointPath = asString(endpointRecord?.path ?? proof.path);
  const resolvedProviderEndpoint = endpointMethod && endpointPath
    ? `${endpointMethod} ${endpointPath}`
    : asString(endpointRecord?.name ?? endpointRecord?.displayName);

  const routeChain = asStringArray(proof.routeChain ?? proof.routes);
  const supportingEvidence = asStringArray(proof.supportingEvidence ?? proof.evidences ?? proof.evidence);
  const contradictions = Array.isArray(proof.contradictions)
    ? proof.contradictions
      .map((item) => {
        if (typeof item === 'string') return item;
        const record = asRecord(item);
        return asString(record?.type ?? record?.reason ?? record?.message);
      })
      .filter((item): item is string => item !== null)
    : [];
  const steps = parseProofChainSteps(proof.steps ?? proof.proofSteps);
  const frontierHistory = parseFrontierHistory(proof.frontierHistory ?? proof.frontiers);
  const patchHistory = parsePatchHistory(proof.patchHistory ?? proof.patches);

  const parsed: ProofChainMetadata = {
    sourceService: asString(
      proof.sourceService ?? proof.sourceServiceName ?? candidate.subjectParentName ?? candidate.subjectName,
    ),
    sourceFunction: asString(proof.sourceFunction ?? proof.sourceFunctionName),
    resolvedProviderEndpoint,
    routeChain,
    supportingEvidence,
    contradictions,
    steps,
    frontierHistory,
    patchHistory,
  };

  const hasUsefulContent = Boolean(
    parsed.sourceFunction
    || parsed.resolvedProviderEndpoint
    || parsed.routeChain.length > 0
    || parsed.supportingEvidence.length > 0
    || parsed.contradictions.length > 0
    || parsed.steps.length > 0
    || parsed.frontierHistory.length > 0
    || parsed.patchHistory.length > 0,
  );
  return hasUsefulContent ? parsed : null;
}

function formatYesNo(value: boolean | null): string {
  if (value === null) return 'unknown';
  return value ? 'yes' : 'no';
}

interface SmartInferenceSummary {
  engine: 'intent_proof';
  pipeline: 'reinforced' | 'redesign';
  pipelineVersion: string;
  intentCount: number;
  gatewayRouteSeedCount: number;
  derivedEndpointProofCount: number;
  proofClosedAtomicCount: number;
  proofFrontierCount: number;
  routeFamilyFrontierCount: number;
  proofRejectedCount: number;
  projectedCandidateCount: number;
  serviceTargetProjectionCount: number;
  atomicCandidateCount: number;
  agentFrontierCount: number;
  agentPatchedFrontierCount: number;
  frontierBreakdown: Record<string, number>;
  targetBreakdown: Record<string, number>;
  candidatesCreated: number;
}

function getSmartInferenceSummary(payload: unknown): SmartInferenceSummary {
  const record = asRecord(payload);
  const directSummary = asRecord(record?.summary);
  const nestedData = asRecord(record?.data);
  const nestedSummary = asRecord(nestedData?.summary);
  const runRecord = asRecord(record?.run);
  const runStats = asRecord(runRecord?.stats);
  const proofSummary = asRecord(runStats?.proofSummary)
    ?? directSummary
    ?? nestedSummary;
  const pipeline = extractInferencePipelineMeta(record ?? runStats ?? proofSummary);
  const frontierBreakdownRecord = asRecord(proofSummary?.frontierBreakdown);
  const targetBreakdownRecord = asRecord(proofSummary?.targetBreakdown);

  const frontierBreakdown = Object.fromEntries(
    Object.entries(frontierBreakdownRecord ?? {})
      .map(([key, value]) => [key, asFiniteNumber(value) ?? 0] as const)
      .filter(([, value]) => value > 0),
  );
  const targetBreakdown = Object.fromEntries(
    Object.entries(targetBreakdownRecord ?? {})
      .map(([key, value]) => [key, asFiniteNumber(value) ?? 0] as const)
      .filter(([, value]) => value > 0),
  );

  const proofClosedAtomicCount = asFiniteNumber(proofSummary?.proofClosedAtomicCount) ?? 0;
  const proofFrontierCount = asFiniteNumber(proofSummary?.proofFrontierCount) ?? 0;
  const proofRejectedCount = asFiniteNumber(proofSummary?.proofRejectedCount) ?? 0;
  const projectedCandidateCount = asFiniteNumber(proofSummary?.projectedCandidateCount) ?? proofClosedAtomicCount;
  const serviceTargetProjectionCount = asFiniteNumber(proofSummary?.serviceTargetProjectionCount) ?? 0;
  const atomicCandidateCount = Math.max(projectedCandidateCount - serviceTargetProjectionCount, 0);

  return {
    engine: 'intent_proof',
    pipeline: pipeline.name,
    pipelineVersion: pipeline.version,
    intentCount: asFiniteNumber(proofSummary?.intentCount) ?? (proofClosedAtomicCount + proofFrontierCount + proofRejectedCount),
    gatewayRouteSeedCount: asFiniteNumber(proofSummary?.gatewayRouteSeedCount) ?? 0,
    derivedEndpointProofCount: asFiniteNumber(proofSummary?.derivedEndpointProofCount) ?? 0,
    proofClosedAtomicCount,
    proofFrontierCount,
    routeFamilyFrontierCount: asFiniteNumber(proofSummary?.routeFamilyFrontierCount) ?? 0,
    proofRejectedCount,
    projectedCandidateCount,
    serviceTargetProjectionCount,
    atomicCandidateCount,
    agentFrontierCount: asFiniteNumber(proofSummary?.agentFrontierCount) ?? 0,
    agentPatchedFrontierCount: asFiniteNumber(proofSummary?.agentPatchedFrontierCount) ?? 0,
    frontierBreakdown,
    targetBreakdown,
    candidatesCreated: atomicCandidateCount,
  };
}

function formatSmartInferenceSuccessMessage(summary: SmartInferenceSummary): string {
  const parts = [
    `intent ${summary.intentCount}개`,
    ...(summary.gatewayRouteSeedCount > 0 ? [`route-family seed ${summary.gatewayRouteSeedCount}개`] : []),
    ...(summary.derivedEndpointProofCount > 0 ? [`derived endpoint proof ${summary.derivedEndpointProofCount}개`] : []),
    `closed ${summary.proofClosedAtomicCount}개`,
    `frontier ${summary.proofFrontierCount}개`,
    `rejected ${summary.proofRejectedCount}개`,
    `atomic candidate ${summary.atomicCandidateCount}개`,
  ];

  if (summary.routeFamilyFrontierCount > 0) {
    parts.push(`route-family frontier ${summary.routeFamilyFrontierCount}개`);
  }
  if (summary.agentFrontierCount > 0) {
    parts.push(`agent 대상 frontier ${summary.agentFrontierCount}개`);
  }
  if (summary.agentPatchedFrontierCount > 0) {
    parts.push(`agent patch 반영 ${summary.agentPatchedFrontierCount}개`);
  }

  return `Smart 추론 완료 — ${parts.join(', ')}`;
}

function formatSmartInferenceNoCandidateMessage(summary: SmartInferenceSummary): string {
  const parts = [
    `intent ${summary.intentCount}개`,
    ...(summary.gatewayRouteSeedCount > 0 ? [`route-family seed ${summary.gatewayRouteSeedCount}개`] : []),
    `frontier ${summary.proofFrontierCount}개`,
    `rejected ${summary.proofRejectedCount}개`,
  ];
  if (summary.routeFamilyFrontierCount > 0) {
    parts.push(`route-family frontier ${summary.routeFamilyFrontierCount}개`);
  }
  return `Smart 추론 완료 — atomic 후보 0개 (${parts.join(', ')})`;
}

function formatProjectionInvariantMessage(
  summary: Pick<
    SmartInferenceSummary,
    | 'intentCount'
    | 'gatewayRouteSeedCount'
    | 'derivedEndpointProofCount'
    | 'proofClosedAtomicCount'
    | 'proofFrontierCount'
    | 'routeFamilyFrontierCount'
    | 'proofRejectedCount'
    | 'atomicCandidateCount'
    | 'serviceTargetProjectionCount'
  >,
): string {
  const parts = [
    `intent ${summary.intentCount}개`,
    ...(summary.gatewayRouteSeedCount > 0 ? [`route-family seed ${summary.gatewayRouteSeedCount}개`] : []),
    ...(summary.derivedEndpointProofCount > 0 ? [`derived endpoint proof ${summary.derivedEndpointProofCount}개`] : []),
    `closed ${summary.proofClosedAtomicCount}개`,
    `frontier ${summary.proofFrontierCount}개`,
    `rejected ${summary.proofRejectedCount}개`,
    `atomic candidate ${summary.atomicCandidateCount}개`,
    `service target projection ${summary.serviceTargetProjectionCount}개`,
  ];
  if (summary.routeFamilyFrontierCount > 0) {
    parts.push(`route-family frontier ${summary.routeFamilyFrontierCount}개`);
  }
  return `Smart 추론 경고 — service target projection 불변식 위반 (${parts.join(', ')})`;
}


function SmartTraceViewer({ summary }: { summary: SmartInferenceSummary }) {
  const frontierEntries = Object.entries(summary.frontierBreakdown)
    .sort(([, left], [, right]) => right - left)
    .slice(0, 8);
  const targetEntries = Object.entries(summary.targetBreakdown)
    .sort(([, left], [, right]) => right - left)
    .slice(0, 8);

  return (
    <div
      data-testid="smart-trace-viewer"
      className="mb-3 rounded-xl border border-sky-500/30 bg-sky-500/5 p-4"
    >
      <div className="text-sm font-medium text-foreground">Intent Proof Summary</div>
      <div className="mt-1 text-xs text-muted-foreground">
        pipeline {summary.pipeline} · {summary.pipelineVersion}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        intent {summary.intentCount}개 · route-family seed {summary.gatewayRouteSeedCount}개 · derived endpoint proof {summary.derivedEndpointProofCount}개 · closed {summary.proofClosedAtomicCount}개 · frontier {summary.proofFrontierCount}개 · rejected {summary.proofRejectedCount}개 · projected {summary.projectedCandidateCount}개 · atomic {summary.atomicCandidateCount}개
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        route-family frontier {summary.routeFamilyFrontierCount}개
        {summary.serviceTargetProjectionCount > 0
          ? ` · 불변식 위반 service target projection ${summary.serviceTargetProjectionCount}개`
          : ''}
        {' · '}agent 대상 frontier {summary.agentFrontierCount}개 · agent patch 반영 {summary.agentPatchedFrontierCount}개
      </div>
      {frontierEntries.length === 0 && targetEntries.length === 0 ? (
        <div className="mt-3 text-xs text-muted-foreground">이번 실행에서 추가 breakdown 정보가 없습니다.</div>
      ) : (
        <div className="mt-3 space-y-2 text-xs text-muted-foreground">
          {frontierEntries.length > 0 && (
            <div>
              Frontier breakdown: {frontierEntries.map(([reason, count]) => `${reason} ${count}개`).join(', ')}
            </div>
          )}
          {targetEntries.length > 0 && (
            <div>
              Target breakdown: {targetEntries.map(([target, count]) => `${target} ${count}개`).join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function asRelationFeedbackMetadata(value: unknown): RelationFeedbackMetadata | null {
  const record = asRecord(value);
  const key = typeof record?.key === 'string' && record.key.trim().length > 0
    ? record.key.trim()
    : null;
  const baseConfidence = asFiniteNumber(record?.baseConfidence);
  const adjustment = asFiniteNumber(record?.adjustment);
  const adjustedConfidence = asFiniteNumber(record?.adjustedConfidence);
  const sampleCount = asFiniteNumber(record?.sampleCount);

  if (
    !key
    || baseConfidence === null
    || adjustment === null
    || adjustedConfidence === null
    || sampleCount === null
    || typeof record?.applied !== 'boolean'
  ) {
    return null;
  }

  return {
    key,
    baseConfidence,
    adjustment,
    adjustedConfidence,
    applied: record.applied,
    sampleCount: Math.max(0, Math.round(sampleCount)),
  };
}

function getCandidateFeedback(candidate: RelationCandidate): RelationFeedbackMetadata | null {
  return asRelationFeedbackMetadata(candidate.feedback)
    ?? asRelationFeedbackMetadata(candidate.metadata?.feedback);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatSignedPercentPoints(value: number): string {
  const rounded = Math.round(value * 1000) / 10;
  if (Object.is(rounded, -0)) return '0%p';
  return `${rounded > 0 ? '+' : ''}${rounded}%p`;
}

function getFeedbackState(feedback: RelationFeedbackMetadata): 'no-stats' | 'insufficient' | 'applied' {
  if (feedback.sampleCount === 0) return 'no-stats';
  if (!feedback.applied) return 'insufficient';
  return 'applied';
}

function FeedbackHint({
  candidate,
  compoundCandidate,
}: {
  candidate: RelationCandidate;
  compoundCandidate: boolean;
}) {
  const feedback = getCandidateFeedback(candidate);
  if (!feedback) return null;

  const state = getFeedbackState(feedback);
  const statusLabel = state === 'no-stats'
    ? '통계 없음'
    : state === 'insufficient'
      ? '표본 부족'
      : '보정 적용';
  const summary = compoundCandidate
    ? (
      state === 'no-stats'
        ? '세부 매핑 전 단계라 참고용 feedback 통계가 아직 없습니다.'
        : state === 'insufficient'
          ? `표본 ${feedback.sampleCount}건이지만 세부 매핑 후보 단계에서는 아직 보정 전입니다.`
          : `세부 매핑 전 prior에 ${formatSignedPercentPoints(feedback.adjustment)} 보정이 반영되어 있습니다.`
    )
    : (
      state === 'no-stats'
        ? '이 후보 key의 승인/거절 통계가 아직 없습니다.'
        : state === 'insufficient'
          ? `표본 ${feedback.sampleCount}건으로 아직 보정 전입니다.`
          : `표본 ${feedback.sampleCount}건 기준 ${formatSignedPercentPoints(feedback.adjustment)} 보정이 적용되었습니다.`
    );

  return (
    <div
      data-testid="approval-feedback-hint"
      className="mt-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-foreground">Feedback hint</span>
        <span className="rounded-full border border-border/60 px-2 py-0.5">{statusLabel}</span>
        <span>{summary}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono">
        <span>key {feedback.key}</span>
        <span>표본 {feedback.sampleCount}건</span>
        <span>{formatPercent(feedback.baseConfidence)} → {formatPercent(feedback.adjustedConfidence)}</span>
      </div>
      {compoundCandidate && (
        <div className="mt-1">
          실제 승인/거절은 세부 매핑 후 생성되는 atomic 후보에서 진행됩니다.
        </div>
      )}
    </div>
  );
}

function ProofChainPanel({ candidate }: { candidate: RelationCandidate }) {
  const proof = getProofChainMetadata(candidate);
  if (!proof) return null;

  return (
    <details data-testid="approval-proof-chain" className="mt-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-foreground">
        Proof chain drill-down
      </summary>
      <div className="mt-2 space-y-2 text-xs text-muted-foreground">
        {proof.sourceService && <div>source service: {proof.sourceService}</div>}
        {proof.sourceFunction && <div>source function: {proof.sourceFunction}</div>}
        {proof.resolvedProviderEndpoint && <div>resolved provider endpoint: {proof.resolvedProviderEndpoint}</div>}
        {proof.routeChain.length > 0 && <div>route chain: {proof.routeChain.join(' -> ')}</div>}
        {proof.supportingEvidence.length > 0 && (
          <div>supporting evidence: {proof.supportingEvidence.join(' | ')}</div>
        )}
        {proof.contradictions.length > 0 && <div>contradiction: {proof.contradictions.join(', ')}</div>}
        {proof.steps.length > 0 && (
          <div data-testid="approval-proof-steps">
            proof steps: {proof.steps.map((step) => `${step.type}(${step.status})`).join(' -> ')}
          </div>
        )}
        {proof.frontierHistory.length > 0 && (
          <div>
            frontier history: {proof.frontierHistory.map((item) => item.reason).join(', ')}
          </div>
        )}
        {proof.patchHistory.length > 0 && (
          <div>
            patch history: {proof.patchHistory.map((item) => `${item.type}(${item.status})`).join(', ')}
          </div>
        )}
      </div>
    </details>
  );
}

function FrontierQueuePanel({ candidates }: { candidates: RelationCandidate[] }) {
  const entries = candidates.flatMap((candidate) => {
    const proof = getProofChainMetadata(candidate);
    if (!proof || proof.frontierHistory.length === 0) return [];
    return proof.frontierHistory.map((frontier) => ({
      candidate,
      frontier,
    }));
  });

  if (entries.length === 0) return null;

  return (
    <section
      data-testid="frontier-queue"
      className="mb-4 rounded-xl border border-border/70 bg-muted/10 p-3"
      aria-label="Frontier queue"
    >
      <h3 className="text-sm font-medium text-foreground">Frontier Queue ({entries.length})</h3>
      <div className="mt-2 space-y-2">
        {entries.map(({ candidate, frontier }) => (
          <details key={`${candidate.id}-${frontier.id}`} data-testid="frontier-item" className="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
            <summary className="cursor-pointer text-xs text-foreground">
              {candidate.subjectName}
              {' -> '}
              {candidate.objectName}
              {' · reason '}
              {frontier.reason}
            </summary>
            <div className="mt-2 space-y-1 text-xs text-muted-foreground">
              <div>missing slots: {frontier.missingSlots.length > 0 ? frontier.missingSlots.join(', ') : 'none'}</div>
              <div>last attempted step: {frontier.lastResolutionStep ?? 'unknown'}</div>
              <div>agent patch: {formatYesNo(frontier.agentPatched)}</div>
              <div>retryable: {formatYesNo(frontier.retryable)}</div>
              {frontier.snippets.length > 0 && <div>snippets: {frontier.snippets.join(' | ')}</div>}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

/** 엔드포인트 (세부 매핑용) */
interface EndpointInfo {
  id: string;
  name: string;
  method: string;
  path: string;
}

interface ScanPathsResponse {
  paths?: string[];
  parentDirs?: string[];
}

type CrossValidationFilter = 'all' | 'warnings' | 'supported' | 'single';
type CrossValidationSort = 'cross-validation-priority' | 'confidence-desc' | 'confidence-asc';

const CODE_ENGINE_LS_KEY = 'archi-navi:inference:code-engine';
const CANDIDATE_PAGE_SIZE = 200;

function resolveCodeEngine(): 'hybrid' | 'ast' | 'regex' {
  if (typeof window === 'undefined') return 'hybrid';
  const saved = localStorage.getItem(CODE_ENGINE_LS_KEY);
  if (saved === 'regex') return 'regex';
  if (saved === 'ast' || saved === 'auto') return 'ast';
  return 'hybrid';
}

async function resolveInferenceRepoRoots(workspaceId: string): Promise<string[]> {
  if (!workspaceId) return [];

  try {
    const res = await fetch(`/api/scan/paths?workspaceId=${encodeURIComponent(workspaceId)}`);
    if (!res.ok) return [];

    const payload = (await res.json()) as ScanPathsResponse;
    // 추론 실행 source는 서비스별 scanPath만 사용한다.
    const paths = (payload.paths ?? []).map((path) => path.trim()).filter((path) => path.length > 0);
    return [...new Set(paths)];
  } catch {
    return [];
  }
}

/** 서비스 레벨 후보 여부 */
function isCompoundToCompound(c: RelationCandidate): boolean {
  return c.subjectGranularity === 'COMPOUND' && c.objectGranularity === 'COMPOUND';
}

function getContradictionBadge(candidate: RelationCandidate) {
  const contradictions = Array.isArray(candidate.crossValidation?.contradictions)
    ? candidate.crossValidation.contradictions
    : [];
  const primaryContradiction = contradictions[0];
  if (primaryContradiction) {
    return {
      label: getCrossValidationContradictionLabel(primaryContradiction.type),
      variant: 'warning' as const,
    };
  }
  return null;
}

function getCrossValidationBadge(candidate: RelationCandidate) {
  if (getContradictionBadge(candidate)) {
    return null;
  }

  const supportingSources = Array.isArray(candidate.crossValidation?.supportingSources)
    ? candidate.crossValidation.supportingSources
    : [];
  const supportCount = candidate.crossValidation?.supportCount ?? supportingSources.length;
  if (supportCount >= 2) {
    return { label: '2+ 소스 지지', variant: 'secondary' as const };
  }
  return { label: '단일 소스', variant: 'outline' as const };
}

function getCandidateCrossValidationState(candidate: RelationCandidate): CrossValidationFilter {
  const contradictions = Array.isArray(candidate.crossValidation?.contradictions)
    ? candidate.crossValidation.contradictions
    : [];
  if (contradictions.length > 0) return 'warnings';

  const supportCount = candidate.crossValidation?.supportCount
    ?? candidate.crossValidation?.supportingSources.length
    ?? 0;
  if (supportCount >= 2 && candidate.crossValidation?.validated) return 'supported';
  return 'single';
}

function compareCandidates(a: RelationCandidate, b: RelationCandidate, sort: CrossValidationSort): number {
  if (sort === 'confidence-desc') {
    return b.confidence - a.confidence;
  }
  if (sort === 'confidence-asc') {
    return a.confidence - b.confidence;
  }

  const priority = (candidate: RelationCandidate) => {
    const state = getCandidateCrossValidationState(candidate);
    if (state === 'warnings') return 0;
    if (state === 'supported') return 1;
    return 2;
  };

  const priorityGap = priority(a) - priority(b);
  if (priorityGap !== 0) return priorityGap;
  return b.confidence - a.confidence;
}

/** 오브젝트명 렌더링 (ATOMIC이면 parent 서비스명 포함) */
function ObjectLabel({ name, granularity, parentName, objectType }: {
  name: string;
  granularity: string;
  parentName: string | null;
  objectType: string | null;
}) {
  if (granularity === 'ATOMIC' && parentName) {
    return (
      <span className="flex items-center gap-1">
        <span className="text-muted-foreground text-xs">{parentName}</span>
        <ChevronRight className="h-3 w-3 text-muted-foreground" />
        <span className="font-medium text-foreground">{name}</span>
      </span>
    );
  }
  return <span className="font-medium text-foreground">{name}</span>;
}

export function ApprovalList() {
  const { workspaceId } = useWorkspace();
  const [candidates, setCandidates] = useState<RelationCandidate[]>([]);
  const [lastSmartInferenceSummary, setLastSmartInferenceSummary] = useState<SmartInferenceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningInference, setRunningInference] = useState(false);
  const [activeSmartRunId, setActiveSmartRunId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [rejectTarget, setRejectTarget] = useState<RelationCandidate | null>(null);

  // 세부 매핑 Sheet 상태
  const [mappingTarget, setMappingTarget] = useState<RelationCandidate | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointInfo[]>([]);
  const [selectedEndpoints, setSelectedEndpoints] = useState<Set<string>>(new Set());
  const [loadingEndpoints, setLoadingEndpoints] = useState(false);
  const [submittingMapping, setSubmittingMapping] = useState(false);
  const endpointRequestSeqRef = useRef(0);
  const [crossValidationFilter, setCrossValidationFilter] = useState<CrossValidationFilter>('all');
  const [crossValidationSort, setCrossValidationSort] = useState<CrossValidationSort>(
    'cross-validation-priority',
  );

  // S1-1: 추론 실행 관련 상태
  const [inferenceMode, setInferenceMode] = useState<'standard' | 'smart'>('standard');
  const [pipeline, setPipeline] = useState<'reinforced' | 'redesign'>('reinforced');
  const [includeDbInference, setIncludeDbInference] = useState(true);
  const [runningLlmFilter, setRunningLlmFilter] = useState(false);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(new Set());

  // S1-6: 페이지 단위 로딩 상태
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadCandidates = useCallback(async (append = false) => {
    if (!append) setLoading(true);
    else setLoadingMore(true);
    try {
      const offset = append ? candidates.length : 0;
      const res = await fetch(
        `/api/inference/candidates?workspaceId=${workspaceId}&status=PENDING&limit=${CANDIDATE_PAGE_SIZE}&offset=${offset}`,
      );
      if (!res.ok) throw new Error();

      const page = (await res.json()) as RelationCandidate[];
      if (append) {
        setCandidates((prev) => [...prev, ...page]);
      } else {
        setCandidates(page);
        setSelectedCandidateIds(new Set());
      }
      setHasMore(page.length >= CANDIDATE_PAGE_SIZE);
    } catch {
      if (!append) setCandidates([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [workspaceId, candidates.length]);

  useEffect(() => {
    void loadCandidates(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    const handleRefresh = () => {
      void loadCandidates(false);
    };
    window.addEventListener('archi-navi:refresh-approval-candidates', handleRefresh);
    return () => {
      window.removeEventListener('archi-navi:refresh-approval-candidates', handleRefresh);
    };
  }, [loadCandidates]);

  const fetchSmartRunStatus = useCallback(async (runId: string) => {
    if (!workspaceId) throw new Error('workspaceId is required');

    const res = await fetch(
      `/api/inference/smart?workspaceId=${encodeURIComponent(workspaceId)}&runId=${encodeURIComponent(runId)}`,
    );
    const payload = (await res.json()) as unknown;
    if (!res.ok) {
      throw new Error(getApiErrorMessage(payload, 'Smart 추론 상태 조회 실패'));
    }
    return payload;
  }, [workspaceId]);

  const handleSmartRunTerminalState = useCallback(async (payload: unknown): Promise<boolean> => {
    const record = asRecord(payload);
    const runRecord = asRecord(record?.run);
    const status = typeof runRecord?.status === 'string' ? runRecord.status : '';

    if (status === 'SUCCEEDED') {
      const summary = getSmartInferenceSummary(payload);
      setLastSmartInferenceSummary(summary);
      if (summary.serviceTargetProjectionCount > 0) {
        toast.warning(formatProjectionInvariantMessage(summary));
      } else if (summary.candidatesCreated > 0) {
        toast.success(formatSmartInferenceSuccessMessage(summary));
      } else {
        toast.warning(formatSmartInferenceNoCandidateMessage(summary));
      }
      setActiveSmartRunId(null);
      await loadCandidates();
      return true;
    }

    if (status === 'FAILED' || status === 'CANCELED') {
      const message =
        (typeof runRecord?.errorMessage === 'string' && runRecord.errorMessage.trim().length > 0)
          ? runRecord.errorMessage.trim()
          : status === 'CANCELED'
            ? 'Smart 추론이 취소되었습니다.'
            : 'Smart 추론 실행 실패';
      toast.error(message);
      setActiveSmartRunId(null);
      return true;
    }

    return false;
  }, [loadCandidates]);

  useEffect(() => {
    if (!activeSmartRunId) return;

    const intervalId = window.setInterval(() => {
      void fetchSmartRunStatus(activeSmartRunId)
        .then((payload) => handleSmartRunTerminalState(payload))
        .catch(() => {
          // 일시적인 조회 실패는 polling이 다음 주기에 복구한다.
        });
    }, 2000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeSmartRunId, fetchSmartRunStatus, handleSmartRunTerminalState]);

  const runInference = async () => {
    setRunningInference(true);
    try {
      if (!workspaceId) throw new Error('workspaceId is required');
      const aiHeaders = getClientAiRequestHeaders();
      const repoRoots = await resolveInferenceRepoRoots(workspaceId);
      const pipelineMeta = buildInferencePipelineMeta(pipeline);

      // S1-1a: Smart Pipeline 모드
      if (inferenceMode === 'smart') {
        const res = await fetch('/api/inference/smart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...aiHeaders },
          body: JSON.stringify({
            workspaceId,
            repoRoots,
            useServiceMetadataPaths: true,
            async: true,
            pipeline: pipelineMeta.name,
            pipelineVersion: pipelineMeta.version,
            smartProof: {
              categories: {
                ambiguityResolution: true,
              },
            },
          }),
        });
        const payload = (await res.json()) as unknown;
        if (!res.ok) throw new Error(getApiErrorMessage(payload, 'Smart 추론 실행 실패'));

        const runRecord = asRecord(asRecord(payload)?.run);
        const runId = typeof runRecord?.id === 'string'
          ? runRecord.id
          : typeof asRecord(payload)?.runId === 'string'
            ? String(asRecord(payload)?.runId)
            : '';
        if (!runId) {
          throw new Error('Smart 추론 실행 ID를 받지 못했습니다.');
        }

        toast.success('Smart 추론을 백그라운드로 시작했습니다. 완료되면 알림을 표시합니다.');

        const statusPayload = await fetchSmartRunStatus(runId);
        const handled = await handleSmartRunTerminalState(statusPayload);
        if (!handled) {
          setActiveSmartRunId(runId);
        }
        return;
      }

      // S1-1b: Standard 모드
      const body: Record<string, unknown> = {
        workspaceId,
        modes: includeDbInference ? ['config', 'code', 'db'] : ['config', 'code'],
        useServiceMetadataPaths: true,
        repoRoots,
        codeEngine: resolveCodeEngine(),
        pipeline: pipelineMeta.name,
        pipelineVersion: pipelineMeta.version,
      };

      const res = await fetch('/api/inference/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...aiHeaders },
        body: JSON.stringify(body),
      });
      const payload = (await res.json()) as {
        error?: string;
        summary?: {
          relationCandidatesCreated?: number;
          projectedCandidateCount?: number;
          gatewayRouteSeedCount?: number;
          routeFamilyFrontierCount?: number;
          serviceTargetProjectionCount?: number;
        };
        results?: {
          config?: {
            fileCount?: number;
            processedFileCount?: number;
            skippedFileCount?: number;
            aliasBindingCount?: number;
            routeTransformCount?: number;
            interactionIntentCount?: number;
            gatewayRouteSeedCount?: number;
          };
          code?: {
            signalCount?: number;
            enginesUsed?: string[];
            fallbackCount?: number;
            scanFailures?: Array<{ filePath: string; reason: string; language: string }>;
          };
        };
        llmBoost?: {
          skippedReason?: string;
          codeIntentAnalysis?: { generatedCount?: number };
        };
        warnings?: string[];
      };
      if (!res.ok) throw new Error(payload.error ?? '추론 실행 실패');

      const serviceTargetProjectionCount = payload.summary?.serviceTargetProjectionCount ?? 0;
      const created = Math.max(
        (payload.summary?.projectedCandidateCount ?? payload.summary?.relationCandidatesCreated ?? 0)
          - serviceTargetProjectionCount,
        0,
      );
      const enginesUsed = payload.results?.code?.enginesUsed ?? [];
      const fallbackCount = payload.results?.code?.fallbackCount ?? 0;
      const scanFailureCount = payload.results?.code?.scanFailures?.length ?? 0;
      const configStats = payload.results?.config;
      const gatewayRouteSeedCount =
        configStats?.gatewayRouteSeedCount
        ?? payload.summary?.gatewayRouteSeedCount
        ?? 0;
      const routeFamilyFrontierCount = payload.summary?.routeFamilyFrontierCount ?? 0;
      const processedConfigFiles = configStats?.processedFileCount ?? 0;
      const configArtifactsFound =
        (configStats?.fileCount ?? 0) > 0
        || (configStats?.aliasBindingCount ?? 0) > 0
        || (configStats?.routeTransformCount ?? 0) > 0
        || (configStats?.interactionIntentCount ?? 0) > 0;

      // 엔진 메타 정보 문자열 조립
      const engineParts: string[] = [];
      if (enginesUsed.length > 0) {
        engineParts.push(`엔진: ${enginesUsed.join('+')}`);
      }
      if (fallbackCount > 0) {
        engineParts.push(`fallback ${fallbackCount}건`);
      }
      if (scanFailureCount > 0) {
        engineParts.push(`파싱 실패 ${scanFailureCount}건`);
      }
      if (gatewayRouteSeedCount > 0) {
        engineParts.push(`route-family seed ${gatewayRouteSeedCount}개`);
      }
      if (routeFamilyFrontierCount > 0) {
        engineParts.push(`route-family frontier ${routeFamilyFrontierCount}개`);
      }
      const engineSuffix = engineParts.length > 0 ? ` (${engineParts.join(', ')})` : '';

      if (serviceTargetProjectionCount > 0) {
        const baseMessage = created > 0
          ? `추론 실행 완료 — atomic 후보 ${created}개 생성`
          : '추론 실행 완료 — atomic 후보 0개';
        toast.warning(
          `${baseMessage} (service target projection ${serviceTargetProjectionCount}개 감지, 문서 불변식 위반${engineSuffix})`,
        );
      } else if (created > 0) {
        toast.success(`추론 실행 완료 — atomic 후보 ${created}개 생성${engineSuffix}`);
      } else {
        const codeSignals = payload.results?.code?.signalCount ?? 0;
        const primaryWarning = payload.warnings?.[0];

        if (primaryWarning) {
          toast.warning(`후보 0개 — ${primaryWarning}`);
        } else if (codeSignals > 0) {
          toast.warning(
            `후보 0개 — 코드 시그널 ${codeSignals}개 추출됨 (관계 후보 생성은 config/db 결과 기준)`,
          );
        } else if (!configArtifactsFound && processedConfigFiles === 0) {
          toast.warning('후보 0개 — 처리된 설정 파일이 없습니다. repoRoot/scanPath를 확인하세요.');
        } else {
          toast.warning('추론 실행 완료 — 신규 관계 후보가 생성되지 않았습니다.');
        }
      }
      await loadCandidates();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '추론 실행 실패');
    } finally {
      setRunningInference(false);
    }
  };

  // S1-1c: LLM Filter — 후보를 LLM으로 평가
  const runLlmFilter = async () => {
    setRunningLlmFilter(true);
    try {
      const res = await fetch('/api/inference/llm-filter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getClientAiRequestHeaders() },
        body: JSON.stringify({
          workspaceId,
          generateExplanations: true,
        }),
      });
      const payload = (await res.json()) as {
        error?: string;
        filtered?: number;
        explained?: number;
      };
      if (!res.ok) throw new Error(payload.error ?? 'LLM 필터 실행 실패');

      const filtered = payload.filtered ?? 0;
      const explained = payload.explained ?? 0;
      if (filtered > 0 || explained > 0) {
        toast.success(`LLM 평가 완료 — ${filtered}개 평가, ${explained}개 설명 생성`);
      } else {
        toast.warning('LLM 평가 완료 — 처리된 후보가 없습니다.');
      }
      await loadCandidates();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'LLM 필터 실행 실패');
    } finally {
      setRunningLlmFilter(false);
    }
  };

  function handleAction(id: string, action: 'APPROVED' | 'REJECTED') {
    startTransition(async () => {
      try {
        await fetch(`/api/inference/candidates/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: action }),
        });
        setCandidates((prev) => prev.filter((c) => c.id !== id));
        setSelectedCandidateIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        toast.success(action === 'APPROVED' ? '관계 승인됨' : '관계 거부됨');
        setRejectTarget(null);
      } catch {
        toast.error('처리 실패');
      }
    });
  }

  const handleBulkAction = useCallback(async (action: 'APPROVED' | 'REJECTED') => {
    if (!workspaceId) return;
    const ids = [...selectedCandidateIds];
    if (ids.length === 0) {
      toast.warning('먼저 후보를 선택하세요.');
      return;
    }

    startTransition(async () => {
      try {
        const res = await fetch('/api/inference/candidates/bulk', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId, ids, status: action }),
        });
        const payload = await res.json() as {
          error?: string;
          updatedCount?: number;
          errors?: Array<{ id: string; message: string }>;
        };
        if (!res.ok) throw new Error(payload.error ?? '일괄 처리 실패');

        const failedIds = new Set((payload.errors ?? []).map((error) => error.id));
        const succeededIds = ids.filter((id) => !failedIds.has(id));
        const succeeded = payload.updatedCount ?? succeededIds.length;
        const failed = failedIds.size;
        setCandidates((prev) => prev.filter((candidate) => !succeededIds.includes(candidate.id)));
        setSelectedCandidateIds((prev) => {
          const next = new Set(prev);
          for (const id of succeededIds) {
            next.delete(id);
          }
          return next;
        });

        if (failed > 0) {
          toast.warning(`${succeeded}건 처리, ${failed}건 실패`);
        } else {
          toast.success(action === 'APPROVED' ? `${succeeded}건 일괄 승인됨` : `${succeeded}건 일괄 거부됨`);
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '일괄 처리 실패');
      }
    });
  }, [selectedCandidateIds, startTransition, workspaceId]);

  const closeMappingSheet = useCallback(() => {
    endpointRequestSeqRef.current += 1;
    setMappingTarget(null);
    setEndpoints([]);
    setSelectedEndpoints(new Set());
    setLoadingEndpoints(false);
  }, []);

  // 세부 매핑: 엔드포인트 목록 로드
  const openMappingSheet = async (cand: RelationCandidate) => {
    const requestSeq = endpointRequestSeqRef.current + 1;
    endpointRequestSeqRef.current = requestSeq;
    setMappingTarget(cand);
    setEndpoints([]);
    setSelectedEndpoints(new Set());
    setLoadingEndpoints(true);
    try {
      const res = await fetch(`/api/inference/candidates/${cand.id}/endpoints`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { endpoints: EndpointInfo[] };
      if (requestSeq !== endpointRequestSeqRef.current) return;
      setEndpoints(data.endpoints);
    } catch {
      if (requestSeq !== endpointRequestSeqRef.current) return;
      setEndpoints([]);
      toast.error('엔드포인트 목록 로드 실패');
    } finally {
      if (requestSeq !== endpointRequestSeqRef.current) return;
      setLoadingEndpoints(false);
    }
  };

  // 세부 매핑: 선택한 엔드포인트로 매핑 실행
  const submitMapping = async () => {
    if (!mappingTarget || selectedEndpoints.size === 0) return;
    setSubmittingMapping(true);
    try {
      const res = await fetch(`/api/inference/candidates/${mappingTarget.id}/map-endpoints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpointIds: [...selectedEndpoints] }),
      });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as {
        createdRelationCount: number;
        resolvedRelationCount?: number;
        reusedRelationCount?: number;
      };
      const resolvedRelationCount = data.resolvedRelationCount ?? data.createdRelationCount;
      const reusedRelationCount = data.reusedRelationCount ?? 0;

      if (resolvedRelationCount > 0) {
        if (data.createdRelationCount > 0 && reusedRelationCount > 0) {
          toast.success(
            `${data.createdRelationCount}개 엔드포인트 관계 생성, ${reusedRelationCount}개 기존 관계 재사용`,
          );
        } else if (data.createdRelationCount > 0) {
          toast.success(`${data.createdRelationCount}개 엔드포인트 관계 생성됨`);
        } else {
          toast.success(`${resolvedRelationCount}개 기존 엔드포인트 관계를 재사용해 원본 후보를 정리했습니다.`);
        }
        setCandidates((prev) => prev.filter((c) => c.id !== mappingTarget.id));
        closeMappingSheet();
      } else {
        toast.warning('생성된 엔드포인트 관계가 없어 원본 후보를 유지했습니다.');
      }
    } catch {
      toast.error('매핑 처리 실패');
    } finally {
      setSubmittingMapping(false);
    }
  };

  // 엔드포인트 체크 토글
  const toggleEndpoint = (epId: string) => {
    setSelectedEndpoints((prev) => {
      const next = new Set(prev);
      if (next.has(epId)) next.delete(epId);
      else next.add(epId);
      return next;
    });
  };

  // 전체 선택/해제
  const toggleAll = () => {
    if (selectedEndpoints.size === endpoints.length) {
      setSelectedEndpoints(new Set());
    } else {
      setSelectedEndpoints(new Set(endpoints.map((ep) => ep.id)));
    }
  };

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (candidates.length === 0) {
    return (
      <div className="space-y-4 py-10">
        <EmptyStateGuide
          eyebrow="Approval"
          title="승인 대기 중인 관계 후보가 없습니다"
          description="먼저 코드 스캔으로 서비스 경로를 등록한 뒤 추론을 실행하면 후보가 생성됩니다. 필요하면 Object 목록과 추론 이력에서 현재 상태를 먼저 확인하세요."
          actions={[
            { href: '/services', label: 'Object 목록 열기' },
            { href: '/inference-runs', label: '추론 이력 보기', variant: 'outline' },
          ]}
        />
        <div className="flex items-center justify-center gap-2">
          <select
            aria-label="추론 모드"
            value={inferenceMode}
            onChange={(e) => setInferenceMode(e.target.value as typeof inferenceMode)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
          >
            <option value="standard">정적 분석</option>
            <option value="smart">Smart Proof Engine</option>
          </select>
          <select
            aria-label="파이프라인"
            value={pipeline}
            onChange={(e) => setPipeline(e.target.value as typeof pipeline)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
          >
            <option value="reinforced">보강형</option>
            <option value="redesign">재설계</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeDbInference}
              onChange={(event) => setIncludeDbInference(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-input"
            />
            DB inference 포함
          </label>
          <Button
            onClick={() => void runInference()}
            disabled={runningInference || activeSmartRunId !== null}
          >
            {inferenceMode === 'smart'
              ? <Bot className="h-3.5 w-3.5 mr-1.5" />
              : <Sparkles className="h-3.5 w-3.5 mr-1.5" />}
            {runningInference || activeSmartRunId !== null ? '추론 실행 중...' : '추론 실행'}
          </Button>
        </div>
        {lastSmartInferenceSummary && (
          <div className="mt-4 w-full max-w-4xl px-4">
            <SmartTraceViewer summary={lastSmartInferenceSummary} />
          </div>
        )}
      </div>
    );
  }

  const visibleCandidates = [...candidates]
    .filter((candidate) => {
      if (crossValidationFilter === 'all') return true;
      return getCandidateCrossValidationState(candidate) === crossValidationFilter;
    })
    .sort((a, b) => compareCandidates(a, b, crossValidationSort));
  const compoundCandidateCount = visibleCandidates.filter(isCompoundToCompound).length;
  const firstCompoundIndex = visibleCandidates.findIndex(isCompoundToCompound);
  const selectableVisibleCandidates = visibleCandidates.filter((candidate) => !isCompoundToCompound(candidate));
  const allSelectableVisibleSelected = selectableVisibleCandidates.length > 0
    && selectableVisibleCandidates.every((candidate) => selectedCandidateIds.has(candidate.id));

  return (
    <>
      {lastSmartInferenceSummary && <SmartTraceViewer summary={lastSmartInferenceSummary} />}
      <FrontierQueuePanel candidates={candidates} />
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>표시</span>
            <select
              aria-label="교차 검증 필터"
              value={crossValidationFilter}
              onChange={(event) => setCrossValidationFilter(event.target.value as CrossValidationFilter)}
              className="min-w-40 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="all">전체</option>
              <option value="warnings">경고 있음</option>
              <option value="supported">다중 소스 지지</option>
              <option value="single">단일 소스</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>정렬</span>
            <select
              aria-label="교차 검증 정렬"
              value={crossValidationSort}
              onChange={(event) => setCrossValidationSort(event.target.value as CrossValidationSort)}
              className="min-w-48 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="cross-validation-priority">교차 검증 우선</option>
              <option value="confidence-desc">신뢰도 높은 순</option>
              <option value="confidence-asc">신뢰도 낮은 순</option>
            </select>
          </label>
        </div>
        <div className="flex items-center gap-2">
          {/* S1-1c: LLM Filter 버튼 */}
          <Button
            variant="outline"
            onClick={() => void runLlmFilter()}
            disabled={runningLlmFilter || candidates.length === 0}
            title="LLM으로 후보를 평가하고 설명을 생성합니다"
          >
            <FlaskConical className="h-3.5 w-3.5 mr-1.5" />
            {runningLlmFilter ? 'LLM 평가 중...' : 'LLM 평가'}
          </Button>

          {/* S1-1a/b: 추론 모드 선택 + 실행 */}
          <select
            aria-label="추론 모드"
            value={inferenceMode}
            onChange={(e) => setInferenceMode(e.target.value as typeof inferenceMode)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
          >
            <option value="standard">정적 분석</option>
            <option value="smart">Smart Proof Engine</option>
          </select>
          <select
            aria-label="파이프라인"
            value={pipeline}
            onChange={(e) => setPipeline(e.target.value as typeof pipeline)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
          >
            <option value="reinforced">보강형</option>
            <option value="redesign">재설계</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeDbInference}
              onChange={(event) => setIncludeDbInference(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-input"
            />
            DB inference 포함
          </label>
          <Button
            variant="outline"
            onClick={() => void runInference()}
            disabled={runningInference || activeSmartRunId !== null}
          >
            {inferenceMode === 'smart'
              ? <Bot className="h-3.5 w-3.5 mr-1.5" />
              : <Sparkles className="h-3.5 w-3.5 mr-1.5" />}
            {runningInference || activeSmartRunId !== null ? '추론 실행 중...' : '추론 실행'}
          </Button>
        </div>
      </div>

      {visibleCandidates.length === 0 && (
        <div className="rounded-xl border border-dashed border-border/60 px-4 py-10 text-center text-sm text-muted-foreground">
          현재 필터 조건에 맞는 승인 후보가 없습니다.
        </div>
      )}

      {visibleCandidates.length > 0 && (
        <div className="space-y-2">
          {selectableVisibleCandidates.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={allSelectableVisibleSelected}
                  onChange={(event) => {
                    if (event.target.checked) {
                      setSelectedCandidateIds(
                        new Set(selectableVisibleCandidates.map((candidate) => candidate.id)),
                      );
                    } else {
                      setSelectedCandidateIds(new Set());
                    }
                  }}
                  className="h-3.5 w-3.5 rounded border-input"
                />
                표시 후보 전체 선택
              </label>
              <span className="text-xs text-muted-foreground">선택 {selectedCandidateIds.size}건</span>
              <Button
                size="sm"
                variant="outline"
                disabled={isPending || selectedCandidateIds.size === 0}
                onClick={() => void handleBulkAction('APPROVED')}
              >
                선택 일괄 승인
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:bg-destructive/10"
                disabled={isPending || selectedCandidateIds.size === 0}
                onClick={() => void handleBulkAction('REJECTED')}
              >
                선택 일괄 거부
              </Button>
            </div>
          )}
          {visibleCandidates.map((cand, index) => {
            const contradictionBadge = getContradictionBadge(cand);
            const badge = getCrossValidationBadge(cand);
            const compoundCandidate = isCompoundToCompound(cand);
            const showCompoundHeader = compoundCandidate && index === firstCompoundIndex;
            const llmExplanation = getLlmExplanationSummary(cand);

            return (
              <div key={cand.id}>
                {showCompoundHeader && (
                  <div className={index > 0 ? 'mt-6 mb-2' : 'mb-2'}>
                    <h3 className="text-sm font-medium text-muted-foreground">
                      서비스 간 관계 — 세부 매핑 필요 ({compoundCandidateCount}건)
                    </h3>
                  </div>
                )}

                {compoundCandidate ? (
                  <div
                    data-testid="approval-candidate-card"
                    data-candidate-id={cand.id}
                    className="flex items-start justify-between rounded-xl p-4 transition-all glass-card border border-dashed border-muted-foreground/30"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className="font-medium text-foreground">{cand.subjectName}</span>
                        <Badge variant="outline">{cand.relationType}</Badge>
                        {contradictionBadge && <Badge variant={contradictionBadge.variant}>{contradictionBadge.label}</Badge>}
                        {badge && <Badge variant={badge.variant}>{badge.label}</Badge>}
                        <span className="font-medium text-foreground">{cand.objectName}</span>
                        <Badge variant="secondary" className="text-xs">서비스 레벨</Badge>
                      </div>
                      {llmExplanation && (
                        <p className="mt-2 text-sm text-muted-foreground">
                          {llmExplanation}
                        </p>
                      )}
                      <ProofChainPanel candidate={cand} />
                      <FeedbackHint candidate={cand} compoundCandidate />
                    </div>

                    <div className="ml-4 flex items-center gap-4">
                      <div className="text-right">
                        <div className="text-xs text-muted-foreground">신뢰도</div>
                        <div className="text-sm font-medium text-foreground">
                          {Math.round(cand.confidence * 100)}%
                        </div>
                      </div>

                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void openMappingSheet(cand)}
                        >
                          <Link2 className="h-3.5 w-3.5 mr-1" />
                          세부 매핑
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setRejectTarget(cand)}
                          disabled={isPending}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div
                    data-testid="approval-candidate-card"
                    data-candidate-id={cand.id}
                    className="flex items-start justify-between rounded-xl p-4 transition-all glass-card"
                  >
                    <div className="min-w-0 flex-1">
                      <label className="mb-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={selectedCandidateIds.has(cand.id)}
                          onChange={(event) => {
                            setSelectedCandidateIds((prev) => {
                              const next = new Set(prev);
                              if (event.target.checked) next.add(cand.id);
                              else next.delete(cand.id);
                              return next;
                            });
                          }}
                          className="h-3.5 w-3.5 rounded border-input"
                        />
                        선택
                      </label>
                      <div className="flex items-center gap-3 flex-wrap">
                        <ObjectLabel
                          name={cand.subjectName}
                          granularity={cand.subjectGranularity}
                          parentName={cand.subjectParentName}
                          objectType={cand.subjectObjectType}
                        />
                        <Badge variant="outline">{cand.relationType}</Badge>
                        {contradictionBadge && <Badge variant={contradictionBadge.variant}>{contradictionBadge.label}</Badge>}
                        {badge && <Badge variant={badge.variant}>{badge.label}</Badge>}
                        <ObjectLabel
                          name={cand.objectName}
                          granularity={cand.objectGranularity}
                          parentName={cand.objectParentName}
                          objectType={cand.objectObjectType}
                        />
                      </div>
                      {llmExplanation && (
                        <p className="mt-2 text-sm text-muted-foreground">
                          {llmExplanation}
                        </p>
                      )}
                      <ProofChainPanel candidate={cand} />
                      <FeedbackHint candidate={cand} compoundCandidate={false} />
                    </div>

                    <div className="ml-4 flex items-center gap-4">
                      <div className="text-right">
                        <div className="text-xs text-muted-foreground">신뢰도</div>
                        <div className="text-sm font-medium text-foreground">
                          {Math.round(cand.confidence * 100)}%
                        </div>
                      </div>

                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          onClick={() => handleAction(cand.id, 'APPROVED')}
                          disabled={isPending}
                          className="bg-green-600 hover:bg-green-700 text-white"
                        >
                          <Check className="h-3.5 w-3.5 mr-1" />
                          승인
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setRejectTarget(cand)}
                          disabled={isPending}
                          className="text-destructive hover:bg-destructive/10"
                        >
                          <X className="h-3.5 w-3.5 mr-1" />
                          거부
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* S1-6: 더 보기 버튼 */}
      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadCandidates(true)}
            disabled={loadingMore}
          >
            {loadingMore ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
            ) : null}
            더 보기 ({candidates.length}건 로드됨)
          </Button>
        </div>
      )}

      {/* 거부 확인 다이얼로그 */}
      <ConfirmDialog
        open={!!rejectTarget}
        onOpenChange={(open) => { if (!open) setRejectTarget(null); }}
        title="관계 거부"
        description={`"${rejectTarget?.subjectName} → ${rejectTarget?.objectName}" 관계를 거부하시겠습니까?`}
        confirmLabel="거부"
        destructive
        onConfirm={() => {
          if (rejectTarget) handleAction(rejectTarget.id, 'REJECTED');
        }}
      />

      {/* 세부 매핑 Sheet */}
      <Sheet
        open={!!mappingTarget}
        onOpenChange={(open) => { if (!open) closeMappingSheet(); }}
      >
        <SheetContent className="sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>엔드포인트 세부 매핑</SheetTitle>
            <SheetDescription>
              <span className="font-medium">{mappingTarget?.subjectName}</span>
              {' → '}
              <span className="font-medium">{mappingTarget?.objectName}</span>
              {' 서비스에서 실제로 호출하는 엔드포인트를 선택하세요.'}
            </SheetDescription>
          </SheetHeader>

          <div className="mt-4 space-y-2 max-h-[60vh] overflow-y-auto">
            {loadingEndpoints ? (
              <div className="flex h-20 items-center justify-center">
                <Spinner />
              </div>
            ) : endpoints.length === 0 ? (
              <div className="text-sm text-muted-foreground text-center py-8">
                등록된 엔드포인트가 없습니다.
                <br />
                코드 스캔 또는 OpenAPI 임포트를 먼저 실행하세요.
              </div>
            ) : (
              <>
                {/* 전체 선택/해제 */}
                <div className="flex items-center justify-between pb-2 border-b">
                  <span className="text-xs text-muted-foreground">
                    {endpoints.length}개 엔드포인트
                  </span>
                  <Button size="sm" variant="ghost" onClick={toggleAll}>
                    {selectedEndpoints.size === endpoints.length ? '전체 해제' : '전체 선택'}
                  </Button>
                </div>

                {endpoints.map((ep) => {
                  const isSelected = selectedEndpoints.has(ep.id);
                  return (
                    <button
                      key={ep.id}
                      type="button"
                      onClick={() => toggleEndpoint(ep.id)}
                      className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-colors text-left ${
                        isSelected
                          ? 'border-primary bg-primary/5'
                          : 'border-transparent hover:bg-muted/50'
                      }`}
                    >
                      {/* 체크 표시 */}
                      <div className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 ${
                        isSelected ? 'bg-primary border-primary' : 'border-muted-foreground/40'
                      }`}>
                        {isSelected && <Check className="h-3 w-3 text-primary-foreground" />}
                      </div>

                      {/* 메서드 + 경로 */}
                      <div className="flex items-center gap-2 min-w-0">
                        <Badge
                          variant="outline"
                          className={`text-xs shrink-0 ${
                            ep.method === 'GET' ? 'text-green-600 border-green-600/30' :
                            ep.method === 'POST' ? 'text-blue-600 border-blue-600/30' :
                            ep.method === 'PUT' ? 'text-orange-600 border-orange-600/30' :
                            ep.method === 'DELETE' ? 'text-red-600 border-red-600/30' :
                            ''
                          }`}
                        >
                          {ep.method}
                        </Badge>
                        <span className="text-sm font-mono truncate">{ep.path}</span>
                      </div>
                    </button>
                  );
                })}
              </>
            )}
          </div>

          <SheetFooter className="mt-4">
            <Button
              variant="outline"
              onClick={closeMappingSheet}
            >
              취소
            </Button>
            <Button
              onClick={() => void submitMapping()}
              disabled={selectedEndpoints.size === 0 || submittingMapping}
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              {submittingMapping ? '처리 중...' : `${selectedEndpoints.size}개 매핑 적용`}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
