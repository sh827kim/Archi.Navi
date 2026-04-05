import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
  aliasBindings,
  functionSummaries,
  inferenceRunEvents,
  inferenceRuns,
  inferenceRunSources,
  interactionIntents,
  proofFrontiers,
  proofDependencies,
  proofStates,
  routeTransforms,
} from '@archi-navi/db';
import {
  extractCodeSignalsWithEngine,
  normalizeCodeSignalEngine,
  type CodeSignalEngine,
} from '../code/codeSignalEngine';
import { extractDbSchemaSignals } from '../db/dbSchemaSignal';
import { extractAliasBindingsFromCodeSignals, extractAliasBindingsFromConfig } from '../extraction/aliasBindings';
import { extractFunctionSummariesFromCodeSignals } from '../extraction/functionSummary';
import {
  extractInteractionIntentsFromCodeSignals,
  extractInteractionIntentsFromConfigRoutes,
} from '../extraction/intents';
import { extractRouteTransformsFromConfig } from '../extraction/routeTransforms';
import { runFrontierAgentPass } from '../agent/frontierAgent';
import { resolveSmartFrontier, type GenerateSmartResolutionFn, type SmartPatchProposal } from '../agent/smartFrontierResolver';
import { normalizeSmartProofConfig, type SmartProofConfig } from '../agent/smartProofTypes';
import {
  canAffordSmartBudgetCall,
  createSmartBudgetTracker,
  isSmartBudgetExhausted,
  recordSmartBudgetCall,
} from '../agent/smartBudgetTracker';
import { buildIntentProofResolverContext, resolveInteractionIntentProof } from './intentProofEngine';
import { buildProofEngineSummaryForRun } from './proofEngineRun';
import { buildIntentProofCutoverArtifact } from './intentProofCutoverReport';
import { findFiles } from '../utils/fileDiscovery';

export type InferenceMode = 'config' | 'code' | 'db';
export type InferenceSourceType = 'local' | 'githubRepo' | 'githubOrg';
export type InferenceRunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';

async function collectImpactedIntentIdsForRun(
  db: DbClient,
  input: {
    workspaceId: string;
    runId: string;
    incremental: boolean;
    deletedRouteTransformOwnerServiceIds?: string[];
    didDeleteGlobalRouteTransform?: boolean;
  },
): Promise<string[]> {
  const listAllIntentIds = async () => {
    const rows = await db
      .select({ id: interactionIntents.id })
      .from(interactionIntents)
      .where(eq(interactionIntents.workspaceId, input.workspaceId));
    return rows.map((row) => row.id);
  };

  if (!input.incremental) {
    return await listAllIntentIds();
  }

  const [updatedIntents, updatedBindings, updatedSummaries, updatedTransforms] = await Promise.all([
    db
      .select({ id: interactionIntents.id })
      .from(interactionIntents)
      .where(and(eq(interactionIntents.workspaceId, input.workspaceId), eq(interactionIntents.updatedRunId, input.runId))),
    db
      .select({ aliasKey: aliasBindings.aliasKey })
      .from(aliasBindings)
      .where(and(eq(aliasBindings.workspaceId, input.workspaceId), eq(aliasBindings.updatedRunId, input.runId))),
    db
      .select({ functionId: functionSummaries.functionId })
      .from(functionSummaries)
      .where(and(eq(functionSummaries.workspaceId, input.workspaceId), eq(functionSummaries.updatedRunId, input.runId))),
    db
      .select({ ownerServiceId: routeTransforms.ownerServiceId })
      .from(routeTransforms)
      .where(and(eq(routeTransforms.workspaceId, input.workspaceId), eq(routeTransforms.updatedRunId, input.runId))),
  ]);

  const dependencyClauses = [];
  const aliasKeys = updatedBindings.map((row) => row.aliasKey).filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (aliasKeys.length > 0) {
    dependencyClauses.push(and(eq(proofDependencies.dependencyKind, 'alias_binding'), inArray(proofDependencies.dependencyKey, aliasKeys)));
  }
  const functionIds = updatedSummaries.map((row) => row.functionId).filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (functionIds.length > 0) {
    dependencyClauses.push(and(eq(proofDependencies.dependencyKind, 'function_summary_function'), inArray(proofDependencies.dependencyKey, functionIds)));
  }
  const ownerServiceIds = [
    ...updatedTransforms
      .map((row) => row.ownerServiceId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ...(input.deletedRouteTransformOwnerServiceIds ?? []),
  ];
  const uniqueOwnerServiceIds = [...new Set(ownerServiceIds)];
  if (uniqueOwnerServiceIds.length > 0) {
    dependencyClauses.push(and(
      eq(proofDependencies.dependencyKind, 'route_transform_owner_service'),
      inArray(proofDependencies.dependencyKey, uniqueOwnerServiceIds),
    ));
  }
  const didUpdateGlobalRouteTransform = updatedTransforms.some((row) => row.ownerServiceId === null);
  if (didUpdateGlobalRouteTransform || input.didDeleteGlobalRouteTransform) {
    return await listAllIntentIds();
  }

  const dependencyBackedIntentIds = dependencyClauses.length === 0
    ? []
    : (
      await db
        .select({ intentId: proofStates.intentId })
        .from(proofDependencies)
        .innerJoin(proofStates, eq(proofStates.id, proofDependencies.proofStateId))
        .where(
          and(
            eq(proofDependencies.workspaceId, input.workspaceId),
            dependencyClauses.length === 1 ? dependencyClauses[0]! : or(...dependencyClauses),
          ),
        )
    ).map((row) => row.intentId);

  const impactedIntentIds = [...new Set([...updatedIntents.map((row) => row.id), ...dependencyBackedIntentIds])];
  if (impactedIntentIds.length > 0) {
    return impactedIntentIds;
  }

  const [allIntentIds, dependencyRows] = await Promise.all([
    listAllIntentIds(),
    db
      .select({ id: proofDependencies.id })
      .from(proofDependencies)
      .where(eq(proofDependencies.workspaceId, input.workspaceId))
      .limit(1),
  ]);

  // Bootstrap incremental runs still need one full proof pass before dependencies exist.
  return dependencyRows.length === 0 ? allIntentIds : [];
}

function countConfigFiles(repoRoot: string): { fileCount: number; processedFileCount: number; skippedFileCount: number } {
  const fileCount = findFiles(repoRoot, (filePath) => {
    const base = filePath.split('/').pop() ?? '';
    const normalized = filePath.replace(/\\/g, '/');
    if (
      (base.startsWith('application') || base.startsWith('bootstrap'))
      && (base.endsWith('.yml') || base.endsWith('.yaml'))
    ) {
      return true;
    }
    if (base.startsWith('docker-compose') && (base.endsWith('.yml') || base.endsWith('.yaml'))) {
      return true;
    }
    if (!(base.endsWith('.yml') || base.endsWith('.yaml'))) {
      return false;
    }
    return (
      normalized.includes('/k8s/')
      || normalized.includes('/kubernetes/')
      || normalized.includes('/manifests/')
      || base.startsWith('deployment')
      || base.startsWith('service')
    );
  }).length;

  return {
    fileCount,
    processedFileCount: fileCount,
    skippedFileCount: 0,
  };
}

const ALL_MODES: InferenceMode[] = ['config', 'code', 'db'];

function isInferenceMode(value: string): value is InferenceMode {
  return value === 'config' || value === 'code' || value === 'db';
}

function isInferenceSourceType(value: string): value is InferenceSourceType {
  return value === 'local' || value === 'githubRepo' || value === 'githubOrg';
}

function didAllSelectedModesSucceed(input: {
  modeSet: ReadonlySet<InferenceMode>;
  expectedLocalSourceCount: number;
  successfulConfigRepoCount: number;
  successfulCodeRepoCount: number;
  dbSucceeded: boolean;
}): boolean {
  const selectedConfigAndCodeModesSucceeded = didSelectedConfigAndCodeModesSucceed({
    modeSet: input.modeSet,
    expectedLocalSourceCount: input.expectedLocalSourceCount,
    successfulConfigRepoCount: input.successfulConfigRepoCount,
    successfulCodeRepoCount: input.successfulCodeRepoCount,
  });
  const selectedDbModeSucceeded = !input.modeSet.has('db') || input.dbSucceeded;

  return selectedConfigAndCodeModesSucceeded && selectedDbModeSucceeded;
}

function didSelectedConfigAndCodeModesSucceed(input: {
  modeSet: ReadonlySet<InferenceMode>;
  expectedLocalSourceCount: number;
  successfulConfigRepoCount: number;
  successfulCodeRepoCount: number;
}): boolean {
  const allSelectedCodeRootsSucceeded =
    !input.modeSet.has('code')
    || (
      input.expectedLocalSourceCount > 0
      && input.successfulCodeRepoCount === input.expectedLocalSourceCount
    );
  const allSelectedConfigRootsSucceeded =
    !input.modeSet.has('config')
    || (
      input.expectedLocalSourceCount > 0
      && input.successfulConfigRepoCount === input.expectedLocalSourceCount
    );

  return allSelectedCodeRootsSucceeded && allSelectedConfigRootsSucceeded;
}

function isLikelyRemotePath(pathValue: string): boolean {
  return /^https?:\/\//i.test(pathValue) || /^git@/i.test(pathValue);
}

function isLocalDirectory(pathValue: string): boolean {
  if (isLikelyRemotePath(pathValue)) return false;
  if (!existsSync(pathValue)) return false;
  try {
    return statSync(pathValue).isDirectory();
  } catch {
    return false;
  }
}

function getAllowedInferenceRoots(): string[] {
  const configuredRoots = (process.env['ARCHI_NAVI_ALLOWED_INFERENCE_ROOTS'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const fallbackRoot = process.env['ARCHI_NAVI_WORKSPACE_ROOT'] ?? process.cwd();
  const fallbackRoots = [fallbackRoot, homedir(), tmpdir()];
  return (configuredRoots.length > 0 ? configuredRoots : fallbackRoots)
    .map((root) => resolve(root))
    .filter(isLocalDirectory)
    .map((root) => {
      try {
        return realpathSync(root);
      } catch {
        return root;
      }
    });
}

function isPathWithinAllowedRoots(pathValue: string, allowedRoots: string[]): boolean {
  if (allowedRoots.length === 0) return false;

  const normalized = resolve(pathValue);
  let realPath = normalized;
  try {
    realPath = realpathSync(normalized);
  } catch {
    // fallback to resolved path if realpath is unavailable.
  }

  return allowedRoots.some((root) => realPath === root || realPath.startsWith(`${root}/`));
}

function normalizeModes(input?: string[]): InferenceMode[] {
  const requested = (input ?? ['config', 'db']).map((mode) => mode.toLowerCase().trim());
  const valid = requested.filter(isInferenceMode);
  const deduped = [...new Set(valid)];
  return deduped.length > 0 ? deduped : ['config', 'db'];
}

export interface InferenceRunSourceInput {
  type: InferenceSourceType | string;
  ref: string;
  metadata?: Record<string, unknown>;
}

export interface CreateInferenceRunInput {
  workspaceId: string;
  modes?: string[];
  codeEngine?: string | null;
  incremental?: boolean;
  smartProof?: boolean | SmartProofConfig | null;
  enableAgentPatches?: boolean;
  maxAgentFrontiers?: number | null;
  triggerType?: string;
  maxAttempts?: number;
  idempotencyKey?: string | null;
  sources?: InferenceRunSourceInput[];
}

export interface ExecuteInferenceRunInput {
  workspaceId: string;
  runId: string;
  smartGenerateFn?: GenerateSmartResolutionFn<SmartPatchProposal>;
}

export interface InferenceRunListItem {
  id: string;
  workspaceId: string;
  status: string;
  triggerType: string;
  requestedModes: unknown;
  requestedCodeEngine: string | null;
  requestedIncremental: boolean;
  attemptCount: number;
  maxAttempts: number;
  sourceSummary: unknown;
  stats: unknown;
  warnings: unknown;
  errors: unknown;
  errorMessage: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InferenceRunDetail {
  run: InferenceRunListItem;
  sources: Array<{
    id: string;
    sourceType: string;
    sourceRef: string;
    resolvedRepoRoot: string | null;
    status: string;
    message: string | null;
    metadata: unknown;
    createdAt: Date;
    updatedAt: Date;
  }>;
  events: Array<{
    id: string;
    level: string;
    eventType: string;
    message: string;
    payload: unknown;
    createdAt: Date;
  }>;
}

interface SourceRow {
  id: string;
  sourceType: string;
  sourceRef: string;
}

interface LocalSource {
  sourceId: string;
  repoRoot: string;
  cleanupDir?: string;
}

interface ResolveSourceResult {
  localSources: LocalSource[];
  warnings: string[];
  errors: Array<{ sourceId: string; message: string }>;
  sourceResolvedRoots: Map<string, string>;
}

function checkGhAuth() {
  execFileSync('gh', ['auth', 'status'], { stdio: 'pipe' });
}

function parseGithubRepoNwo(sourceRef: string): string {
  const trimmed = sourceRef.trim();
  if (trimmed.length === 0) return '';

  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/i);
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`;

  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;

  const nwoMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (nwoMatch) return `${nwoMatch[1]}/${nwoMatch[2]}`;

  return '';
}

function listGithubOrgRepos(org: string): string[] {
  const stdout = execFileSync(
    'gh',
    ['repo', 'list', org, '--json', 'name', '--limit', '200'],
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const parsed = JSON.parse(stdout) as Array<{ name?: string }>;
  return parsed
    .map((repo) => repo.name?.trim() ?? '')
    .filter((name) => name.length > 0);
}

function cloneGithubRepo(nwo: string, targetDir: string) {
  execFileSync('gh', ['repo', 'clone', nwo, targetDir, '--', '--depth', '1'], { stdio: 'pipe' });
}

async function appendRunEvent(
  db: DbClient,
  input: {
    workspaceId: string;
    runId: string;
    level?: 'INFO' | 'WARN' | 'ERROR';
    eventType: string;
    message: string;
    payload?: Record<string, unknown>;
  },
) {
  await db.insert(inferenceRunEvents).values({
    workspaceId: input.workspaceId,
    runId: input.runId,
    level: input.level ?? 'INFO',
    eventType: input.eventType,
    message: input.message,
    payload: input.payload ?? {},
  });
}

async function updateRunSource(
  db: DbClient,
  input: {
    sourceId: string;
    status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
    resolvedRepoRoot?: string | null;
    message?: string | null;
  },
) {
  await db
    .update(inferenceRunSources)
    .set({
      status: input.status,
      resolvedRepoRoot: input.resolvedRepoRoot ?? null,
      message: input.message ?? null,
      updatedAt: new Date(),
    })
    .where(eq(inferenceRunSources.id, input.sourceId));
}

function summarizeSources(sources: Array<{ sourceType: string }>): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const source of sources) {
    summary[source.sourceType] = (summary[source.sourceType] ?? 0) + 1;
  }
  return summary;
}

function readEnvBool(name: string): boolean | null {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return null;
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  return null;
}

function normalizeMaxAgentFrontiers(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 25;
  }
  return Math.max(0, Math.floor(value));
}

function buildRequestedAgentPatchSettings(input?: {
  enableAgentPatches?: boolean;
  maxAgentFrontiers?: number | null;
}): { enabled: boolean; maxFrontiers: number } {
  const envEnabled = readEnvBool('ARCHI_NAVI_ENABLE_AGENT_PATCHES');
  const enabled = input?.enableAgentPatches ?? envEnabled ?? false;
  const envMax = process.env['ARCHI_NAVI_MAX_AGENT_FRONTIERS'];
  const parsedEnvMax = envMax ? Number(envMax) : null;
  return {
    enabled,
    maxFrontiers: normalizeMaxAgentFrontiers(
      input?.maxAgentFrontiers ?? (typeof parsedEnvMax === 'number' && Number.isFinite(parsedEnvMax) ? parsedEnvMax : 25),
    ),
  };
}

function readRequestedAgentPatchSettingsFromRunStats(
  stats: unknown,
): { enabled: boolean; maxFrontiers: number } {
  const record = stats && typeof stats === 'object' && !Array.isArray(stats)
    ? (stats as Record<string, unknown>)
    : {};
  const requested = record['requestedAgentPatches'];
  const requestedRecord = requested && typeof requested === 'object' && !Array.isArray(requested)
    ? (requested as Record<string, unknown>)
    : {};
  return buildRequestedAgentPatchSettings({
    enableAgentPatches: requestedRecord['enabled'] === true,
    maxAgentFrontiers: typeof requestedRecord['maxFrontiers'] === 'number' ? requestedRecord['maxFrontiers'] : null,
  });
}

function readRequestedSmartProofSettingsFromRunStats(
  stats: unknown,
): SmartProofConfig {
  const record = stats && typeof stats === 'object' && !Array.isArray(stats)
    ? (stats as Record<string, unknown>)
    : {};
  return normalizeSmartProofConfig(record['requestedSmartProof'] as boolean | SmartProofConfig | null | undefined);
}

async function getInferenceRunStatus(
  db: DbClient,
  input: { workspaceId: string; runId: string },
): Promise<InferenceRunStatus | null> {
  const rows = await db
    .select({ status: inferenceRuns.status })
    .from(inferenceRuns)
    .where(
      and(
        eq(inferenceRuns.workspaceId, input.workspaceId),
        eq(inferenceRuns.id, input.runId),
      ),
    )
    .limit(1);

  const status = rows[0]?.status;
  if (
    status === 'QUEUED'
    || status === 'RUNNING'
    || status === 'SUCCEEDED'
    || status === 'FAILED'
    || status === 'CANCELED'
  ) {
    return status;
  }
  return null;
}

export async function createInferenceRun(
  db: DbClient,
  input: CreateInferenceRunInput,
): Promise<InferenceRunListItem> {
  const modes = normalizeModes(input.modes);
  const codeEngine: CodeSignalEngine = normalizeCodeSignalEngine(input.codeEngine ?? null);
  const normalizedSources = (input.sources ?? [])
    .map((source) => ({
      type: source.type,
      ref: source.ref.trim(),
      metadata: source.metadata ?? {},
    }))
    .filter((source) => source.ref.length > 0 && isInferenceSourceType(source.type));

  const uniqueSourceMap = new Map<string, { type: InferenceSourceType; ref: string; metadata: Record<string, unknown> }>();
  for (const source of normalizedSources) {
    const normalizedType = source.type as InferenceSourceType;
    const key = `${normalizedType}:${source.ref}`;
    if (!uniqueSourceMap.has(key)) {
      uniqueSourceMap.set(key, {
        type: normalizedType,
        ref: source.ref,
        metadata: source.metadata,
      });
    }
  }
  const uniqueSources = Array.from(uniqueSourceMap.values());
  const requestedAgentPatches = buildRequestedAgentPatchSettings(input);
  const requestedSmartProof = normalizeSmartProofConfig(input.smartProof);

  if (input.idempotencyKey) {
    const existing = await db
      .select()
      .from(inferenceRuns)
      .where(
        and(
          eq(inferenceRuns.workspaceId, input.workspaceId),
          eq(inferenceRuns.idempotencyKey, input.idempotencyKey),
          inArray(inferenceRuns.status, ['QUEUED', 'RUNNING']),
        ),
      )
      .orderBy(desc(inferenceRuns.createdAt))
      .limit(1);
    if (existing[0]) return existing[0];
  }

  const inserted = await db
    .insert(inferenceRuns)
    .values({
      workspaceId: input.workspaceId,
      triggerType: (input.triggerType ?? 'MANUAL').toUpperCase(),
      status: 'QUEUED',
      requestedModes: modes,
      requestedCodeEngine: codeEngine,
      requestedIncremental: input.incremental !== false,
      maxAttempts: Math.max(1, input.maxAttempts ?? 1),
      idempotencyKey: input.idempotencyKey ?? null,
      sourceSummary: summarizeSources(uniqueSources.map((source) => ({ sourceType: source.type }))),
      stats: {
        requestedAgentPatches,
        requestedSmartProof,
      },
      warnings: [],
      errors: [],
    })
    .returning();

  const run = inserted[0];
  if (!run) throw new Error('inference run 생성에 실패했습니다.');

  if (uniqueSources.length > 0) {
    await db.insert(inferenceRunSources).values(
      uniqueSources.map((source) => ({
        workspaceId: input.workspaceId,
        runId: run.id,
        sourceType: source.type,
        sourceRef: source.ref,
        metadata: source.metadata,
        status: 'QUEUED',
      })),
    );
  }

  await appendRunEvent(db, {
    workspaceId: input.workspaceId,
    runId: run.id,
    eventType: 'RUN_CREATED',
    message: 'Inference run이 생성되었습니다.',
    payload: {
      modes,
      codeEngine,
      sourceCount: uniqueSources.length,
      requestedAgentPatches,
      requestedSmartProof,
    },
  });

  return run;
}

async function resolveRunnableSources(
  db: DbClient,
  input: { workspaceId: string; runId: string; sources: SourceRow[] },
): Promise<ResolveSourceResult> {
  const localSources: LocalSource[] = [];
  const warnings: string[] = [];
  const errors: Array<{ sourceId: string; message: string }> = [];
  const sourceResolvedRoots = new Map<string, string>();
  const allowedInferenceRoots = getAllowedInferenceRoots();

  for (const source of input.sources) {
    if (source.sourceType === 'local') {
      const normalized = resolve(source.sourceRef);
      if (!isLocalDirectory(normalized)) {
        const message = `local source 경로를 찾을 수 없습니다: ${normalized}`;
        await updateRunSource(db, {
          sourceId: source.id,
          status: 'FAILED',
          resolvedRepoRoot: normalized,
          message,
        });
        errors.push({ sourceId: source.id, message });
        await appendRunEvent(db, {
          workspaceId: input.workspaceId,
          runId: input.runId,
          level: 'ERROR',
          eventType: 'SOURCE_RESOLVE_FAILED',
          message,
          payload: { sourceId: source.id, sourceRef: source.sourceRef, resolvedRepoRoot: normalized },
        });
        continue;
      }

      if (!isPathWithinAllowedRoots(normalized, allowedInferenceRoots)) {
        const message = `허용된 local source 경로가 아닙니다: ${normalized}`;
        await updateRunSource(db, {
          sourceId: source.id,
          status: 'FAILED',
          resolvedRepoRoot: normalized,
          message,
        });
        errors.push({ sourceId: source.id, message });
        await appendRunEvent(db, {
          workspaceId: input.workspaceId,
          runId: input.runId,
          level: 'ERROR',
          eventType: 'SOURCE_RESOLVE_FAILED',
          message,
          payload: {
            sourceId: source.id,
            sourceRef: source.sourceRef,
            resolvedRepoRoot: normalized,
            allowedInferenceRoots,
          },
        });
        continue;
      }

      await updateRunSource(db, {
        sourceId: source.id,
        status: 'RUNNING',
        resolvedRepoRoot: normalized,
        message: null,
      });
      sourceResolvedRoots.set(source.id, normalized);
      localSources.push({
        sourceId: source.id,
        repoRoot: normalized,
      });
      continue;
    }

    if (source.sourceType === 'githubRepo') {
      const nwo = parseGithubRepoNwo(source.sourceRef);
      if (!nwo) {
        const message = `githubRepo source 형식이 올바르지 않습니다: ${source.sourceRef}`;
        await updateRunSource(db, {
          sourceId: source.id,
          status: 'FAILED',
          message,
        });
        errors.push({ sourceId: source.id, message });
        await appendRunEvent(db, {
          workspaceId: input.workspaceId,
          runId: input.runId,
          level: 'ERROR',
          eventType: 'SOURCE_RESOLVE_FAILED',
          message,
          payload: { sourceId: source.id, sourceRef: source.sourceRef },
        });
        continue;
      }

      let tempDir: string | null = null;
      try {
        checkGhAuth();
        tempDir = mkdtempSync(join(tmpdir(), 'archi-navi-infrun-repo-'));
        const repoName = basename(nwo.split('/')[1] ?? 'repo');
        const repoDir = join(tempDir, repoName);
        cloneGithubRepo(nwo, repoDir);
        await updateRunSource(db, {
          sourceId: source.id,
          status: 'RUNNING',
          resolvedRepoRoot: repoDir,
          message: null,
        });
        sourceResolvedRoots.set(source.id, repoDir);
        localSources.push({
          sourceId: source.id,
          repoRoot: repoDir,
          cleanupDir: tempDir,
        });
        await appendRunEvent(db, {
          workspaceId: input.workspaceId,
          runId: input.runId,
          eventType: 'SOURCE_RESOLVED',
          message: `githubRepo source를 local clone으로 해석했습니다: ${nwo}`,
          payload: { sourceId: source.id, sourceRef: source.sourceRef, repoRoot: repoDir },
        });
      } catch (error) {
        if (tempDir) {
          rmSync(tempDir, { recursive: true, force: true });
        }
        const errorMessage = error instanceof Error ? error.message : 'unknown github repo error';
        const message = `githubRepo source 준비 실패(${nwo}): ${errorMessage}`;
        await updateRunSource(db, {
          sourceId: source.id,
          status: 'FAILED',
          message,
        });
        errors.push({ sourceId: source.id, message });
        await appendRunEvent(db, {
          workspaceId: input.workspaceId,
          runId: input.runId,
          level: 'ERROR',
          eventType: 'SOURCE_RESOLVE_FAILED',
          message,
          payload: { sourceId: source.id, sourceRef: source.sourceRef },
        });
      }
      continue;
    }

    if (source.sourceType === 'githubOrg') {
      const org = source.sourceRef.trim();
      if (org.length === 0) {
        const message = 'githubOrg source가 비어 있습니다.';
        await updateRunSource(db, {
          sourceId: source.id,
          status: 'FAILED',
          message,
        });
        errors.push({ sourceId: source.id, message });
        continue;
      }

      try {
        checkGhAuth();
        const repos = listGithubOrgRepos(org);
        if (repos.length === 0) {
          const message = `githubOrg source에 스캔 가능한 레포가 없습니다: ${org}`;
          await updateRunSource(db, {
            sourceId: source.id,
            status: 'FAILED',
            message,
          });
          errors.push({ sourceId: source.id, message });
          continue;
        }

        const tempDir = mkdtempSync(join(tmpdir(), 'archi-navi-infrun-org-'));
        let clonedCount = 0;
        for (const repoName of repos) {
          const nwo = `${org}/${repoName}`;
          const repoDir = join(tempDir, repoName);
          try {
            cloneGithubRepo(nwo, repoDir);
            localSources.push({
              sourceId: source.id,
              repoRoot: repoDir,
              cleanupDir: tempDir,
            });
            clonedCount += 1;
          } catch (cloneError) {
            warnings.push(`[source:${org}] ${repoName} clone 실패: ${cloneError instanceof Error ? cloneError.message : 'unknown'}`);
          }
        }

        if (clonedCount === 0) {
          rmSync(tempDir, { recursive: true, force: true });
          const message = `githubOrg source clone이 모두 실패했습니다: ${org}`;
          await updateRunSource(db, {
            sourceId: source.id,
            status: 'FAILED',
            message,
          });
          errors.push({ sourceId: source.id, message });
          continue;
        }

        await updateRunSource(db, {
          sourceId: source.id,
          status: 'RUNNING',
          resolvedRepoRoot: tempDir,
          message: `${clonedCount}개 repo 준비됨`,
        });
        sourceResolvedRoots.set(source.id, tempDir);
        await appendRunEvent(db, {
          workspaceId: input.workspaceId,
          runId: input.runId,
          eventType: 'SOURCE_RESOLVED',
          message: `githubOrg source를 local clone으로 해석했습니다: ${org}`,
          payload: { sourceId: source.id, sourceRef: source.sourceRef, repoCount: clonedCount },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'unknown github org error';
        const message = `githubOrg source 준비 실패(${org}): ${errorMessage}`;
        await updateRunSource(db, {
          sourceId: source.id,
          status: 'FAILED',
          message,
        });
        errors.push({ sourceId: source.id, message });
        await appendRunEvent(db, {
          workspaceId: input.workspaceId,
          runId: input.runId,
          level: 'ERROR',
          eventType: 'SOURCE_RESOLVE_FAILED',
          message,
          payload: { sourceId: source.id, sourceRef: source.sourceRef },
        });
      }
      continue;
    }

    await updateRunSource(db, {
      sourceId: source.id,
      status: 'SKIPPED',
      message: `${source.sourceType} source는 아직 실행 오케스트레이션에 연결되지 않았습니다.`,
    });
    warnings.push(`${source.sourceType}:${source.sourceRef} source는 스킵되었습니다.`);
    await appendRunEvent(db, {
      workspaceId: input.workspaceId,
      runId: input.runId,
      level: 'WARN',
      eventType: 'SOURCE_SKIPPED',
      message: `${source.sourceType} source는 현재 미지원입니다.`,
      payload: { sourceId: source.id, sourceRef: source.sourceRef },
    });
  }

  return { localSources, warnings, errors, sourceResolvedRoots };
}

export async function executeInferenceRun(
  db: DbClient,
  input: ExecuteInferenceRunInput,
): Promise<InferenceRunDetail> {
  const runRows = await db
    .select()
    .from(inferenceRuns)
    .where(
      and(
        eq(inferenceRuns.id, input.runId),
        eq(inferenceRuns.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);

  const run = runRows[0];
  if (!run) {
    throw new Error(`Inference run을 찾을 수 없습니다: ${input.runId}`);
  }

  if (run.status !== 'QUEUED') {
    return await getInferenceRunDetail(db, {
      workspaceId: input.workspaceId,
      runId: input.runId,
    });
  }

  const claimedRows = await db
    .update(inferenceRuns)
    .set({
      status: 'RUNNING',
      attemptCount: run.attemptCount + 1,
      startedAt: new Date(),
      updatedAt: new Date(),
      errorMessage: null,
    })
    .where(
      and(
        eq(inferenceRuns.id, run.id),
        eq(inferenceRuns.workspaceId, input.workspaceId),
        eq(inferenceRuns.status, 'QUEUED'),
      ),
    )
    .returning({ id: inferenceRuns.id });

  if (claimedRows.length === 0) {
    return await getInferenceRunDetail(db, {
      workspaceId: input.workspaceId,
      runId: input.runId,
    });
  }

  await appendRunEvent(db, {
    workspaceId: input.workspaceId,
    runId: run.id,
    eventType: 'RUN_STARTED',
    message: 'Inference run 실행을 시작했습니다.',
  });

  const sources = await db
    .select({
      id: inferenceRunSources.id,
      sourceType: inferenceRunSources.sourceType,
      sourceRef: inferenceRunSources.sourceRef,
    })
    .from(inferenceRunSources)
    .where(
      and(
        eq(inferenceRunSources.workspaceId, input.workspaceId),
        eq(inferenceRunSources.runId, run.id),
      ),
    );

  const warnings: string[] = [];
  const errors: Array<{ mode: InferenceMode | 'source'; repoRoot?: string; message: string }> = [];
  const modeSet = new Set<InferenceMode>(
    Array.isArray(run.requestedModes)
      ? (run.requestedModes as string[]).filter(isInferenceMode)
      : ['config', 'db'],
  );

  const sourceResolution = await resolveRunnableSources(db, {
    workspaceId: input.workspaceId,
    runId: run.id,
    sources,
  });

  warnings.push(...sourceResolution.warnings);
  for (const sourceError of sourceResolution.errors) {
    errors.push({
      mode: 'source',
      message: sourceError.message,
    });
  }

  const configResult = {
    repoCount: 0,
    fileCount: 0,
    processedFileCount: 0,
    skippedFileCount: 0,
    aliasBindingCount: 0,
    routeTransformCount: 0,
    interactionIntentCount: 0,
    gatewayRouteSeedCount: 0,
  };
  const codeEngine = normalizeCodeSignalEngine(run.requestedCodeEngine);
  const codeResult = {
    repoCount: 0,
    fileCount: 0,
    artifactCount: 0,
    signalCount: 0,
    skippedCount: 0,
    aliasBindingCount: 0,
    functionSummaryCount: 0,
    interactionIntentCount: 0,
    engineRequested: codeEngine,
    enginesUsed: [] as string[],
    fallbackCount: 0,
    fallbackRepoRoots: [] as string[],
    scanFailures: [] as Array<{ filePath: string; reason: string; language: string }>,
  };
  let dbResult:
    | null
    | {
        tableCount: number;
        fkCandidateCount: number;
        implicitFkCandidateCount: number;
      } = null;
  let successfulCodeRepoCount = 0;
  const proofResolution = {
    intentCount: 0,
    closedAtomicCount: 0,
    frontierCount: 0,
    rejectedCount: 0,
  };
  const smartFrontierProofStateIds = new Set<string>();
  const requestedAgentPatches = readRequestedAgentPatchSettingsFromRunStats(run.stats);
  const requestedSmartProof = readRequestedSmartProofSettingsFromRunStats(run.stats);
  const frontierAgent = {
    enabled: requestedAgentPatches.enabled,
    maxFrontiers: requestedAgentPatches.maxFrontiers,
    attemptedFrontierCount: 0,
    proposalCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    noProposalCount: 0,
    skippedCount: 0,
  };
  const smartProof = {
    enabled: requestedSmartProof.enabled,
    attempted: false,
    attemptedFrontierCount: 0,
    attemptLimitReachedByIntent: false,
    budget: createSmartBudgetTracker({
      maxCalls: requestedSmartProof.budget.maxLlmCallsPerRun,
      maxTokens: requestedSmartProof.budget.maxTotalTokensPerRun,
    }),
    skippedReason: requestedSmartProof.enabled ? null as string | null : 'DISABLED',
  };

  if ((modeSet.has('config') || modeSet.has('code')) && sourceResolution.localSources.length === 0) {
    errors.push({
      mode: modeSet.has('config') ? 'config' : 'code',
      message: 'config/code 실행에 사용할 local source가 없습니다.',
    });
  }

  const cleanupDirs = Array.from(
    new Set(
      sourceResolution.localSources
        .map((source) => source.cleanupDir)
        .filter((dir): dir is string => typeof dir === 'string' && dir.length > 0),
    ),
  );

  let cleanedUp = false;
  const cleanupResolvedDirectories = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const sourceExecutionResult = new Map<string, boolean>();
  const flushSourceStatuses = async (markRemainingSkipped: boolean) => {
    for (const localSource of sourceResolution.localSources) {
      const hasError = sourceExecutionResult.get(localSource.sourceId);
      if (typeof hasError === 'boolean') {
        await updateRunSource(db, {
          sourceId: localSource.sourceId,
          status: hasError ? 'FAILED' : 'SUCCEEDED',
          resolvedRepoRoot: sourceResolution.sourceResolvedRoots.get(localSource.sourceId) ?? null,
          message: hasError ? '일부 mode 실행 실패' : '완료',
        });
        continue;
      }

      if (markRemainingSkipped) {
        await updateRunSource(db, {
          sourceId: localSource.sourceId,
          status: 'SKIPPED',
          resolvedRepoRoot: sourceResolution.sourceResolvedRoots.get(localSource.sourceId) ?? null,
          message: '실행 중 취소되어 남은 source를 스킵했습니다.',
        });
      }
    }
  };

  const returnCurrentRunDetail = async (markRemainingSkipped: boolean) => {
    await flushSourceStatuses(markRemainingSkipped);
    cleanupResolvedDirectories();
    return await getInferenceRunDetail(db, {
      workspaceId: input.workspaceId,
      runId: run.id,
    });
  };

  const isRunCanceled = async () =>
    (await getInferenceRunStatus(db, { workspaceId: input.workspaceId, runId: run.id })) === 'CANCELED';

  const deletedRouteTransformOwnerServiceIdsForRun = new Set<string>();
  let didDeleteGlobalRouteTransformForRun = false;
  const resolveWorkspaceProofsForRun = async () => {
    const impactedIntentIds = await collectImpactedIntentIdsForRun(db, {
      workspaceId: input.workspaceId,
      runId: run.id,
      incremental: run.requestedIncremental,
      deletedRouteTransformOwnerServiceIds: [...deletedRouteTransformOwnerServiceIdsForRun],
      didDeleteGlobalRouteTransform: didDeleteGlobalRouteTransformForRun,
    });

    if (impactedIntentIds.length === 0) {
      return;
    }

    let resolverContext = await buildIntentProofResolverContext(db, { workspaceId: input.workspaceId });

    for (const intentId of impactedIntentIds) {
      let resolution = await resolveInteractionIntentProof(db, {
        workspaceId: input.workspaceId,
        intentId,
        resolverContext,
      });
      if (resolution.status === 'FRONTIER') {
        if (!frontierAgent.enabled) {
          frontierAgent.skippedCount += 1;
          await appendRunEvent(db, {
            workspaceId: input.workspaceId,
            runId: run.id,
            eventType: 'FRONTIER_AGENT_PATCH',
            message: 'frontier agent patch를 스킵했습니다: agent disabled',
            payload: {
              intentId,
              proofStateId: resolution.proofStateId,
              frontierReason: resolution.frontierReason,
              outcome: 'disabled',
            },
          });
        } else if (frontierAgent.attemptedFrontierCount >= frontierAgent.maxFrontiers) {
          frontierAgent.skippedCount += 1;
          await appendRunEvent(db, {
            workspaceId: input.workspaceId,
            runId: run.id,
            eventType: 'FRONTIER_AGENT_PATCH',
            message: 'frontier agent patch를 스킵했습니다: frontier limit reached',
            payload: {
              intentId,
              proofStateId: resolution.proofStateId,
              frontierReason: resolution.frontierReason,
              outcome: 'limit_exceeded',
              maxFrontiers: frontierAgent.maxFrontiers,
            },
          });
        } else {
          frontierAgent.attemptedFrontierCount += 1;
          const agentResult = await runFrontierAgentPass(db, {
            workspaceId: input.workspaceId,
            proofStateId: resolution.proofStateId,
            runId: run.id,
          });
          if (agentResult.proposal) {
            frontierAgent.proposalCount += 1;
            if (agentResult.validationStatus === 'ACCEPTED') {
              frontierAgent.acceptedCount += 1;
              if (agentResult.proposal.patchType === 'route_transform_patch') {
                resolverContext = await buildIntentProofResolverContext(db, { workspaceId: input.workspaceId });
              }
            } else if (agentResult.validationStatus === 'REJECTED') {
              frontierAgent.rejectedCount += 1;
            }
            await appendRunEvent(db, {
              workspaceId: input.workspaceId,
              runId: run.id,
              level: agentResult.validationStatus === 'REJECTED' ? 'WARN' : 'INFO',
              eventType: 'FRONTIER_AGENT_PATCH',
              message:
                agentResult.validationStatus === 'REJECTED'
                  ? `frontier agent patch가 거절되었습니다: ${agentResult.proposal.patchType}`
                  : `frontier agent patch를 적용했습니다: ${agentResult.proposal.patchType}`,
              payload: {
                intentId,
                proofStateId: resolution.proofStateId,
                frontierReason: agentResult.frontierReason,
                patchType: agentResult.proposal.patchType,
                validationStatus: agentResult.validationStatus,
                rationale: agentResult.proposal.rationale,
                errors: agentResult.errors,
              },
            });
          } else {
            frontierAgent.noProposalCount += 1;
            await appendRunEvent(db, {
              workspaceId: input.workspaceId,
              runId: run.id,
              eventType: 'FRONTIER_AGENT_PATCH',
              message: 'frontier agent patch proposal이 없어 frontier를 유지했습니다.',
              payload: {
                intentId,
                proofStateId: resolution.proofStateId,
                frontierReason: agentResult.frontierReason,
                outcome: 'no_proposal',
              },
            });
          }
          if (agentResult.resolution) {
            resolution = agentResult.resolution;
          }
        }
      }

      await db
        .update(interactionIntents)
        .set({
          updatedRunId: run.id,
          updatedAt: new Date(),
        })
        .where(eq(interactionIntents.id, intentId));

      proofResolution.intentCount += 1;
      if (resolution.status === 'CLOSED_ATOMIC') {
        proofResolution.closedAtomicCount += 1;
        continue;
      }
      if (resolution.status === 'FRONTIER') {
        proofResolution.frontierCount += 1;
        smartFrontierProofStateIds.add(resolution.proofStateId);
        continue;
      }
      if (resolution.status === 'REJECTED') {
        proofResolution.rejectedCount += 1;
      }
    }
  };

  const runSmartProofPass = async () => {
    if (!requestedSmartProof.enabled) {
      await appendRunEvent(db, {
        workspaceId: input.workspaceId,
        runId: run.id,
        eventType: 'SMART_PROOF_PASS',
        message: 'smart proof pass를 스킵했습니다: disabled',
        payload: {
          enabled: false,
          outcome: 'disabled',
          budget: smartProof.budget,
        },
      });
      return;
    }

    smartProof.attempted = true;

    if (proofResolution.frontierCount === 0) {
      smartProof.skippedReason = 'NO_FRONTIERS';
      await appendRunEvent(db, {
        workspaceId: input.workspaceId,
        runId: run.id,
        eventType: 'SMART_PROOF_PASS',
        message: 'smart proof pass를 스킵했습니다: frontier 없음',
        payload: {
          enabled: true,
          outcome: 'no_frontiers',
          budget: smartProof.budget,
        },
      });
      return;
    }

    smartProof.attemptedFrontierCount = proofResolution.frontierCount;
    if (!input.smartGenerateFn) {
      smartProof.skippedReason = 'NO_GENERATOR_CONFIGURED';
      await appendRunEvent(db, {
        workspaceId: input.workspaceId,
        runId: run.id,
        eventType: 'SMART_PROOF_PASS',
        message: 'smart proof pass를 스킵했습니다: generator 미구성',
        payload: {
          enabled: true,
          outcome: 'no_generator',
          attemptedFrontierCount: smartProof.attemptedFrontierCount,
          budget: smartProof.budget,
        },
      });
      return;
    }
    if (isSmartBudgetExhausted(smartProof.budget)) {
      smartProof.skippedReason = 'BUDGET_EXHAUSTED';
      await appendRunEvent(db, {
        workspaceId: input.workspaceId,
        runId: run.id,
        eventType: 'SMART_PROOF_PASS',
        level: 'WARN',
        message: 'smart proof pass를 스킵했습니다: budget exhausted',
        payload: {
          enabled: true,
          outcome: 'budget_exhausted',
          attemptedFrontierCount: smartProof.attemptedFrontierCount,
          budget: smartProof.budget,
        },
      });
      return;
    }

    const frontierStateIds = Array.from(smartFrontierProofStateIds);
    if (frontierStateIds.length === 0) {
      smartProof.skippedReason = 'NO_SUPPORTED_FRONTIERS';
      await appendRunEvent(db, {
        workspaceId: input.workspaceId,
        runId: run.id,
        eventType: 'SMART_PROOF_PASS',
        message: 'smart proof pass를 스킵했습니다: 현재 run에 지원 frontier 없음',
        payload: {
          enabled: true,
          outcome: 'no_supported_frontiers',
          attemptedFrontierCount: smartProof.attemptedFrontierCount,
          budget: smartProof.budget,
        },
      });
      return;
    }

    const frontierRows = await db
      .select({
        proofStateId: proofFrontiers.proofStateId,
        frontierReason: proofFrontiers.frontierReason,
      })
      .from(proofFrontiers)
      .where(
        and(
          eq(proofFrontiers.workspaceId, input.workspaceId),
          inArray(proofFrontiers.proofStateId, frontierStateIds),
        ),
      );

    const frontierStateIntents = frontierStateIds.length > 0
      ? await db
        .select({
          proofStateId: proofStates.id,
          intentId: proofStates.intentId,
        })
        .from(proofStates)
        .where(
          and(
            eq(proofStates.workspaceId, input.workspaceId),
            inArray(proofStates.id, frontierStateIds),
          ),
        )
      : [];
    const intentCallCountByProofState = new Map<string, number>(
      frontierStateIntents.map((row) => [row.proofStateId, 0]),
    );
    const proofStateToIntentId = new Map<string, string>(
      frontierStateIntents.map((row) => [row.proofStateId, row.intentId]),
    );
    const intentCallCountByIntent = new Map<string, number>();

    let attemptedResolvers = 0;
    let unsupportedCount = 0;
    let budgetExhausted = false;
    for (const frontierRow of frontierRows) {
      if (!frontierRow.proofStateId) continue;
      if (isSmartBudgetExhausted(smartProof.budget)) {
        budgetExhausted = true;
        break;
      }
      const intentId = proofStateToIntentId.get(frontierRow.proofStateId);
      const currentIntentCalls = typeof intentId === 'string'
        ? intentCallCountByIntent.get(intentId) ?? 0
        : 0;
      if (typeof intentId === 'string' && currentIntentCalls >= requestedSmartProof.budget.maxLlmCallsPerIntent) {
        smartProof.attemptLimitReachedByIntent = true;
        continue;
      }
      if (!canAffordSmartBudgetCall(smartProof.budget, requestedSmartProof.budget.maxInputTokensPerCall)) {
        budgetExhausted = true;
        break;
      }
      const result = await resolveSmartFrontier(db, {
        workspaceId: input.workspaceId,
        proofStateId: frontierRow.proofStateId,
        runId: run.id,
        config: requestedSmartProof,
        generateFn: input.smartGenerateFn,
      });
      if (!result.attempted && result.frontierReason === 'UNSUPPORTED') {
        unsupportedCount += 1;
        continue;
      }
      attemptedResolvers += 1;
      if (typeof intentId === 'string') {
        const nextIntentCount = currentIntentCalls + 1;
        intentCallCountByIntent.set(intentId, nextIntentCount);
        intentCallCountByProofState.set(frontierRow.proofStateId, nextIntentCount);
      } else {
        const prev = intentCallCountByProofState.get(frontierRow.proofStateId) ?? 0;
        intentCallCountByProofState.set(frontierRow.proofStateId, prev + 1);
      }
      smartProof.budget = recordSmartBudgetCall(smartProof.budget, {
        inputTokens: result.tokensUsed.input,
        outputTokens: result.tokensUsed.output,
      });
      if (isSmartBudgetExhausted(smartProof.budget)) {
        budgetExhausted = true;
        break;
      }
    }

    if (attemptedResolvers === 0) {
      smartProof.skippedReason = budgetExhausted || isSmartBudgetExhausted(smartProof.budget)
        ? 'BUDGET_EXHAUSTED'
        : 'NO_SUPPORTED_FRONTIERS';
    } else {
      smartProof.skippedReason = budgetExhausted ? 'BUDGET_EXHAUSTED' : null;
    }
    await appendRunEvent(db, {
      workspaceId: input.workspaceId,
      runId: run.id,
      eventType: 'SMART_PROOF_PASS',
      level: budgetExhausted ? 'WARN' : 'INFO',
      message: budgetExhausted
        ? 'smart proof frontier resolver를 budget 한도까지 실행했습니다.'
        : attemptedResolvers > 0
          ? 'smart proof frontier resolver를 실행했습니다.'
          : 'smart proof pass를 스킵했습니다: 지원 frontier 없음',
      payload: {
        enabled: true,
        outcome: budgetExhausted
          ? 'budget_exhausted'
          : attemptedResolvers > 0
            ? 'resolver_attempted'
            : 'no_supported_frontiers',
        attemptedFrontierCount: smartProof.attemptedFrontierCount,
        attemptedResolverCount: attemptedResolvers,
        unsupportedCount,
        attemptLimitReachedByIntent: smartProof.attemptLimitReachedByIntent,
        categories: requestedSmartProof.categories,
        budget: smartProof.budget,
      },
    });
  };

  if (await isRunCanceled()) {
    return await returnCurrentRunDetail(true);
  }

  for (const localSource of sourceResolution.localSources) {
    let sourceHasError = false;

    if (modeSet.has('config')) {
      try {
        const configFileCounts = countConfigFiles(localSource.repoRoot);
        const aliasResult = await extractAliasBindingsFromConfig(db, {
          workspaceId: input.workspaceId,
          repoRoot: localSource.repoRoot,
          runId: run.id,
        });
        const routeTransformResult = await extractRouteTransformsFromConfig(db, {
          workspaceId: input.workspaceId,
          repoRoot: localSource.repoRoot,
          runId: run.id,
        });
        for (const ownerServiceId of routeTransformResult.deletedOwnerServiceIds) {
          deletedRouteTransformOwnerServiceIdsForRun.add(ownerServiceId);
        }
        if (routeTransformResult.deletedGlobalTransformCount > 0) {
          didDeleteGlobalRouteTransformForRun = true;
        }
        const configIntentResult = await extractInteractionIntentsFromConfigRoutes(db, {
          workspaceId: input.workspaceId,
          repoRoot: localSource.repoRoot,
          runId: run.id,
        });
        configResult.repoCount += 1;
        configResult.fileCount += configFileCounts.fileCount;
        configResult.processedFileCount += configFileCounts.processedFileCount;
        configResult.skippedFileCount += configFileCounts.skippedFileCount;
        configResult.aliasBindingCount += aliasResult.bindingCount;
        configResult.routeTransformCount += routeTransformResult.routeTransformCount;
        configResult.interactionIntentCount += configIntentResult.intentCount;
        configResult.gatewayRouteSeedCount += configIntentResult.gatewayRouteSeedCount ?? 0;
      } catch (error) {
        sourceHasError = true;
        errors.push({
          mode: 'config',
          repoRoot: localSource.repoRoot,
          message: error instanceof Error ? error.message : 'unknown config error',
        });
      }
    }

    if (await isRunCanceled()) {
      return await returnCurrentRunDetail(true);
    }

    if (modeSet.has('code')) {
      try {
        const result = await extractCodeSignalsWithEngine(db, {
          workspaceId: input.workspaceId,
          repoRoot: localSource.repoRoot,
          codeEngine,
          forceRescan: run.requestedIncremental ? false : true,
        });
        const functionSummaryResult = await extractFunctionSummariesFromCodeSignals(db, {
          workspaceId: input.workspaceId,
          repoRoot: localSource.repoRoot,
          runId: run.id,
        });
        const aliasResult = await extractAliasBindingsFromCodeSignals(db, {
          workspaceId: input.workspaceId,
          repoRoot: localSource.repoRoot,
          runId: run.id,
        });
        const intentResult = await extractInteractionIntentsFromCodeSignals(db, {
          workspaceId: input.workspaceId,
          repoRoot: localSource.repoRoot,
          runId: run.id,
        });
        codeResult.repoCount += 1;
        codeResult.fileCount += result.fileCount;
        codeResult.artifactCount += result.artifactCount;
        codeResult.signalCount += result.signalCount;
        codeResult.skippedCount += result.skippedCount;
        codeResult.aliasBindingCount += aliasResult.bindingCount;
        codeResult.functionSummaryCount += functionSummaryResult.summaryCount;
        codeResult.interactionIntentCount += intentResult.intentCount;
        if (!codeResult.enginesUsed.includes(result.engineUsed)) {
          codeResult.enginesUsed.push(result.engineUsed);
        }
        if (result.fallbackUsed) {
          codeResult.fallbackCount += 1;
          codeResult.fallbackRepoRoots.push(localSource.repoRoot);
        }
        if (result.warning) warnings.push(`[code:${localSource.repoRoot}] ${result.warning}`);
        if (result.scanFailures && result.scanFailures.length > 0) {
          codeResult.scanFailures.push(...result.scanFailures);
        }
        successfulCodeRepoCount += 1;
      } catch (error) {
        sourceHasError = true;
        errors.push({
          mode: 'code',
          repoRoot: localSource.repoRoot,
          message: error instanceof Error ? error.message : 'unknown code error',
        });
      }
    }

    if (await isRunCanceled()) {
      return await returnCurrentRunDetail(true);
    }

    sourceExecutionResult.set(localSource.sourceId, sourceHasError);
  }

  await flushSourceStatuses(false);

  if (await isRunCanceled()) {
    return await returnCurrentRunDetail(true);
  }

  if (modeSet.has('db')) {
    try {
      dbResult = await extractDbSchemaSignals(db, {
        workspaceId: input.workspaceId,
        incremental: run.requestedIncremental,
      });
    } catch (error) {
      errors.push({
        mode: 'db',
        message: error instanceof Error ? error.message : 'unknown db error',
      });
    }
  }

  if (await isRunCanceled()) {
    return await returnCurrentRunDetail(true);
  }

  const allSelectedModesSucceeded = didAllSelectedModesSucceed({
    modeSet,
    expectedLocalSourceCount: sourceResolution.localSources.length,
    successfulConfigRepoCount: configResult.repoCount,
    successfulCodeRepoCount,
    dbSucceeded: dbResult !== null,
  });
  if (await isRunCanceled()) {
    return await returnCurrentRunDetail(true);
  }

  if ((modeSet.has('config') || modeSet.has('code') || modeSet.has('db')) && allSelectedModesSucceeded) {
    try {
      await resolveWorkspaceProofsForRun();
    } catch (error) {
      warnings.push(
        `intent proof resolution 실패: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  if (await isRunCanceled()) {
    return await returnCurrentRunDetail(true);
  }

  try {
    await runSmartProofPass();
  } catch (error) {
    warnings.push(
      `smart proof pass 실패: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }

  if (await isRunCanceled()) {
    return await returnCurrentRunDetail(true);
  }

  const hasAnySuccess =
    configResult.repoCount > 0 || successfulCodeRepoCount > 0 || dbResult !== null || proofResolution.intentCount > 0;
  const proofSummary = await buildProofEngineSummaryForRun(db, {
    workspaceId: input.workspaceId,
    runId: run.id,
  });
  const relationCandidatesCreated = Math.max(
    proofSummary.projectedCandidateCount - proofSummary.serviceTargetProjectionCount,
    0,
  );
  const artifactFailedChecks = [
    ...warnings,
    ...errors.map((entry) => {
      const mode = typeof entry.mode === 'string' && entry.mode.length > 0 ? `[${entry.mode}] ` : '';
      return `${mode}${entry.message}`;
    }),
  ];
  let cutoverArtifact = null;
  try {
    cutoverArtifact = await buildIntentProofCutoverArtifact(db, {
      workspaceId: input.workspaceId,
      label: `run:${run.id}`,
      failedChecks: artifactFailedChecks,
    });
  } catch (error) {
    warnings.push(
      `cutover artifact 생성 실패: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }

  const finalStatus: InferenceRunStatus =
    !hasAnySuccess && errors.length > 0 ? 'FAILED' : 'SUCCEEDED';
  const errorMessage = errors[0]?.message ?? null;
  const stats = {
    engine: proofSummary.engine,
    requestedAgentPatches,
    requestedSmartProof,
    smartProof,
    proofSummary,
    config: configResult,
    code: codeResult,
    db: dbResult,
    proofResolution,
    frontierAgent,
    summary: {
      relationCandidatesCreated,
      executionMode: Array.from(modeSet),
    },
    ...(cutoverArtifact ? { cutoverArtifact } : {}),
  };

  const finalizedRows = await db
    .update(inferenceRuns)
    .set({
      status: finalStatus,
      stats,
      warnings,
      errors,
      errorMessage,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(inferenceRuns.id, run.id),
        eq(inferenceRuns.workspaceId, input.workspaceId),
        eq(inferenceRuns.status, 'RUNNING'),
      ),
    )
    .returning({ id: inferenceRuns.id });

  if (finalizedRows.length === 0) {
    return await returnCurrentRunDetail(await isRunCanceled());
  }

  await appendRunEvent(db, {
    workspaceId: input.workspaceId,
    runId: run.id,
    level: finalStatus === 'FAILED' ? 'ERROR' : 'INFO',
    eventType: 'RUN_COMPLETED',
    message:
      finalStatus === 'FAILED'
        ? 'Inference run이 실패로 종료되었습니다.'
        : 'Inference run이 성공으로 종료되었습니다.',
    payload: {
      status: finalStatus,
      warningCount: warnings.length,
      errorCount: errors.length,
      relationCandidatesCreated,
    },
  });

  cleanupResolvedDirectories();

  return await getInferenceRunDetail(db, {
    workspaceId: input.workspaceId,
    runId: run.id,
  });
}

export async function listInferenceRuns(
  db: DbClient,
  input: {
    workspaceId: string;
    status?: string;
    limit?: number;
  },
): Promise<InferenceRunListItem[]> {
  const effectiveLimit = Math.min(100, Math.max(1, input.limit ?? 20));
  if (input.status) {
    return await db
      .select()
      .from(inferenceRuns)
      .where(
        and(
          eq(inferenceRuns.workspaceId, input.workspaceId),
          eq(inferenceRuns.status, input.status.toUpperCase()),
        ),
      )
      .orderBy(desc(inferenceRuns.createdAt))
      .limit(effectiveLimit);
  }
  return await db
    .select()
    .from(inferenceRuns)
    .where(eq(inferenceRuns.workspaceId, input.workspaceId))
    .orderBy(desc(inferenceRuns.createdAt))
    .limit(effectiveLimit);
}

export async function getInferenceRunDetail(
  db: DbClient,
  input: { workspaceId: string; runId: string },
): Promise<InferenceRunDetail> {
  const runRows = await db
    .select()
    .from(inferenceRuns)
    .where(
      and(
        eq(inferenceRuns.workspaceId, input.workspaceId),
        eq(inferenceRuns.id, input.runId),
      ),
    )
    .limit(1);

  const run = runRows[0];
  if (!run) throw new Error(`Inference run을 찾을 수 없습니다: ${input.runId}`);

  const sources = await db
    .select({
      id: inferenceRunSources.id,
      sourceType: inferenceRunSources.sourceType,
      sourceRef: inferenceRunSources.sourceRef,
      resolvedRepoRoot: inferenceRunSources.resolvedRepoRoot,
      status: inferenceRunSources.status,
      message: inferenceRunSources.message,
      metadata: inferenceRunSources.metadata,
      createdAt: inferenceRunSources.createdAt,
      updatedAt: inferenceRunSources.updatedAt,
    })
    .from(inferenceRunSources)
    .where(
      and(
        eq(inferenceRunSources.workspaceId, input.workspaceId),
        eq(inferenceRunSources.runId, input.runId),
      ),
    )
    .orderBy(desc(inferenceRunSources.createdAt));

  const events = await db
    .select({
      id: inferenceRunEvents.id,
      level: inferenceRunEvents.level,
      eventType: inferenceRunEvents.eventType,
      message: inferenceRunEvents.message,
      payload: inferenceRunEvents.payload,
      createdAt: inferenceRunEvents.createdAt,
    })
    .from(inferenceRunEvents)
    .where(
      and(
        eq(inferenceRunEvents.workspaceId, input.workspaceId),
        eq(inferenceRunEvents.runId, input.runId),
      ),
    )
    .orderBy(desc(inferenceRunEvents.createdAt));

  return { run, sources, events };
}

export function normalizeInferenceRunModes(input?: string[]): InferenceMode[] {
  return normalizeModes(input);
}

/**
 * 실행 중인 inference run을 취소한다.
 * QUEUED 또는 RUNNING 상태일 때만 취소 가능.
 */
export async function cancelInferenceRun(
  db: DbClient,
  input: { workspaceId: string; runId: string },
): Promise<{ canceled: boolean; status: string }> {
  const runRows = await db
    .select({ id: inferenceRuns.id, status: inferenceRuns.status })
    .from(inferenceRuns)
    .where(
      and(
        eq(inferenceRuns.id, input.runId),
        eq(inferenceRuns.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);

  const run = runRows[0];
  if (!run) {
    throw new Error(`Inference run을 찾을 수 없습니다: ${input.runId}`);
  }

  if (run.status !== 'QUEUED' && run.status !== 'RUNNING') {
    return { canceled: false, status: run.status };
  }

  const updated = await db
    .update(inferenceRuns)
    .set({
      status: 'CANCELED',
      finishedAt: new Date(),
      updatedAt: new Date(),
      errorMessage: '사용자에 의해 취소됨',
    })
    .where(
      and(
        eq(inferenceRuns.id, run.id),
        eq(inferenceRuns.workspaceId, input.workspaceId),
        inArray(inferenceRuns.status, ['QUEUED', 'RUNNING']),
      ),
    )
    .returning({ id: inferenceRuns.id });

  if (updated.length === 0) {
    // 이미 상태가 변경됨 (race condition)
    const refreshed = await db
      .select({ status: inferenceRuns.status })
      .from(inferenceRuns)
      .where(eq(inferenceRuns.id, run.id))
      .limit(1);
    return { canceled: false, status: refreshed[0]?.status ?? 'UNKNOWN' };
  }

  await appendRunEvent(db, {
    workspaceId: input.workspaceId,
    runId: run.id,
    level: 'WARN',
    eventType: 'RUN_CANCELED',
    message: '사용자에 의해 실행이 취소되었습니다.',
  });

  return { canceled: true, status: 'CANCELED' };
}

/**
 * 실패한 inference run을 재시도한다.
 * FAILED 상태이고 attemptCount < maxAttempts인 경우만 재시도 가능.
 * 새 run을 만드는 대신, 동일 run의 상태를 QUEUED로 되돌린다.
 */
export async function retryInferenceRun(
  db: DbClient,
  input: { workspaceId: string; runId: string },
): Promise<{ retried: boolean; status: string; reason?: string }> {
  const runRows = await db
    .select()
    .from(inferenceRuns)
    .where(
      and(
        eq(inferenceRuns.id, input.runId),
        eq(inferenceRuns.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);

  const run = runRows[0];
  if (!run) {
    throw new Error(`Inference run을 찾을 수 없습니다: ${input.runId}`);
  }

  if (run.status !== 'FAILED') {
    return { retried: false, status: run.status, reason: `현재 상태(${run.status})에서는 재시도할 수 없습니다.` };
  }

  if (run.attemptCount >= run.maxAttempts) {
    return { retried: false, status: run.status, reason: `최대 시도 횟수(${run.maxAttempts})에 도달했습니다.` };
  }

  const updated = await db
    .update(inferenceRuns)
    .set({
      status: 'QUEUED',
      errorMessage: null,
      finishedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(inferenceRuns.id, run.id),
        eq(inferenceRuns.workspaceId, input.workspaceId),
        eq(inferenceRuns.status, 'FAILED'),
      ),
    )
    .returning({ id: inferenceRuns.id });

  if (updated.length === 0) {
    const refreshed = await db
      .select({ status: inferenceRuns.status })
      .from(inferenceRuns)
      .where(
        and(
          eq(inferenceRuns.id, run.id),
          eq(inferenceRuns.workspaceId, input.workspaceId),
        ),
      )
      .limit(1);

    return {
      retried: false,
      status: refreshed[0]?.status ?? 'UNKNOWN',
      reason: '상태가 변경되어 재시도 예약에 실패했습니다.',
    };
  }

  await appendRunEvent(db, {
    workspaceId: input.workspaceId,
    runId: run.id,
    eventType: 'RUN_RETRIED',
    message: `재시도가 예약되었습니다 (시도 ${run.attemptCount + 1}/${run.maxAttempts}).`,
    payload: { attemptCount: run.attemptCount, maxAttempts: run.maxAttempts },
  });

  return { retried: true, status: 'QUEUED' };
}
