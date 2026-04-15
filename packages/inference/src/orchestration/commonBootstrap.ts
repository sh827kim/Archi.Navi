import type { DbClient } from '@archi-navi/db';
import {
  extractCodeSignalsWithEngine,
  type CodeSignalEngine,
} from '../code/codeSignalEngine';
import { inferRelationsFromCodeSignals } from '../relation/codeBased';

export interface CommonBootstrapRepoResult {
  repoRoot: string;
  engineRequested: CodeSignalEngine;
  engineUsed: CodeSignalEngine;
  enginesUsed: CodeSignalEngine[];
  fallbackUsed: boolean;
  fallbackCount: number;
  fileCount: number;
  signalCount: number;
  candidateCount: number;
  createdEndpointCount: number;
  createdTopicCount: number;
  createdQueueCount: number;
  createdDatabaseCount: number;
  createdDbTableCount: number;
  createdAtomicCount: number;
  warning: string | null;
  scanFailureCount: number;
}

export interface CommonBootstrapSummary {
  analyzedRepoCount: number;
  engineRequested: CodeSignalEngine;
  enginesUsed: CodeSignalEngine[];
  fallbackCount: number;
  scanFailureCount: number;
  fileCount: number;
  signalCount: number;
  candidateCount: number;
  createdEndpointCount: number;
  createdTopicCount: number;
  createdQueueCount: number;
  createdDatabaseCount: number;
  createdDbTableCount: number;
  createdAtomicCount: number;
  warnings: string[];
}

interface RunCommonBootstrapForRepoInput {
  workspaceId: string;
  repoRoot: string;
  codeEngine?: CodeSignalEngine;
  forceRescan?: boolean;
  skipExtraction?: boolean;
  bootstrapOnly?: boolean;
  enableDbScan?: boolean;
}

interface RunCommonBootstrapForRepoRootsInput {
  workspaceId: string;
  repoRoots: string[];
  codeEngine?: CodeSignalEngine;
  forceRescan?: boolean;
  bootstrapOnly?: boolean;
  enableDbScan?: boolean;
  onProgress?: (repoRoot: string, index: number, total: number) => void;
}

export async function runCommonBootstrapForRepo(
  db: DbClient,
  input: RunCommonBootstrapForRepoInput,
): Promise<CommonBootstrapRepoResult> {
  const skipExtraction = input.skipExtraction === true;
  const bootstrapOnly = input.bootstrapOnly !== false;

  let warning: string | null = null;
  let fileCount = 0;
  let signalCount = 0;
  let scanFailureCount = 0;
  let engineRequested: CodeSignalEngine = input.codeEngine ?? 'hybrid';
  let engineUsed: CodeSignalEngine = input.codeEngine ?? 'hybrid';
  let fallbackUsed = false;

  if (!skipExtraction) {
    const extracted = await extractCodeSignalsWithEngine(db, {
      workspaceId: input.workspaceId,
      repoRoot: input.repoRoot,
      codeEngine: input.codeEngine ?? 'hybrid',
      ...(input.forceRescan !== undefined ? { forceRescan: input.forceRescan } : {}),
    });
    fileCount = extracted.fileCount;
    signalCount = extracted.signalCount;
    warning = extracted.warning ?? null;
    scanFailureCount = Array.isArray(extracted.scanFailures) ? extracted.scanFailures.length : 0;
    engineRequested = extracted.engineRequested;
    engineUsed = extracted.engineUsed;
    fallbackUsed = extracted.fallbackUsed;
  }

  const inferred = await inferRelationsFromCodeSignals(db, {
    workspaceId: input.workspaceId,
    repoRoot: input.repoRoot,
    bootstrapOnly,
    ...(input.enableDbScan !== undefined ? { enableDbScan: input.enableDbScan } : {}),
  });

  return {
    repoRoot: input.repoRoot,
    engineRequested,
    engineUsed,
    enginesUsed: [engineUsed],
    fallbackUsed,
    fallbackCount: fallbackUsed ? 1 : 0,
    fileCount,
    signalCount,
    candidateCount: inferred.candidateCount,
    createdEndpointCount: inferred.createdEndpointCount,
    createdTopicCount: inferred.createdTopicCount,
    createdQueueCount: inferred.createdQueueCount,
    createdDatabaseCount: inferred.createdDatabaseCount,
    createdDbTableCount: inferred.createdDbTableCount,
    createdAtomicCount:
      inferred.createdEndpointCount
      + inferred.createdTopicCount
      + inferred.createdQueueCount
      + inferred.createdDatabaseCount
      + inferred.createdDbTableCount,
    warning,
    scanFailureCount,
  };
}

export async function runCommonBootstrapForRepoRoots(
  db: DbClient,
  input: RunCommonBootstrapForRepoRootsInput,
): Promise<CommonBootstrapSummary> {
  const uniqueRepoRoots = Array.from(new Set(input.repoRoots));
  const summary: CommonBootstrapSummary = {
    analyzedRepoCount: 0,
    engineRequested: input.codeEngine ?? 'hybrid',
    enginesUsed: [],
    fallbackCount: 0,
    scanFailureCount: 0,
    fileCount: 0,
    signalCount: 0,
    candidateCount: 0,
    createdEndpointCount: 0,
    createdTopicCount: 0,
    createdQueueCount: 0,
    createdDatabaseCount: 0,
    createdDbTableCount: 0,
    createdAtomicCount: 0,
    warnings: [],
  };

  for (let i = 0; i < uniqueRepoRoots.length; i++) {
    const repoRoot = uniqueRepoRoots[i]!;
    input.onProgress?.(repoRoot, i, uniqueRepoRoots.length);

    try {
      const result = await runCommonBootstrapForRepo(db, {
        workspaceId: input.workspaceId,
        repoRoot,
        ...(input.codeEngine !== undefined ? { codeEngine: input.codeEngine } : {}),
        ...(input.forceRescan !== undefined ? { forceRescan: input.forceRescan } : {}),
        ...(input.bootstrapOnly !== undefined ? { bootstrapOnly: input.bootstrapOnly } : {}),
        ...(input.enableDbScan !== undefined ? { enableDbScan: input.enableDbScan } : {}),
      });

      summary.analyzedRepoCount += 1;
      summary.signalCount += result.signalCount;
      summary.fileCount += result.fileCount;
      summary.fallbackCount += result.fallbackCount;
      summary.scanFailureCount += result.scanFailureCount;
      if (!summary.enginesUsed.includes(result.engineUsed)) {
        summary.enginesUsed.push(result.engineUsed);
      }
      summary.candidateCount += result.candidateCount;
      summary.createdEndpointCount += result.createdEndpointCount;
      summary.createdTopicCount += result.createdTopicCount;
      summary.createdQueueCount += result.createdQueueCount;
      summary.createdDatabaseCount += result.createdDatabaseCount;
      summary.createdDbTableCount += result.createdDbTableCount;
      summary.createdAtomicCount += result.createdAtomicCount;
      if (result.warning) {
        summary.warnings.push(`[${repoRoot}] ${result.warning}`);
      }
      if (result.scanFailureCount > 0) {
        summary.warnings.push(`[${repoRoot}] 파싱 실패 ${result.scanFailureCount}건`);
      }
    } catch (error) {
      summary.warnings.push(
        `[${repoRoot}] bootstrap 실패: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  return summary;
}
