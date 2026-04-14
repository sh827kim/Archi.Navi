export type InferencePipelineName = 'reinforced' | 'redesign';

export interface InferencePipelineMeta {
  name: InferencePipelineName;
  version: string;
}

const INVALID_PIPELINE_MESSAGE = 'pipeline must be one of: reinforced, redesign';
const INCOMPATIBLE_PIPELINE_MESSAGE = 'compatDeterministicCandidates is only supported for pipeline=reinforced';

const PIPELINE_VERSIONS: Record<InferencePipelineName, string> = {
  reinforced: 'reinforced-v1',
  redesign: 'redesign-v1',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function isInferencePipelineName(value: string): value is InferencePipelineName {
  return value === 'reinforced' || value === 'redesign';
}

export function normalizeInferencePipelineName(value: unknown): InferencePipelineName {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return isInferencePipelineName(normalized) ? normalized : 'reinforced';
}

export function buildInferencePipelineMeta(
  value: unknown,
  compatDeterministicCandidates?: boolean | null,
): InferencePipelineMeta {
  if (value === undefined || value === null) {
    return {
      name: 'reinforced',
      version: PIPELINE_VERSIONS.reinforced,
    };
  }
  if (typeof value !== 'string') {
    throw new Error(INVALID_PIPELINE_MESSAGE);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error(INVALID_PIPELINE_MESSAGE);
  }
  if (!isInferencePipelineName(normalized)) {
    throw new Error(INVALID_PIPELINE_MESSAGE);
  }
  if (normalized === 'redesign' && compatDeterministicCandidates === true) {
    throw new Error(INCOMPATIBLE_PIPELINE_MESSAGE);
  }
  return {
    name: normalized,
    version: PIPELINE_VERSIONS[normalized],
  };
}

export function isInferencePipelineValidationError(error: unknown): error is Error {
  return error instanceof Error
    && (error.message === INVALID_PIPELINE_MESSAGE || error.message === INCOMPATIBLE_PIPELINE_MESSAGE);
}

export function extractRequestedInferencePipelineMeta(
  value: unknown,
  fallback?: InferencePipelineMeta,
): InferencePipelineMeta {
  const record = asRecord(value);
  const nestedRequested = asRecord(record?.requestedPipeline);
  const candidateName = asString(
    nestedRequested?.name
    ?? record?.pipeline
    ?? record?.pipelineName,
  );
  const name = normalizeInferencePipelineName(candidateName ?? fallback?.name);
  const version = asString(
    nestedRequested?.version
    ?? fallback?.version,
  ) ?? PIPELINE_VERSIONS[name];

  return { name, version };
}

export function extractEffectiveInferencePipelineMeta(
  value: unknown,
  fallback?: InferencePipelineMeta,
): InferencePipelineMeta {
  const record = asRecord(value);
  const nestedRequested = asRecord(record?.requestedPipeline);
  const nestedEffective = asRecord(record?.effectivePipeline);
  const nestedSummary = asRecord(record?.summary);

  const candidateName = asString(
    record?.pipeline
    ?? record?.pipelineName
    ?? nestedEffective?.name
    ?? nestedRequested?.name
    ?? nestedSummary?.pipeline
    ?? nestedSummary?.pipelineName
    ?? fallback?.name,
  );
  const name = normalizeInferencePipelineName(candidateName);
  const version = asString(
    record?.pipelineVersion
    ?? nestedEffective?.version
    ?? nestedRequested?.version
    ?? nestedSummary?.pipelineVersion
    ?? fallback?.version,
  ) ?? PIPELINE_VERSIONS[name];

  return { name, version };
}

export function extractInferencePipelineMeta(
  value: unknown,
  fallback?: InferencePipelineMeta,
): InferencePipelineMeta {
  return extractEffectiveInferencePipelineMeta(value, fallback);
}

export function decoratePipelineSummary<T extends Record<string, unknown>>(
  summary: T,
  pipeline: InferencePipelineMeta,
  requestedPipeline: InferencePipelineMeta = pipeline,
): T & {
  pipeline: InferencePipelineName;
  pipelineVersion: string;
  requestedPipeline: InferencePipelineMeta;
  effectivePipeline: InferencePipelineMeta;
} {
  const currentRequested = asRecord(summary['requestedPipeline']);
  const currentEffective = asRecord(summary['effectivePipeline']);
  const requestedName = normalizeInferencePipelineName(currentRequested?.name ?? requestedPipeline.name);
  return {
    ...summary,
    pipeline: pipeline.name,
    pipelineVersion: pipeline.version,
    requestedPipeline: {
      ...currentRequested,
      name: requestedName,
      version: requestedPipeline.version,
    },
    effectivePipeline: {
      ...currentEffective,
      name: pipeline.name,
      version: pipeline.version,
    },
  };
}

export function mergePipelineStats(
  stats: Record<string, unknown>,
  pipeline: InferencePipelineMeta,
  requestedPipeline: InferencePipelineMeta = pipeline,
): Record<string, unknown> {
  const currentRequested = asRecord(stats['requestedPipeline']);
  const currentEffective = asRecord(stats['effectivePipeline']);
  const requestedName = normalizeInferencePipelineName(currentRequested?.name ?? requestedPipeline.name);
  return {
    ...stats,
    pipeline: pipeline.name,
    pipelineVersion: pipeline.version,
    requestedPipeline: {
      ...currentRequested,
      name: requestedName,
      version: requestedPipeline.version,
    },
    effectivePipeline: {
      ...currentEffective,
      name: pipeline.name,
      version: pipeline.version,
    },
  };
}
