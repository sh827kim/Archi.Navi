import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
  objects,
  proofFrontiers,
  proofStates,
  relationCandidates,
} from '@archi-navi/db';

export interface IntentProofCutoverRelation {
  subject: string;
  relationType: string;
  object: string;
}

export interface IntentProofCutoverFrontier {
  key: string;
  recoverable: boolean;
  recovered: boolean;
}

export interface IntentProofCutoverArtifact {
  label: string;
  relations: IntentProofCutoverRelation[];
  frontiers?: IntentProofCutoverFrontier[];
  approvalCount?: number;
  failedChecks?: string[];
}

export interface IntentProofCutoverTruthCorpus {
  relations: IntentProofCutoverRelation[];
}

export interface IntentProofCutoverThresholds {
  minPrecisionDelta?: number;
  minRecallDelta?: number;
  minCandidateFrontierRecoverability?: number;
  maxApprovalCountDelta?: number;
}

export interface IntentProofCutoverMetadata {
  commitSha: string;
  corpusRef: string;
  baselineCommand: string;
  candidateCommand: string;
  baselineArtifactPath: string;
  candidateArtifactPath: string;
}

export interface IntentProofCutoverMetrics {
  truthRelationCount: number;
  baselineRelationCount: number;
  candidateRelationCount: number;
  baselineTruePositives: number;
  candidateTruePositives: number;
  baselineFalsePositives: number;
  candidateFalsePositives: number;
  baselineFalseNegatives: number;
  candidateFalseNegatives: number;
  baselinePrecision: number;
  candidatePrecision: number;
  precisionDelta: number;
  baselineRecall: number;
  candidateRecall: number;
  recallDelta: number;
  baselineFrontierRecoverability: number | null;
  candidateFrontierRecoverability: number | null;
  frontierRecoverabilityDelta: number | null;
  baselineApprovalCount: number;
  candidateApprovalCount: number;
  approvalCountDelta: number;
}

export interface IntentProofCutoverRecommendation {
  decision: 'GO' | 'NO_GO';
  reasons: string[];
}

export interface IntentProofCutoverReport {
  version: string;
  generatedAt: string;
  metadata: IntentProofCutoverMetadata;
  metrics: IntentProofCutoverMetrics;
  failedChecks: string[];
  recommendation: IntentProofCutoverRecommendation;
}

interface BuildIntentProofCutoverArtifactInput {
  workspaceId: string;
  label: string;
  failedChecks?: string[];
}

const DEFAULT_THRESHOLDS: Required<IntentProofCutoverThresholds> = {
  minPrecisionDelta: 0,
  minRecallDelta: 0,
  minCandidateFrontierRecoverability: 0,
  maxApprovalCountDelta: 0,
};

function round(value: number): number {
  return Number(value.toFixed(3));
}

function relationKey(relation: IntentProofCutoverRelation): string {
  return `${relation.subject}::${relation.relationType}::${relation.object}`;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return numerator <= 0 ? 1 : 0;
  return round(numerator / denominator);
}

function recoverability(frontiers: IntentProofCutoverFrontier[] | undefined): number | null {
  const recoverable = (frontiers ?? []).filter((frontier) => frontier.recoverable);
  if (recoverable.length === 0) return null;
  return ratio(
    recoverable.filter((frontier) => frontier.recovered).length,
    recoverable.length,
  );
}

function evaluateRelations(
  predicted: IntentProofCutoverRelation[],
  truth: IntentProofCutoverRelation[],
) {
  const truthKeys = new Set(truth.map(relationKey));
  const predictedKeys = new Set(predicted.map(relationKey));

  let truePositives = 0;
  for (const key of predictedKeys) {
    if (truthKeys.has(key)) truePositives += 1;
  }

  return {
    predictedCount: predictedKeys.size,
    truePositives,
    falsePositives: predictedKeys.size - truePositives,
    falseNegatives: Math.max(truthKeys.size - truePositives, 0),
    precision: ratio(truePositives, predictedKeys.size),
    recall: ratio(truePositives, truthKeys.size),
  };
}

function mergeThresholds(
  thresholds?: IntentProofCutoverThresholds,
): Required<IntentProofCutoverThresholds> {
  return {
    minPrecisionDelta: thresholds?.minPrecisionDelta ?? DEFAULT_THRESHOLDS.minPrecisionDelta,
    minRecallDelta: thresholds?.minRecallDelta ?? DEFAULT_THRESHOLDS.minRecallDelta,
    minCandidateFrontierRecoverability:
      thresholds?.minCandidateFrontierRecoverability
      ?? DEFAULT_THRESHOLDS.minCandidateFrontierRecoverability,
    maxApprovalCountDelta:
      thresholds?.maxApprovalCountDelta ?? DEFAULT_THRESHOLDS.maxApprovalCountDelta,
  };
}

function normalizeArtifactStringList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

function buildObjectReference(
  objectId: string,
  objectRow:
    | {
        id: string;
        objectType: string;
        name: string;
        path: string;
      }
    | undefined,
): string {
  if (!objectRow) return `unknown:${objectId}`;

  const normalizedPath = objectRow.path.trim();
  if (normalizedPath.length > 0 && normalizedPath !== `/${objectRow.id}`) {
    return `${objectRow.objectType}:${normalizedPath}`;
  }
  return `${objectRow.objectType}:${objectRow.name}`;
}

export async function buildIntentProofCutoverArtifact(
  db: DbClient,
  input: BuildIntentProofCutoverArtifactInput,
): Promise<IntentProofCutoverArtifact> {
  const candidateRows = await db
    .select({
      relationType: relationCandidates.relationType,
      subjectObjectId: relationCandidates.subjectObjectId,
      objectId: relationCandidates.objectId,
    })
    .from(relationCandidates)
    .where(
      and(
        eq(relationCandidates.workspaceId, input.workspaceId),
        eq(relationCandidates.status, 'PENDING'),
      ),
    );

  const frontierRows = await db
    .select({
      proofStateId: proofFrontiers.proofStateId,
      frontierReason: proofFrontiers.frontierReason,
      retryStrategy: proofFrontiers.retryStrategy,
      consumerServiceId: proofStates.consumerServiceId,
      providerServiceId: proofStates.providerServiceId,
      targetObjectId: proofStates.targetObjectId,
    })
    .from(proofFrontiers)
    .innerJoin(proofStates, eq(proofFrontiers.proofStateId, proofStates.id))
    .where(eq(proofFrontiers.workspaceId, input.workspaceId));

  const objectIds = [
    ...new Set([
      ...candidateRows.flatMap((row) => [row.subjectObjectId, row.objectId]),
      ...frontierRows.flatMap((row) => [
        row.consumerServiceId,
        row.providerServiceId,
        row.targetObjectId,
      ]),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0)),
  ];

  const objectRows = objectIds.length === 0
    ? []
    : await db
      .select({
        id: objects.id,
        objectType: objects.objectType,
        name: objects.name,
        path: objects.path,
      })
      .from(objects)
      .where(inArray(objects.id, objectIds));

  const objectMap = new Map(objectRows.map((row) => [row.id, row]));

  const relations = candidateRows
    .map((row) => ({
      subject: buildObjectReference(row.subjectObjectId, objectMap.get(row.subjectObjectId)),
      relationType: row.relationType,
      object: buildObjectReference(row.objectId, objectMap.get(row.objectId)),
    }))
    .sort((left, right) => relationKey(left).localeCompare(relationKey(right)));

  const frontiers = frontierRows
    .map((row) => {
      const consumer = buildObjectReference(row.consumerServiceId, objectMap.get(row.consumerServiceId));
      const targetId = row.targetObjectId ?? row.providerServiceId ?? row.consumerServiceId;
      const target = buildObjectReference(targetId, objectMap.get(targetId));
      return {
        key: `${consumer}::${row.frontierReason}::${target}::${row.proofStateId}`,
        recoverable: row.retryStrategy !== 'manual_review',
        recovered: false,
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));

  const failedChecks = normalizeArtifactStringList(input.failedChecks);

  return {
    label: input.label,
    relations,
    ...(frontiers.length > 0 ? { frontiers } : {}),
    approvalCount: relations.length + frontiers.length,
    ...(failedChecks.length > 0 ? { failedChecks } : {}),
  };
}

export function buildIntentProofCutoverReport(input: {
  baseline: IntentProofCutoverArtifact;
  candidate: IntentProofCutoverArtifact;
  truth: IntentProofCutoverTruthCorpus;
  metadata: IntentProofCutoverMetadata;
  thresholds?: IntentProofCutoverThresholds;
}): IntentProofCutoverReport {
  const thresholds = mergeThresholds(input.thresholds);
  const baselineEval = evaluateRelations(input.baseline.relations, input.truth.relations);
  const candidateEval = evaluateRelations(input.candidate.relations, input.truth.relations);
  const baselineFrontierRecoverability = recoverability(input.baseline.frontiers);
  const candidateFrontierRecoverability = recoverability(input.candidate.frontiers);
  const baselineApprovalCount = input.baseline.approvalCount ?? input.baseline.relations.length;
  const candidateApprovalCount = input.candidate.approvalCount ?? input.candidate.relations.length;
  const approvalCountDelta = candidateApprovalCount - baselineApprovalCount;
  const precisionDelta = round(candidateEval.precision - baselineEval.precision);
  const recallDelta = round(candidateEval.recall - baselineEval.recall);
  const frontierRecoverabilityDelta =
    baselineFrontierRecoverability === null || candidateFrontierRecoverability === null
      ? null
      : round(candidateFrontierRecoverability - baselineFrontierRecoverability);

  const failedChecks = [
    ...(input.baseline.failedChecks ?? []).map((check) => `[baseline] ${check}`),
    ...(input.candidate.failedChecks ?? []).map((check) => `[candidate] ${check}`),
  ];

  if (precisionDelta < thresholds.minPrecisionDelta) {
    failedChecks.push(
      `precisionDelta ${precisionDelta} fell below ${thresholds.minPrecisionDelta}`,
    );
  }
  if (recallDelta < thresholds.minRecallDelta) {
    failedChecks.push(`recallDelta ${recallDelta} fell below ${thresholds.minRecallDelta}`);
  }
  if (
    candidateFrontierRecoverability !== null
    && candidateFrontierRecoverability < thresholds.minCandidateFrontierRecoverability
  ) {
    failedChecks.push(
      `candidateFrontierRecoverability ${candidateFrontierRecoverability} fell below ${thresholds.minCandidateFrontierRecoverability}`,
    );
  }
  if (approvalCountDelta > thresholds.maxApprovalCountDelta) {
    failedChecks.push(
      `approvalCountDelta ${approvalCountDelta} exceeded ${thresholds.maxApprovalCountDelta}`,
    );
  }

  const metrics: IntentProofCutoverMetrics = {
    truthRelationCount: new Set(input.truth.relations.map(relationKey)).size,
    baselineRelationCount: baselineEval.predictedCount,
    candidateRelationCount: candidateEval.predictedCount,
    baselineTruePositives: baselineEval.truePositives,
    candidateTruePositives: candidateEval.truePositives,
    baselineFalsePositives: baselineEval.falsePositives,
    candidateFalsePositives: candidateEval.falsePositives,
    baselineFalseNegatives: baselineEval.falseNegatives,
    candidateFalseNegatives: candidateEval.falseNegatives,
    baselinePrecision: baselineEval.precision,
    candidatePrecision: candidateEval.precision,
    precisionDelta,
    baselineRecall: baselineEval.recall,
    candidateRecall: candidateEval.recall,
    recallDelta,
    baselineFrontierRecoverability,
    candidateFrontierRecoverability,
    frontierRecoverabilityDelta,
    baselineApprovalCount,
    candidateApprovalCount,
    approvalCountDelta,
  };

  const recommendation: IntentProofCutoverRecommendation =
    failedChecks.length === 0
      ? {
          decision: 'GO',
          reasons: [
            'candidate precision/recall met cutover thresholds',
            'approval workload did not regress beyond threshold',
          ],
        }
      : {
          decision: 'NO_GO',
          reasons: failedChecks,
        };

  return {
    version: 'intent-proof-cutover-report-v1',
    generatedAt: new Date().toISOString(),
    metadata: input.metadata,
    metrics,
    failedChecks,
    recommendation,
  };
}
