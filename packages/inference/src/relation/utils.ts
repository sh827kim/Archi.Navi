import {
  asFiniteNumber,
  asRecord,
  getRawCandidateConfidence,
  stripCrossValidationMetadata,
} from '../utils/metadata';

export { asFiniteNumber, asRecord, stripCrossValidationMetadata };

export function getPreCrossValidationConfidence(confidence: number, metadata: unknown): number {
  return getRawCandidateConfidence(confidence, metadata);
}

export function getBaseCandidateConfidence(confidence: number, metadata: unknown): number {
  const feedbackBaseConfidence = asFiniteNumber(asRecord(asRecord(metadata)?.feedback)?.baseConfidence);
  if (feedbackBaseConfidence !== null) {
    return feedbackBaseConfidence;
  }

  return getPreCrossValidationConfidence(confidence, metadata);
}
