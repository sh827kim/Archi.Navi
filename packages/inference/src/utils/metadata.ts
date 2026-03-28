export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function getRawCandidateConfidence(confidence: number, metadata: unknown): number {
  return asFiniteNumber(asRecord(asRecord(metadata)?.crossValidation)?.originalConfidence) ?? confidence;
}

export function stripCrossValidationMetadata(metadata: unknown): Record<string, unknown> {
  const record = asRecord(metadata) ?? {};
  if (!Object.prototype.hasOwnProperty.call(record, 'crossValidation')) {
    return record;
  }

  const nextMetadata = { ...record };
  delete nextMetadata.crossValidation;
  return nextMetadata;
}
