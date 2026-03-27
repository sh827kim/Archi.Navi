import { and, eq, or } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
  codeArtifacts,
  codeCallEdges,
  evidences,
  objects,
  objectRelations,
  relationCandidateEvidences,
  relationCandidates,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';

export interface LlmBoostSuggestion {
  targetServiceName: string;
  relationType: 'call' | 'depend_on' | 'read' | 'write' | 'produce' | 'consume';
  confidence?: number;
  reasoning: string;
}

export interface LlmBoostContext {
  callerServiceId: string;
  callerServiceName: string;
  filePath: string | null;
  excerpt: string | null;
  calleeSymbol: string;
  candidateServices: string[];
}

export interface LlmBoostRequest {
  workspaceId: string;
  repoRoots?: string[];
  maxCalls?: number;
}

export interface LlmBoostResult {
  scannedCount: number;
  generatedCount: number;
  skippedCount: number;
  callCount: number;
  errorCount: number;
}

export type GenerateBoostSuggestionFn = (
  context: LlmBoostContext,
) => Promise<LlmBoostSuggestion | null>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function clampBoostConfidence(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.6;
  return Math.max(0.5, Math.min(0.7, value));
}

function normalizeServiceName(value: string): string {
  return value.trim().toLowerCase().replace(/[-_.]/g, '');
}

function buildBoostMetadata(
  existingMetadata: Record<string, unknown>,
  input: {
    calleeSymbol: string;
    reasoning: string;
    targetServiceName: string;
    confidence: number;
  },
): Record<string, unknown> {
  return {
    ...existingMetadata,
    source: 'LLM_BOOST',
    llmBoost: {
      calleeSymbol: input.calleeSymbol,
      targetServiceName: input.targetServiceName,
      reasoning: input.reasoning,
      suggestedConfidence: input.confidence,
      generatedAt: new Date().toISOString(),
    },
  };
}

async function upsertBoostCandidate(
  db: DbClient,
  input: {
    workspaceId: string;
    subjectObjectId: string;
    objectId: string;
    relationType: LlmBoostSuggestion['relationType'];
    confidence: number;
    evidenceId: string;
    metadata: Record<string, unknown>;
  },
): Promise<boolean> {
  const existing = await db
    .select({
      id: relationCandidates.id,
      status: relationCandidates.status,
      confidence: relationCandidates.confidence,
      metadata: relationCandidates.metadata,
    })
    .from(relationCandidates)
    .where(
      and(
        eq(relationCandidates.workspaceId, input.workspaceId),
        eq(relationCandidates.subjectObjectId, input.subjectObjectId),
        eq(relationCandidates.objectId, input.objectId),
        eq(relationCandidates.relationType, input.relationType),
        or(eq(relationCandidates.status, 'PENDING'), eq(relationCandidates.status, 'APPROVED')),
      ),
    );

  const approved = existing.find((row) => row.status === 'APPROVED');
  if (approved) return false;

  const pending = existing.find((row) => row.status === 'PENDING');
  if (pending) {
    const existingMetadata = asRecord(pending.metadata) ?? {};
    const mergedMetadata =
      typeof existingMetadata.source === 'string' && existingMetadata.source !== 'LLM_BOOST'
        ? existingMetadata
        : input.metadata;

    if ((pending.confidence ?? 0) < input.confidence || existingMetadata.source === 'LLM_BOOST') {
      await db
        .update(relationCandidates)
        .set({
          confidence: Math.max(pending.confidence ?? 0, input.confidence),
          metadata: mergedMetadata,
        })
        .where(eq(relationCandidates.id, pending.id));
    }

    await db
      .insert(relationCandidateEvidences)
      .values({
        workspaceId: input.workspaceId,
        candidateId: pending.id,
        evidenceId: input.evidenceId,
      })
      .onConflictDoNothing();
    return false;
  }

  const candidateId = generateId();
  await db.insert(relationCandidates).values({
    id: candidateId,
    workspaceId: input.workspaceId,
    relationType: input.relationType,
    subjectObjectId: input.subjectObjectId,
    objectId: input.objectId,
    confidence: input.confidence,
    metadata: input.metadata,
    status: 'PENDING',
  });
  await db.insert(relationCandidateEvidences).values({
    workspaceId: input.workspaceId,
    candidateId,
    evidenceId: input.evidenceId,
  });
  return true;
}

export async function generateBoostCandidates(
  db: DbClient,
  generateFn: GenerateBoostSuggestionFn,
  request: LlmBoostRequest,
): Promise<LlmBoostResult> {
  const callerRows = await db
    .select({
      edgeId: codeCallEdges.id,
      calleeSymbol: codeCallEdges.calleeSymbol,
      calleeOwnerObjectId: codeCallEdges.calleeOwnerObjectId,
      evidenceId: codeCallEdges.evidenceId,
      evidenceMeta: evidences.metadata,
      repoRoot: codeArtifacts.repoRoot,
      filePath: evidences.filePath,
      excerpt: evidences.excerpt,
      callerServiceId: objects.id,
      callerServiceName: objects.name,
    })
    .from(codeCallEdges)
    .innerJoin(codeArtifacts, eq(codeCallEdges.callerArtifactId, codeArtifacts.id))
    .innerJoin(objects, eq(codeArtifacts.ownerObjectId, objects.id))
    .leftJoin(evidences, eq(codeCallEdges.evidenceId, evidences.id))
    .where(
      and(
        eq(codeCallEdges.workspaceId, request.workspaceId),
        eq(objects.workspaceId, request.workspaceId),
        eq(objects.objectType, 'service'),
      ),
    );

  const serviceRows = await db
    .select({ id: objects.id, name: objects.name })
    .from(objects)
    .where(and(eq(objects.workspaceId, request.workspaceId), eq(objects.objectType, 'service')));

  const normalizedServices = new Map(
    serviceRows.map((service) => [normalizeServiceName(service.name), service]),
  );

  const filteredRows = callerRows.filter((row) => {
    if (!row.evidenceId) return false;
    if (row.calleeOwnerObjectId) return false;
    const evidenceMeta = asRecord(row.evidenceMeta);
    if (evidenceMeta?.kind !== 'call') return false;
    if (request.repoRoots && request.repoRoots.length > 0) {
      return !!row.repoRoot && request.repoRoots.includes(row.repoRoot);
    }
    return true;
  });

  const maxCalls = typeof request.maxCalls === 'number' ? Math.max(request.maxCalls, 0) : 50;
  let callCount = 0;
  let generatedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const row of filteredRows) {
    if (callCount >= maxCalls) {
      skippedCount += 1;
      continue;
    }

    try {
      callCount += 1;
      const suggestion = await generateFn({
        callerServiceId: row.callerServiceId,
        callerServiceName: row.callerServiceName,
        filePath: row.filePath,
        excerpt: row.excerpt,
        calleeSymbol: row.calleeSymbol,
        candidateServices: serviceRows.map((service) => service.name),
      });
      if (!suggestion) {
        skippedCount += 1;
        continue;
      }

      const target = normalizedServices.get(normalizeServiceName(suggestion.targetServiceName));
      if (!target || target.id === row.callerServiceId || !row.evidenceId) {
        skippedCount += 1;
        continue;
      }

      const manualRelation = await db
        .select({ id: objectRelations.id })
        .from(objectRelations)
        .where(
          and(
            eq(objectRelations.workspaceId, request.workspaceId),
            eq(objectRelations.subjectObjectId, row.callerServiceId),
            eq(objectRelations.objectId, target.id),
            eq(objectRelations.relationType, suggestion.relationType),
            eq(objectRelations.source, 'MANUAL'),
          ),
        )
        .limit(1);
      if (manualRelation[0]) {
        skippedCount += 1;
        continue;
      }

      const created = await upsertBoostCandidate(db, {
        workspaceId: request.workspaceId,
        subjectObjectId: row.callerServiceId,
        objectId: target.id,
        relationType: suggestion.relationType,
        confidence: clampBoostConfidence(suggestion.confidence),
        evidenceId: row.evidenceId,
        metadata: buildBoostMetadata({}, {
          calleeSymbol: row.calleeSymbol,
          reasoning: suggestion.reasoning,
          targetServiceName: target.name,
          confidence: clampBoostConfidence(suggestion.confidence),
        }),
      });
      if (created) {
        generatedCount += 1;
      }
    } catch {
      errorCount += 1;
    }
  }

  return {
    scannedCount: filteredRows.length,
    generatedCount,
    skippedCount,
    callCount,
    errorCount,
  };
}
