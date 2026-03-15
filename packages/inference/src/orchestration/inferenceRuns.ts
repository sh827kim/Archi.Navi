import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
  inferenceRunEvents,
  inferenceRuns,
  inferenceRunSources,
} from '@archi-navi/db';
import {
  extractCodeSignalsWithEngine,
  normalizeCodeSignalEngine,
  type CodeSignalEngine,
} from '../code/codeSignalEngine';
import { extractDbSchemaSignals } from '../db/dbSchemaSignal';
import { inferRelationsFromConfig } from '../relation/configBased';
import { inferRelationsFromCodeSignals } from '../relation/codeBased';

export type InferenceMode = 'config' | 'code' | 'db';
export type InferenceSourceType = 'local' | 'githubRepo' | 'githubOrg';
export type InferenceRunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';

const ALL_MODES: InferenceMode[] = ['config', 'code', 'db'];

function isInferenceMode(value: string): value is InferenceMode {
  return value === 'config' || value === 'code' || value === 'db';
}

function isInferenceSourceType(value: string): value is InferenceSourceType {
  return value === 'local' || value === 'githubRepo' || value === 'githubOrg';
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
  triggerType?: string;
  maxAttempts?: number;
  idempotencyKey?: string | null;
  sources?: InferenceRunSourceInput[];
}

export interface ExecuteInferenceRunInput {
  workspaceId: string;
  runId: string;
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
      stats: {},
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
    candidateCount: 0,
    objectCount: 0,
  };
  const codeEngine = normalizeCodeSignalEngine(run.requestedCodeEngine);
  const codeResult = {
    repoCount: 0,
    fileCount: 0,
    artifactCount: 0,
    signalCount: 0,
    skippedCount: 0,
    candidateCount: 0,
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

  if ((modeSet.has('config') || modeSet.has('code')) && sourceResolution.localSources.length === 0) {
    errors.push({
      mode: modeSet.has('config') ? 'config' : 'code',
      message: 'config/code 실행에 사용할 local source가 없습니다.',
    });
  }

  const sourceErrorMap = new Map<string, boolean>();
  for (const localSource of sourceResolution.localSources) {
    if (!sourceErrorMap.has(localSource.sourceId)) {
      sourceErrorMap.set(localSource.sourceId, false);
    }
  }

  const cleanupDirs = Array.from(
    new Set(
      sourceResolution.localSources
        .map((source) => source.cleanupDir)
        .filter((dir): dir is string => typeof dir === 'string' && dir.length > 0),
    ),
  );

  for (const localSource of sourceResolution.localSources) {
    let sourceHasError = false;

    if (modeSet.has('config')) {
      try {
        const result = await inferRelationsFromConfig(db, {
          workspaceId: input.workspaceId,
          repoRoot: localSource.repoRoot,
          incremental: run.requestedIncremental,
        });
        configResult.repoCount += 1;
        configResult.fileCount += result.fileCount;
        configResult.processedFileCount += result.processedFileCount;
        configResult.skippedFileCount += result.skippedFileCount;
        configResult.candidateCount += result.candidateCount;
        configResult.objectCount += result.objectCount;
      } catch (error) {
        sourceHasError = true;
        errors.push({
          mode: 'config',
          repoRoot: localSource.repoRoot,
          message: error instanceof Error ? error.message : 'unknown config error',
        });
      }
    }

    if (modeSet.has('code')) {
      try {
        const result = await extractCodeSignalsWithEngine(db, {
          workspaceId: input.workspaceId,
          repoRoot: localSource.repoRoot,
          codeEngine,
          forceRescan: run.requestedIncremental ? false : true,
        });
        codeResult.repoCount += 1;
        codeResult.fileCount += result.fileCount;
        codeResult.artifactCount += result.artifactCount;
        codeResult.signalCount += result.signalCount;
        codeResult.skippedCount += result.skippedCount;
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

        const codeCand = await inferRelationsFromCodeSignals(db, {
          workspaceId: input.workspaceId,
          repoRoot: localSource.repoRoot,
        });
        codeResult.candidateCount += codeCand.candidateCount;
      } catch (error) {
        sourceHasError = true;
        errors.push({
          mode: 'code',
          repoRoot: localSource.repoRoot,
          message: error instanceof Error ? error.message : 'unknown code error',
        });
      }
    }

    sourceErrorMap.set(localSource.sourceId, (sourceErrorMap.get(localSource.sourceId) ?? false) || sourceHasError);
  }

  for (const [sourceId, hasError] of sourceErrorMap) {
    await updateRunSource(db, {
      sourceId,
      status: hasError ? 'FAILED' : 'SUCCEEDED',
      resolvedRepoRoot: sourceResolution.sourceResolvedRoots.get(sourceId) ?? null,
      message: hasError ? '일부 mode 실행 실패' : '완료',
    });
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

  const dbCandidateCount =
    (dbResult?.fkCandidateCount ?? 0) + (dbResult?.implicitFkCandidateCount ?? 0);
  const relationCandidatesCreated =
    configResult.candidateCount + dbCandidateCount + codeResult.candidateCount;
  const hasAnySuccess =
    configResult.repoCount > 0 || codeResult.repoCount > 0 || dbResult !== null;

  const finalStatus: InferenceRunStatus =
    !hasAnySuccess && errors.length > 0 ? 'FAILED' : 'SUCCEEDED';
  const errorMessage = errors[0]?.message ?? null;
  const stats = {
    config: configResult,
    code: codeResult,
    db: dbResult,
    summary: {
      relationCandidatesCreated,
      executionMode: Array.from(modeSet),
    },
  };

  await db
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
    .where(eq(inferenceRuns.id, run.id));

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

  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }

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
