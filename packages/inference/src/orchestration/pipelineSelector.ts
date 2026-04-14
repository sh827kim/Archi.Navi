import {
  normalizeCodeSignalEngine,
  type CodeSignalEngine,
} from '../code/codeSignalEngine';

export type InferencePipelineName = 'reinforced' | 'redesign';
export type InferencePipelineSource = 'default' | 'request';
export type InferencePipelineExecutionStrategy = 'linear_replay' | 'snapshot_closure';
export type InferencePipelineStageRole =
  | 'ingest'
  | 'schema_scan'
  | 'proof_replay'
  | 'smart_interop'
  | 'compat_backfill'
  | 'evidence_collection'
  | 'plan_synthesis'
  | 'graph_materialization'
  | 'atomic_closure'
  | 'projection_materialization';
export type InferencePipelineStageName =
  | 'source_extraction'
  | 'db_extraction'
  | 'proof_resolution'
  | 'smart_resolution'
  | 'compat_deterministic'
  | 'evidence_intake'
  | 'binding_synthesis'
  | 'proof_graph_build'
  | 'atomic_closure'
  | 'projection'
  | 'smart_interop';
export type InferencePipelineStageFailureMode = 'continue' | 'halt';

export interface RequestedPipelineSettings {
  name: InferencePipelineName;
  source: InferencePipelineSource;
}

export interface EffectivePipelineSettings {
  name: InferencePipelineName;
  version: string;
  codeEngine: CodeSignalEngine;
}

export interface InferencePipelineStageSpec {
  stage: InferencePipelineStageName;
  failureMode: InferencePipelineStageFailureMode;
  role: InferencePipelineStageRole;
  description: string;
}

export interface InferencePipelineExecutionSpec {
  pipeline: InferencePipelineName;
  version: string;
  strategyName: InferencePipelineExecutionStrategy;
  stageOrder: InferencePipelineStageName[];
  stages: InferencePipelineStageSpec[];
}

const DEFAULT_PIPELINE: InferencePipelineName = 'reinforced';

const PIPELINE_VERSIONS: Record<InferencePipelineName, string> = {
  reinforced: 'reinforced-v1',
  redesign: 'redesign-v1',
};

const PIPELINE_EXECUTION_SPECS: Record<InferencePipelineName, InferencePipelineExecutionSpec> = {
  reinforced: {
    pipeline: 'reinforced',
    version: PIPELINE_VERSIONS.reinforced,
    strategyName: 'linear_replay',
    stageOrder: [
      'source_extraction',
      'db_extraction',
      'proof_resolution',
      'smart_resolution',
      'compat_deterministic',
    ],
    stages: [
      {
        stage: 'source_extraction',
        failureMode: 'continue',
        role: 'ingest',
        description: '원본 source를 수집하고 code/config 신호를 추출한다.',
      },
      {
        stage: 'db_extraction',
        failureMode: 'continue',
        role: 'schema_scan',
        description: 'DB schema 신호를 별도 경로로 스캔한다.',
      },
      {
        stage: 'proof_resolution',
        failureMode: 'continue',
        role: 'proof_replay',
        description: '기존 intent proof 경로를 순차적으로 재실행한다.',
      },
      {
        stage: 'smart_resolution',
        failureMode: 'continue',
        role: 'smart_interop',
        description: 'frontier proof에 대해 smart 보정 단계를 수행한다.',
      },
      {
        stage: 'compat_deterministic',
        failureMode: 'continue',
        role: 'compat_backfill',
        description: '하위 호환용 deterministic candidate 생성을 보강한다.',
      },
    ],
  },
  redesign: {
    pipeline: 'redesign',
    version: PIPELINE_VERSIONS.redesign,
    strategyName: 'snapshot_closure',
    stageOrder: [
      'evidence_intake',
      'binding_synthesis',
      'proof_graph_build',
      'atomic_closure',
      'projection',
      'smart_interop',
    ],
    stages: [
      {
        stage: 'evidence_intake',
        failureMode: 'halt',
        role: 'evidence_collection',
        description: 'code/config/db evidence를 한 번에 수집하고 재사용 가능한 입력으로 고정한다.',
      },
      {
        stage: 'binding_synthesis',
        failureMode: 'halt',
        role: 'plan_synthesis',
        description: '증거를 바탕으로 impacted intent와 resolver plan을 합성한다.',
      },
      {
        stage: 'proof_graph_build',
        failureMode: 'halt',
        role: 'graph_materialization',
        description: 'plan을 proof graph worklist와 dependency snapshot으로 구체화한다.',
      },
      {
        stage: 'atomic_closure',
        failureMode: 'continue',
        role: 'atomic_closure',
        description: 'graph worklist를 따라 intent proof를 원자적으로 닫는다.',
      },
      {
        stage: 'projection',
        failureMode: 'continue',
        role: 'projection_materialization',
        description: 'closure 결과를 smart interop용 projection snapshot으로 변환한다.',
      },
      {
        stage: 'smart_interop',
        failureMode: 'continue',
        role: 'smart_interop',
        description: 'projection snapshot을 바탕으로 smart 보정과 후속 interop을 수행한다.',
      },
    ],
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isInferencePipelineName(value: string): value is InferencePipelineName {
  return value === 'reinforced' || value === 'redesign';
}

function getPipelineStageSpec(
  executionSpec: InferencePipelineExecutionSpec,
  stage: InferencePipelineStageName,
): InferencePipelineStageSpec | null {
  return executionSpec.stages.find((spec) => spec.stage === stage) ?? null;
}

export function normalizeInferencePipeline(
  input?: string | null,
): RequestedPipelineSettings {
  if (typeof input !== 'string') {
    return { name: DEFAULT_PIPELINE, source: 'default' };
  }

  const normalized = input.trim().toLowerCase();
  if (normalized.length === 0) {
    return { name: DEFAULT_PIPELINE, source: 'default' };
  }
  if (!isInferencePipelineName(normalized)) {
    throw new Error('pipeline must be one of: reinforced, redesign');
  }
  return {
    name: normalized,
    source: 'request',
  };
}

export function resolveEffectiveInferencePipelineSettings(input: {
  pipeline?: string | null;
  codeEngine?: string | null;
  compatDeterministicCandidates?: boolean | null;
}): {
  requestedPipeline: RequestedPipelineSettings;
  effectivePipeline: EffectivePipelineSettings;
  requestedCodeEngine: CodeSignalEngine;
  effectiveCodeEngine: CodeSignalEngine;
  warnings: string[];
} {
  const requestedPipeline = normalizeInferencePipeline(input.pipeline);
  const requestedCodeEngine = normalizeCodeSignalEngine(input.codeEngine ?? null);
  const warnings: string[] = [];

  if (requestedPipeline.name === 'redesign' && input.compatDeterministicCandidates === true) {
    throw new Error('compatDeterministicCandidates is only supported for pipeline=reinforced');
  }

  let effectiveCodeEngine = requestedCodeEngine;
  if (requestedPipeline.name === 'redesign' && requestedCodeEngine === 'regex') {
    effectiveCodeEngine = 'hybrid';
    warnings.push(
      'pipeline redesign does not support regex-only extraction; effective codeEngine upgraded to hybrid',
    );
  }

  return {
    requestedPipeline,
    effectivePipeline: {
      name: requestedPipeline.name,
      version: PIPELINE_VERSIONS[requestedPipeline.name],
      codeEngine: effectiveCodeEngine,
    },
    requestedCodeEngine,
    effectiveCodeEngine,
    warnings,
  };
}

export function buildDefaultEffectivePipelineSettings(): EffectivePipelineSettings {
  return {
    name: DEFAULT_PIPELINE,
    version: PIPELINE_VERSIONS[DEFAULT_PIPELINE],
    codeEngine: 'hybrid',
  };
}

export function buildInferencePipelineExecutionSpec(
  pipeline: InferencePipelineName,
): InferencePipelineExecutionSpec {
  return PIPELINE_EXECUTION_SPECS[pipeline];
}

export function buildPipelineSelectedEventPayload(input: {
  requestedPipeline: RequestedPipelineSettings;
  effectivePipeline: EffectivePipelineSettings;
  requestedCodeEngine: CodeSignalEngine;
  effectiveCodeEngine: CodeSignalEngine;
  executionSpec: InferencePipelineExecutionSpec;
}): Record<string, unknown> {
  return {
    requestedPipeline: input.requestedPipeline.name,
    requestedPipelineSource: input.requestedPipeline.source,
    effectivePipeline: input.effectivePipeline.name,
    pipelineVersion: input.effectivePipeline.version,
    pipelineStrategy: input.executionSpec.strategyName,
    stageOrder: input.executionSpec.stageOrder,
    requestedCodeEngine: input.requestedCodeEngine,
    effectiveCodeEngine: input.effectiveCodeEngine,
  };
}

export function buildPipelineStageEventPayload(input: {
  executionSpec: InferencePipelineExecutionSpec;
  stage: InferencePipelineStageName;
  metrics?: Record<string, number | string | boolean | null>;
}): Record<string, unknown> {
  const stageSpec = getPipelineStageSpec(input.executionSpec, input.stage);
  return {
    pipeline: input.executionSpec.pipeline,
    pipelineVersion: input.executionSpec.version,
    pipelineStrategy: input.executionSpec.strategyName,
    stage: input.stage,
    stageRole: stageSpec?.role ?? null,
    stageDescription: stageSpec?.description ?? null,
    failureMode: stageSpec?.failureMode ?? null,
    ...(input.metrics ?? {}),
  };
}

export function readRequestedPipelineSettingsFromRunStats(
  stats: unknown,
): RequestedPipelineSettings {
  const record = asRecord(stats);
  const requested = asRecord(record?.['requestedPipeline']);
  const name = typeof requested?.['name'] === 'string' ? requested['name'].trim().toLowerCase() : '';
  const source = requested?.['source'] === 'request' ? 'request' : 'default';

  if (isInferencePipelineName(name)) {
    return {
      name,
      source,
    };
  }

  return {
    name: DEFAULT_PIPELINE,
    source: 'default',
  };
}

export function readEffectivePipelineSettingsFromRunStats(
  stats: unknown,
): EffectivePipelineSettings {
  const record = asRecord(stats);
  const effective = asRecord(record?.['effectivePipeline']);
  const name = typeof effective?.['name'] === 'string' ? effective['name'].trim().toLowerCase() : '';
  const version = typeof effective?.['version'] === 'string' && effective['version'].trim().length > 0
    ? effective['version'].trim()
    : PIPELINE_VERSIONS[DEFAULT_PIPELINE];
  const codeEngine = typeof effective?.['codeEngine'] === 'string'
    ? normalizeCodeSignalEngine(effective['codeEngine'])
    : 'hybrid';

  if (isInferencePipelineName(name)) {
    return {
      name,
      version,
      codeEngine,
    };
  }

  return buildDefaultEffectivePipelineSettings();
}
