import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
  evidences,
  objectRelations,
  objects,
  relationCandidateEvidences,
  relationCandidates,
} from '@archi-navi/db';

export type CrossValidationSource = 'config' | 'code' | 'db';
export type CrossValidationRuleId = 'C1' | 'C2' | 'C3' | 'C4';
export type CrossValidationContradictionType =
  | 'STALE_CONFIG'
  | 'PHANTOM_CALL'
  | 'DEAD_TOPIC'
  | 'ORPHAN_FK';

export interface CrossValidationSummary {
  candidateCount: number;
  validatedCount: number;
  skippedSingleSourceCount: number;
  contradictionCount: number;
  staleConfigCount: number;
}

export interface CrossValidationConfig {
  enabled: boolean;
  boostFactor: number;
  penaltyFactor: number;
}

interface CrossValidationMetadata {
  validated?: boolean;
  supportingSources?: CrossValidationSource[];
  contradictions?: Array<{
    ruleId: CrossValidationRuleId;
    type: CrossValidationContradictionType;
    penalty: number;
  }>;
  originalConfidence?: number;
  adjustedConfidence?: number;
  validatedAt?: string;
}

interface CrossValidationContradiction {
  ruleId: CrossValidationRuleId;
  type: CrossValidationContradictionType;
  penalty: number;
}

export const DEFAULT_CROSS_VALIDATION_CONFIG: CrossValidationConfig = {
  enabled: true,
  boostFactor: 0.3,
  penaltyFactor: 0.85,
};
const SOURCE_ORDER: CrossValidationSource[] = ['config', 'code', 'db'];
const CONFIG_ENDPOINT_SOURCES = new Set(['application_yml', 'docker_compose', 'k8s_manifest']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeEvidenceType(type: string): CrossValidationSource | null {
  if (type === 'CONFIG') return 'config';
  if (type === 'LLM_CONFIG') return 'config';
  if (type === 'FILE') return 'code';
  if (type === 'LLM_CODE') return 'code';
  if (type === 'SCHEMA') return 'db';
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function computeAdjustedConfidence(
  originalConfidence: number,
  supportCount: number,
  boostFactor: number,
  totalPenalty = 0,
): number {
  const boost = supportCount > 1 ? 1 - Math.pow(1 - boostFactor, supportCount - 1) : 0;
  return clamp(originalConfidence + boost - totalPenalty, 0.1, 0.99);
}

function readCrossValidationMetadata(metadata: Record<string, unknown>): CrossValidationMetadata | null {
  return asRecord(metadata.crossValidation) as CrossValidationMetadata | null;
}

function getOriginalConfidence(
  candidateConfidence: number,
  crossValidation: CrossValidationMetadata | null,
): number {
  return asFiniteNumber(crossValidation?.originalConfidence) ?? candidateConfidence;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function buildStaleConfigUsageKey(subjectObjectId: string, databaseId: string): string {
  return `${subjectObjectId}:${databaseId}`;
}

function buildRelationUsageKey(subjectObjectId: string, objectId: string): string {
  return `${subjectObjectId}:${objectId}`;
}

function isCodeOrConfigEndpointEvidenceSource(source: string | null): boolean {
  return source === 'CODE' || (source !== null && CONFIG_ENDPOINT_SOURCES.has(source));
}

function normalizeCrossValidationConfig(value: unknown): CrossValidationConfig {
  const record = asRecord(value);
  const enabled = typeof record?.enabled === 'boolean'
    ? record.enabled
    : DEFAULT_CROSS_VALIDATION_CONFIG.enabled;
  const boostFactor = clamp(
    asFiniteNumber(record?.boostFactor) ?? DEFAULT_CROSS_VALIDATION_CONFIG.boostFactor,
    0,
    1,
  );
  const penaltyFactor = clamp(
    asFiniteNumber(record?.penaltyFactor) ?? DEFAULT_CROSS_VALIDATION_CONFIG.penaltyFactor,
    0,
    1,
  );

  return {
    enabled,
    boostFactor,
    penaltyFactor,
  };
}

function contradictionPenalty(config: CrossValidationConfig): number {
  return Math.round(clamp(1 - config.penaltyFactor, 0, 0.99) * 10000) / 10000;
}

export async function crossValidatePendingRelationCandidates(
  db: DbClient,
  input: { workspaceId: string },
): Promise<CrossValidationSummary> {
  const profileRows = await db
    .execute<{ cross_validation: unknown }>(sql`
      select cross_validation
      from domain_inference_profiles
      where workspace_id = ${input.workspaceId}
        and is_default = true
      limit 1
    `);
  const config = normalizeCrossValidationConfig(profileRows.rows[0]?.cross_validation);
  if (!config.enabled) {
    return {
      candidateCount: 0,
      validatedCount: 0,
      skippedSingleSourceCount: 0,
      contradictionCount: 0,
      staleConfigCount: 0,
    };
  }

  const candidates = await db
    .select({
      id: relationCandidates.id,
      relationType: relationCandidates.relationType,
      subjectObjectId: relationCandidates.subjectObjectId,
      objectId: relationCandidates.objectId,
      confidence: relationCandidates.confidence,
      metadata: relationCandidates.metadata,
    })
    .from(relationCandidates)
    .where(
      and(
        eq(relationCandidates.workspaceId, input.workspaceId),
        eq(relationCandidates.status, 'PENDING'),
      ),
    );

  if (candidates.length === 0) {
    return {
      candidateCount: 0,
      validatedCount: 0,
      skippedSingleSourceCount: 0,
      contradictionCount: 0,
      staleConfigCount: 0,
    };
  }

  const candidateIds = candidates.map((candidate) => candidate.id);
  const evidenceRows = await db
    .select({
      candidateId: relationCandidateEvidences.candidateId,
      evidenceType: evidences.evidenceType,
    })
    .from(relationCandidateEvidences)
    .innerJoin(evidences, eq(relationCandidateEvidences.evidenceId, evidences.id))
    .where(
      and(
        eq(relationCandidateEvidences.workspaceId, input.workspaceId),
        inArray(relationCandidateEvidences.candidateId, candidateIds),
      ),
    );

  const allObjects = await db
    .select({
      id: objects.id,
      objectType: objects.objectType,
      parentId: objects.parentId,
    })
    .from(objects)
    .where(eq(objects.workspaceId, input.workspaceId));
  const objectMap = new Map(allObjects.map((object) => [object.id, object]));

  const relatedReadWriteCandidates = await db
    .select({
      subjectObjectId: relationCandidates.subjectObjectId,
      objectId: relationCandidates.objectId,
      relationType: relationCandidates.relationType,
      metadata: relationCandidates.metadata,
    })
    .from(relationCandidates)
    .where(
      and(
        eq(relationCandidates.workspaceId, input.workspaceId),
        or(eq(relationCandidates.status, 'PENDING'), eq(relationCandidates.status, 'APPROVED')),
        or(eq(relationCandidates.relationType, 'read'), eq(relationCandidates.relationType, 'write')),
      ),
    );
  const approvedReadWriteRelations = await db
    .select({
      subjectObjectId: objectRelations.subjectObjectId,
      objectId: objectRelations.objectId,
      source: objectRelations.source,
    })
    .from(objectRelations)
    .where(
      and(
        eq(objectRelations.workspaceId, input.workspaceId),
        eq(objectRelations.status, 'APPROVED'),
        or(eq(objectRelations.relationType, 'read'), eq(objectRelations.relationType, 'write')),
      ),
    );
  const relatedCallCandidates = await db
    .select({
      subjectObjectId: relationCandidates.subjectObjectId,
      objectId: relationCandidates.objectId,
      metadata: relationCandidates.metadata,
    })
    .from(relationCandidates)
    .where(
      and(
        eq(relationCandidates.workspaceId, input.workspaceId),
        or(eq(relationCandidates.status, 'PENDING'), eq(relationCandidates.status, 'APPROVED')),
        eq(relationCandidates.relationType, 'call'),
      ),
    );
  const approvedCallRelations = await db
    .select({
      subjectObjectId: objectRelations.subjectObjectId,
      objectId: objectRelations.objectId,
    })
    .from(objectRelations)
    .where(
      and(
        eq(objectRelations.workspaceId, input.workspaceId),
        eq(objectRelations.status, 'APPROVED'),
        eq(objectRelations.relationType, 'call'),
      ),
    );

  const codeDbUsageKeys = new Set<string>();
  const codeTableAccessObjectIds = new Set<string>();
  const endpointEvidenceKeys = new Set<string>();
  const codeTopicUsageKeys = new Set<string>();
  for (const relatedCandidate of relatedReadWriteCandidates) {
    const metadata = asRecord(relatedCandidate.metadata) ?? {};
    if (asString(metadata.source) !== 'CODE') continue;

    const targetObject = objectMap.get(relatedCandidate.objectId);
    if (!targetObject || targetObject.objectType !== 'db_table') continue;

    codeTableAccessObjectIds.add(relatedCandidate.objectId);
    if (!targetObject.parentId) continue;

    codeDbUsageKeys.add(
      buildStaleConfigUsageKey(relatedCandidate.subjectObjectId, targetObject.parentId),
    );
  }
  for (const approvedRelation of approvedReadWriteRelations) {
    if (approvedRelation.source !== 'INFERRED') continue;

    const targetObject = objectMap.get(approvedRelation.objectId);
    if (!targetObject || targetObject.objectType !== 'db_table') continue;

    codeTableAccessObjectIds.add(approvedRelation.objectId);
    if (!targetObject.parentId) continue;

    codeDbUsageKeys.add(
      buildStaleConfigUsageKey(approvedRelation.subjectObjectId, targetObject.parentId),
    );
  }
  for (const relatedCandidate of relatedCallCandidates) {
    const targetObject = objectMap.get(relatedCandidate.objectId);
    if (!targetObject || targetObject.objectType !== 'api_endpoint' || !targetObject.parentId) continue;

    const metadata = asRecord(relatedCandidate.metadata) ?? {};
    if (!isCodeOrConfigEndpointEvidenceSource(asString(metadata.source))) continue;

    endpointEvidenceKeys.add(
      buildRelationUsageKey(relatedCandidate.subjectObjectId, targetObject.parentId),
    );
  }
  for (const approvedRelation of approvedCallRelations) {
    const targetObject = objectMap.get(approvedRelation.objectId);
    if (!targetObject || targetObject.objectType !== 'api_endpoint' || !targetObject.parentId) continue;

    endpointEvidenceKeys.add(
      buildRelationUsageKey(approvedRelation.subjectObjectId, targetObject.parentId),
    );
  }

  const relatedProduceConsumeCandidates = await db
    .select({
      subjectObjectId: relationCandidates.subjectObjectId,
      objectId: relationCandidates.objectId,
      metadata: relationCandidates.metadata,
    })
    .from(relationCandidates)
    .where(
      and(
        eq(relationCandidates.workspaceId, input.workspaceId),
        or(eq(relationCandidates.status, 'PENDING'), eq(relationCandidates.status, 'APPROVED')),
        or(
          eq(relationCandidates.relationType, 'produce'),
          eq(relationCandidates.relationType, 'consume'),
        ),
      ),
    );
  for (const relatedCandidate of relatedProduceConsumeCandidates) {
    const metadata = asRecord(relatedCandidate.metadata) ?? {};
    if (asString(metadata.source) !== 'CODE') continue;

    codeTopicUsageKeys.add(
      buildRelationUsageKey(relatedCandidate.subjectObjectId, relatedCandidate.objectId),
    );
  }

  const sourcesByCandidateId = new Map<string, Set<CrossValidationSource>>();
  for (const row of evidenceRows) {
    const source = normalizeEvidenceType(row.evidenceType);
    if (!source) continue;

    const bucket = sourcesByCandidateId.get(row.candidateId) ?? new Set<CrossValidationSource>();
    bucket.add(source);
    sourcesByCandidateId.set(row.candidateId, bucket);
  }

  let validatedCount = 0;
  let skippedSingleSourceCount = 0;
  let contradictionCount = 0;
  let staleConfigCount = 0;

  for (const candidate of candidates) {
    const sourceSet = sourcesByCandidateId.get(candidate.id) ?? new Set<CrossValidationSource>();
    const supportingSources = SOURCE_ORDER.filter((source) => sourceSet.has(source));
    const subjectObject = objectMap.get(candidate.subjectObjectId);
    const targetObject = objectMap.get(candidate.objectId);
    const isDatabaseTarget = targetObject?.objectType === 'database';
    const isServiceTarget = targetObject?.objectType === 'service';
    const isDbTableSubject = subjectObject?.objectType === 'db_table';
    const isDbTableTarget = targetObject?.objectType === 'db_table';
    const isTopicTarget = targetObject?.objectType === 'topic'
      || targetObject?.objectType === 'kafka_topic';
    const hasConfigSupport = supportingSources.includes('config');
    const hasCodeSupport = supportingSources.includes('code');
    const hasDbSupport = supportingSources.includes('db');
    const isCallRelation = candidate.relationType === 'call';
    const isReadWriteRelation = candidate.relationType === 'read' || candidate.relationType === 'write';
    const isFkReferenceRelation = candidate.relationType === 'fk_reference';
    const isProduceConsumeRelation =
      candidate.relationType === 'produce' || candidate.relationType === 'consume';
    const hasCodeDbUsage = codeDbUsageKeys.has(
      buildStaleConfigUsageKey(candidate.subjectObjectId, candidate.objectId),
    );
    const hasCodeTableAccess = codeTableAccessObjectIds.has(candidate.subjectObjectId)
      || codeTableAccessObjectIds.has(candidate.objectId);
    const hasEndpointEvidence = endpointEvidenceKeys.has(
      buildRelationUsageKey(candidate.subjectObjectId, candidate.objectId),
    );
    const hasCodeTopicUsage = codeTopicUsageKeys.has(
      buildRelationUsageKey(candidate.subjectObjectId, candidate.objectId),
    );
    const metadata = asRecord(candidate.metadata) ?? {};
    const existingCrossValidation = readCrossValidationMetadata(metadata);
    const hadCrossValidation = Object.prototype.hasOwnProperty.call(metadata, 'crossValidation');

    const contradictions: CrossValidationContradiction[] = [];
    if (
      supportingSources.length < 2 &&
      hasConfigSupport &&
      isReadWriteRelation &&
      isDatabaseTarget &&
      !hasCodeDbUsage
    ) {
      contradictions.push({
        ruleId: 'C1',
        type: 'STALE_CONFIG',
        penalty: contradictionPenalty(config),
      });
    }
    if (
      supportingSources.length < 2 &&
      hasCodeSupport &&
      isCallRelation &&
      isServiceTarget &&
      !hasEndpointEvidence
    ) {
      contradictions.push({
        ruleId: 'C2',
        type: 'PHANTOM_CALL',
        penalty: contradictionPenalty(config),
      });
    }
    if (
      supportingSources.length < 2 &&
      hasConfigSupport &&
      isProduceConsumeRelation &&
      isTopicTarget &&
      !hasCodeTopicUsage
    ) {
      contradictions.push({
        ruleId: 'C3',
        type: 'DEAD_TOPIC',
        penalty: contradictionPenalty(config),
      });
    }
    if (
      supportingSources.length < 2 &&
      hasDbSupport &&
      isFkReferenceRelation &&
      isDbTableSubject &&
      isDbTableTarget &&
      !hasCodeTableAccess
    ) {
      contradictions.push({
        ruleId: 'C4',
        type: 'ORPHAN_FK',
        penalty: contradictionPenalty(config),
      });
    }

    if (supportingSources.length < 2 && contradictions.length === 0) {
      skippedSingleSourceCount += 1;
      if (hadCrossValidation) {
        const restoredConfidence = getOriginalConfidence(candidate.confidence, existingCrossValidation);
        const nextMetadata = { ...metadata };
        delete nextMetadata.crossValidation;
        await db
          .update(relationCandidates)
          .set({
            confidence: restoredConfidence,
            metadata: nextMetadata,
          })
          .where(eq(relationCandidates.id, candidate.id));
      }
      continue;
    }

    const originalConfidence = getOriginalConfidence(candidate.confidence, existingCrossValidation);
    const totalPenalty = contradictions.reduce((sum, contradiction) => sum + contradiction.penalty, 0);
    const adjustedConfidence = computeAdjustedConfidence(
      originalConfidence,
      supportingSources.length,
      config.boostFactor,
      totalPenalty,
    );

    const nextMetadata = {
      ...metadata,
      crossValidation: {
        validated: supportingSources.length > 1 && contradictions.length === 0,
        supportingSources,
        contradictions,
        originalConfidence,
        adjustedConfidence,
        validatedAt: new Date().toISOString(),
      },
    };

    await db
      .update(relationCandidates)
      .set({
        confidence: adjustedConfidence,
        metadata: nextMetadata,
      })
      .where(eq(relationCandidates.id, candidate.id));

    if (supportingSources.length > 1) {
      validatedCount += 1;
    }
    contradictionCount += contradictions.length;
    staleConfigCount += contradictions.filter((contradiction) => contradiction.type === 'STALE_CONFIG').length;
  }

  return {
    candidateCount: candidates.length,
    validatedCount,
    skippedSingleSourceCount,
    contradictionCount,
    staleConfigCount,
  };
}
