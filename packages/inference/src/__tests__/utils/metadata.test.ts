import { describe, expect, it } from 'vitest';
import {
  asFiniteNumber,
  asRecord,
  getRawCandidateConfidence,
  stripCrossValidationMetadata,
} from '@/utils/metadata';

describe('metadata utils', () => {
  it('객체만 record로 변환해야 한다', () => {
    expect(asRecord({ ok: true })).toEqual({ ok: true });
    expect(asRecord(null)).toBeNull();
    expect(asRecord(['x'])).toBeNull();
  });

  it('finite number만 반환해야 한다', () => {
    expect(asFiniteNumber(0.7)).toBe(0.7);
    expect(asFiniteNumber(Number.NaN)).toBeNull();
  });

  it('crossValidation.originalConfidence를 우선해야 한다', () => {
    expect(getRawCandidateConfidence(0.9, { crossValidation: { originalConfidence: 0.4 } })).toBe(0.4);
    expect(getRawCandidateConfidence(0.9, {})).toBe(0.9);
  });

  it('crossValidation metadata만 제거해야 한다', () => {
    expect(
      stripCrossValidationMetadata({
        source: 'CODE',
        crossValidation: { adjustedConfidence: 0.95 },
      }),
    ).toEqual({ source: 'CODE' });
    expect(stripCrossValidationMetadata(null)).toEqual({});
  });
});
