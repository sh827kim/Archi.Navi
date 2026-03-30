/**
 * POST /api/inference/run — 관계 추론 실행 오케스트레이션
 * - config: 설정 파일 기반 relation_candidates 생성
 * - code: 코드 신호 추출(code_artifacts, code_call_edges, evidences)
 * - db: db_table metadata 기반 fk_reference 후보 생성
 */
import { type NextRequest, NextResponse } from 'next/server';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { and, eq } from 'drizzle-orm';
import { getDb, objects } from '@archi-navi/db';
import {
  inferRelationsFromConfig,
  inferRelationsFromCodeSignals,
  bindConfigToCodeEndpoints,
  crossValidatePendingRelationCandidates,
  extractCodeSignalsWithEngine,
  extractDbSchemaSignals,
  generateBoostCandidates,
  normalizeCodeSignalEngine,
  type CodeSignalEngine,
  type CodeSignalEngineUsed,
  type ConfigCodeBindingResult,
} from '@archi-navi/inference';
import {
  createGenerateBoostSuggestionFn,
  getInferenceModel,
  resolveMaxCalls,
} from '@/lib/inference-llm';

type InferenceMode = 'config' | 'code' | 'db';

interface RunInferenceRequest {
  workspaceId?: string;
  modes?: string[];
  repoRoots?: string[];
  useServiceMetadataPaths?: boolean;
  incremental?: boolean;
  codeEngine?: string;
  codeOptions?: {
    interProcedural?: boolean;
    maxCallChainDepth?: number;
    resolveProperties?: boolean;
  };
  llmBoost?: {
    enabled?: boolean;
    codeIntentAnalysis?: boolean;
    generateExplanations?: boolean;
    maxCalls?: number;
  };
}

type RepoRootSource = 'provided' | 'serviceMetadata';

const ALL_MODES: InferenceMode[] = ['config', 'code', 'db'];

function isInferenceMode(value: string): value is InferenceMode {
  return value === 'config' || value === 'code' || value === 'db';
}

function didAllSelectedModesSucceed(input: {
  modeSet: ReadonlySet<InferenceMode>;
  expectedRepoRootCount: number;
  successfulConfigRepoCount: number;
  successfulCodeRelationRepoCount: number;
  dbSucceeded: boolean;
}): boolean {
  const selectedConfigAndCodeModesSucceeded = didSelectedConfigAndCodeModesSucceed({
    modeSet: input.modeSet,
    expectedRepoRootCount: input.expectedRepoRootCount,
    successfulConfigRepoCount: input.successfulConfigRepoCount,
    successfulCodeRelationRepoCount: input.successfulCodeRelationRepoCount,
  });
  const selectedDbModeSucceeded = !input.modeSet.has('db') || input.dbSucceeded;

  return selectedConfigAndCodeModesSucceeded && selectedDbModeSucceeded;
}

function didSelectedConfigAndCodeModesSucceed(input: {
  modeSet: ReadonlySet<InferenceMode>;
  expectedRepoRootCount: number;
  successfulConfigRepoCount: number;
  successfulCodeRelationRepoCount: number;
}): boolean {
  const allSelectedCodeRootsSucceeded =
    !input.modeSet.has('code')
    || (
      input.expectedRepoRootCount > 0
      && input.successfulCodeRelationRepoCount === input.expectedRepoRootCount
    );
  const allSelectedConfigRootsSucceeded =
    !input.modeSet.has('config')
    || (
      input.expectedRepoRootCount > 0
      && input.successfulConfigRepoCount === input.expectedRepoRootCount
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
    // Fallback to resolved path if realpath is unavailable.
  }

  return allowedRoots.some((root) => realPath === root || realPath.startsWith(`${root}/`));
}

function normalizeModes(input?: string[]): InferenceMode[] {
  const requested = (input ?? ['config', 'code']).map((m) => m.toLowerCase().trim());
  const valid = requested.filter(isInferenceMode);
  const deduped = [...new Set(valid)];
  return deduped.length > 0 ? deduped : ['config', 'code'];
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as RunInferenceRequest;
    const workspaceId = body.workspaceId;
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    const modes = normalizeModes(body.modes);
    const modeSet = new Set<InferenceMode>(modes);
    const codeEngine: CodeSignalEngine = normalizeCodeSignalEngine(body.codeEngine);

    const db = await getDb();
    const allowedInferenceRoots = getAllowedInferenceRoots();

    const providedRoots = (body.repoRoots ?? [])
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    const discoveredFromServices: string[] = [];
    if (body.useServiceMetadataPaths !== false) {
      const services = await db
        .select({ metadata: objects.metadata })
        .from(objects)
        .where(
          and(
            eq(objects.workspaceId, workspaceId),
            eq(objects.objectType, 'service'),
          ),
        );

      for (const svc of services) {
        const metadata = (svc.metadata ?? {}) as Record<string, unknown>;
        const rawPath = metadata['scanPath'];
        if (typeof rawPath === 'string' && rawPath.trim().length > 0) {
          discoveredFromServices.push(rawPath.trim());
        }
      }
    }

    const mergedRoots = [
      ...providedRoots.map((repoRoot) => ({ repoRoot, source: 'provided' as const })),
      ...discoveredFromServices.map((repoRoot) => ({ repoRoot, source: 'serviceMetadata' as const })),
    ];
    const usedRepoRoots: string[] = [];
    const skippedNonLocalRoots: string[] = [];
    const skippedMissingRoots: string[] = [];
    const skippedDisallowedRoots: string[] = [];

    for (const { repoRoot } of mergedRoots) {
      if (isLikelyRemotePath(repoRoot)) {
        if (!skippedNonLocalRoots.includes(repoRoot)) skippedNonLocalRoots.push(repoRoot);
        continue;
      }

      const normalized = resolve(repoRoot);
      if (!isLocalDirectory(normalized)) {
        if (!skippedMissingRoots.includes(normalized)) skippedMissingRoots.push(normalized);
        continue;
      }

      if (!isPathWithinAllowedRoots(normalized, allowedInferenceRoots)) {
        if (!skippedDisallowedRoots.includes(normalized)) skippedDisallowedRoots.push(normalized);
        continue;
      }

      if (!usedRepoRoots.includes(normalized)) usedRepoRoots.push(normalized);
    }

    if ((modeSet.has('config') || modeSet.has('code')) && usedRepoRoots.length === 0) {
      return NextResponse.json(
        {
          error:
            'config/code 추론을 실행할 로컬 repoRoot가 없습니다. 먼저 코드 스캔으로 service.metadata.scanPath를 등록하거나 repoRoots를 직접 전달하세요.',
          details: {
            providedRoots,
            discoveredFromServices,
            skippedNonLocalRoots,
            skippedMissingRoots,
            skippedDisallowedRoots,
            allowedInferenceRoots,
          },
        },
        { status: 400 },
      );
    }

    const startedAt = Date.now();
    const warnings: string[] = [];
    const errors: Array<{ mode: InferenceMode; repoRoot?: string; message: string }> = [];
    const incremental = body.incremental !== false;

    const configResult = {
      repoCount: 0,
      fileCount: 0,
      processedFileCount: 0,
      skippedFileCount: 0,
      candidateCount: 0,
      objectCount: 0,
    };
    const codeResult = {
      repoCount: 0,
      fileCount: 0,
      artifactCount: 0,
      signalCount: 0,
      skippedCount: 0,
      candidateCount: 0,
      engineRequested: codeEngine,
      enginesUsed: [] as CodeSignalEngineUsed[],
      fallbackCount: 0,
      fallbackRepoRoots: [] as string[],
      scanFailures: [] as Array<{ filePath: string; reason: string; language: string }>,
    };
    const llmBoostRequest = {
      enabled: body.llmBoost?.enabled === true,
      codeIntentAnalysis: body.llmBoost?.codeIntentAnalysis !== false,
      generateExplanations: body.llmBoost?.generateExplanations === true,
      requestedMaxCalls:
        typeof body.llmBoost?.maxCalls === 'number' ? body.llmBoost.maxCalls : null,
    };
    let llmBoostResult: {
      request: typeof llmBoostRequest;
      modelConfigured: boolean;
      effectiveMaxCalls: number | null;
      skippedReason: string | null;
      codeIntentAnalysis: null | {
        scannedCount: number;
        generatedCount: number;
        skippedCount: number;
        callCount: number;
        errorCount: number;
      };
    } = {
      request: llmBoostRequest,
      modelConfigured: false,
      effectiveMaxCalls: null,
      skippedReason: null,
      codeIntentAnalysis: null,
    };
    let dbResult:
      | null
      | {
          tableCount: number;
          fkCandidateCount: number;
          implicitFkCandidateCount: number;
        } = null;
    let crossValidationResult:
      | null
      | {
          candidateCount: number;
          validatedCount: number;
          skippedSingleSourceCount: number;
        } = null;

    let successfulCodeRelationRepoCount = 0;
    const successfulCodeRepoRoots: string[] = [];

    if (modeSet.has('config')) {
      for (const repoRoot of usedRepoRoots) {
        try {
          const result = await inferRelationsFromConfig(db, { workspaceId, repoRoot, incremental });
          configResult.repoCount += 1;
          configResult.fileCount += result.fileCount;
          configResult.processedFileCount += result.processedFileCount;
          configResult.skippedFileCount += result.skippedFileCount;
          configResult.candidateCount += result.candidateCount;
          configResult.objectCount += result.objectCount;
        } catch (error) {
          errors.push({
            mode: 'config',
            repoRoot,
            message: error instanceof Error ? error.message : 'unknown error',
          });
        }
      }
    }

    if (modeSet.has('code')) {
      for (const repoRoot of usedRepoRoots) {
        try {
          const result = await extractCodeSignalsWithEngine(db, {
            workspaceId,
            repoRoot,
            codeEngine,
            ...(body.codeOptions?.interProcedural === true
              ? { interProcedural: true }
              : {}),
            ...(typeof body.codeOptions?.maxCallChainDepth === 'number'
              ? { maxCallChainDepth: body.codeOptions.maxCallChainDepth }
              : {}),
            ...(typeof body.codeOptions?.resolveProperties === 'boolean'
              ? { resolveProperties: body.codeOptions.resolveProperties }
              : {}),
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
            codeResult.fallbackRepoRoots.push(repoRoot);
          }
          if (result.warning) warnings.push(`[code:${repoRoot}] ${result.warning}`);
          if (result.scanFailures && result.scanFailures.length > 0) {
            codeResult.scanFailures.push(...result.scanFailures);
          }

          const codeCand = await inferRelationsFromCodeSignals(db, { workspaceId, repoRoot });
          codeResult.candidateCount += codeCand.candidateCount;
          successfulCodeRelationRepoCount += 1;
          successfulCodeRepoRoots.push(repoRoot);
        } catch (error) {
          errors.push({
            mode: 'code',
            repoRoot,
            message: error instanceof Error ? error.message : 'unknown error',
          });
        }
      }
    }

    if (!llmBoostRequest.enabled) {
      llmBoostResult.skippedReason = 'DISABLED';
    } else if (!modeSet.has('code')) {
      llmBoostResult.skippedReason = 'CODE_MODE_NOT_SELECTED';
    } else if (!llmBoostRequest.codeIntentAnalysis) {
      llmBoostResult.skippedReason = 'CODE_INTENT_ANALYSIS_DISABLED';
    } else if (successfulCodeRepoRoots.length === 0) {
      llmBoostResult.skippedReason = 'NO_SUCCESSFUL_CODE_ROOTS';
    } else {
      llmBoostResult.effectiveMaxCalls = resolveMaxCalls(body.llmBoost?.maxCalls);

      if (llmBoostResult.effectiveMaxCalls === 0) {
        llmBoostResult.skippedReason = 'MAX_CALLS_EXHAUSTED';
      } else {
        const modelInfo = getInferenceModel(req);

        if (!modelInfo) {
          llmBoostResult.skippedReason = 'LLM_NOT_CONFIGURED';
          warnings.push(
            'LLM 부스터(code intent analysis)를 건너뜁니다: AI 제공자 설정이 없습니다.',
          );
        } else {
          llmBoostResult.modelConfigured = true;

          try {
            llmBoostResult.codeIntentAnalysis = await generateBoostCandidates(
              db,
              createGenerateBoostSuggestionFn(modelInfo.model, modelInfo.modelName),
              {
                workspaceId,
                repoRoots: successfulCodeRepoRoots,
                maxCalls: llmBoostResult.effectiveMaxCalls,
              },
            );
          } catch (error) {
            llmBoostResult.skippedReason = 'FAILED';
            warnings.push(
              `LLM 부스터(code intent analysis) 실패: ${error instanceof Error ? error.message : 'unknown'}`,
            );
          }
        }
      }
    }

    let crossBindingResult: ConfigCodeBindingResult | null = null;

    if (modeSet.has('db')) {
      try {
        dbResult = await extractDbSchemaSignals(db, { workspaceId, incremental });
      } catch (error) {
        errors.push({
          mode: 'db',
          message: error instanceof Error ? error.message : 'unknown error',
        });
      }
    }

    const allSelectedModesSucceeded = didAllSelectedModesSucceed({
      modeSet,
      expectedRepoRootCount: usedRepoRoots.length,
      successfulConfigRepoCount: configResult.repoCount,
      successfulCodeRelationRepoCount,
      dbSucceeded: dbResult !== null,
    });
    const selectedConfigAndCodeModesSucceeded = didSelectedConfigAndCodeModesSucceed({
      modeSet,
      expectedRepoRootCount: usedRepoRoots.length,
      successfulConfigRepoCount: configResult.repoCount,
      successfulCodeRelationRepoCount,
    });

    if (modeSet.has('config') && modeSet.has('code') && selectedConfigAndCodeModesSucceeded) {
      try {
        crossBindingResult = await bindConfigToCodeEndpoints(db, {
          workspaceId,
          repoRoots: successfulCodeRepoRoots,
        });
      } catch (error) {
        warnings.push(
          `config↔code 크로스 바인딩 실패: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    }

    if (modeSet.has('code') && modeSet.size >= 2 && allSelectedModesSucceeded) {
      try {
        crossValidationResult = await crossValidatePendingRelationCandidates(db, {
          workspaceId,
          repoRoots: successfulCodeRepoRoots,
          includeSchemaCandidates: modeSet.has('db'),
        });
      } catch (error) {
        warnings.push(
          `cross-signal validation 실패: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    }

    if (skippedNonLocalRoots.length > 0) {
      warnings.push(
        `원격 경로(${skippedNonLocalRoots.length}개)는 현재 /api/inference/run에서 직접 처리하지 않아 제외되었습니다.`,
      );
    }

    if (skippedMissingRoots.length > 0) {
      warnings.push(
        `존재하지 않는 경로(${skippedMissingRoots.length}개)가 제외되었습니다.`,
      );
    }

    if (skippedDisallowedRoots.length > 0) {
      warnings.push(
        `허용 경로 외 디렉터리(${skippedDisallowedRoots.length}개)가 제외되었습니다.`,
      );
    }

    const dbCandidateCount =
      (dbResult?.fkCandidateCount ?? 0) + (dbResult?.implicitFkCandidateCount ?? 0);
    const crossBindingCandidateCount = crossBindingResult?.createdEndpointCandidateCount ?? 0;
    const llmBoostCandidateCount = llmBoostResult.codeIntentAnalysis?.generatedCount ?? 0;

    const relationCandidatesCreated =
      configResult.candidateCount
      + dbCandidateCount
      + codeResult.candidateCount
      + crossBindingCandidateCount
      + llmBoostCandidateCount;
    const hasAnySuccess =
      configResult.repoCount > 0 ||
      successfulCodeRelationRepoCount > 0 ||
      dbResult !== null;

    if (!hasAnySuccess && errors.length > 0) {
      return NextResponse.json(
        {
          error: '추론 실행에 실패했습니다.',
          errors,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      workspaceId,
      requestedModes: ALL_MODES.filter((mode) => modeSet.has(mode)),
      incremental,
      repoRoots: {
        provided: providedRoots,
        discoveredFromServices,
        used: usedRepoRoots,
        skippedNonLocal: skippedNonLocalRoots,
        skippedMissing: skippedMissingRoots,
        skippedDisallowed: skippedDisallowedRoots,
        allowed: allowedInferenceRoots,
      },
      results: {
        config: configResult,
        code: codeResult,
        llmBoost: llmBoostResult,
        db: dbResult,
        crossBinding: crossBindingResult,
        crossValidation: crossValidationResult,
      },
      summary: {
        relationCandidatesCreated,
        executionMs: Date.now() - startedAt,
      },
      warnings,
      errors,
    });
  } catch (error) {
    console.error('[POST /api/inference/run]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
