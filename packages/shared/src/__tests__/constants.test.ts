import { describe, it, expect } from 'vitest';
import {
  OBJECT_TYPES,
  RELATION_TYPES,
  OBJECT_TYPE_CATEGORY,
  OBJECT_TYPE_GRANULARITY,
  RELATION_SEMANTICS,
  DEFAULTS,
} from '../constants/index';

describe('shared/constants', () => {
  it('OBJECT_TYPES의 모든 항목은 카테고리 매핑을 가져야 한다', () => {
    for (const t of OBJECT_TYPES) {
      expect(OBJECT_TYPE_CATEGORY[t]).toBeDefined();
    }
  });

  it('OBJECT_TYPES의 모든 항목은 granularity 매핑을 가져야 한다', () => {
    for (const t of OBJECT_TYPES) {
      expect(OBJECT_TYPE_GRANULARITY[t]).toBeDefined();
    }
  });

  it('RELATION_TYPES의 모든 항목은 semantics 매핑을 가져야 한다', () => {
    for (const t of RELATION_TYPES) {
      expect(RELATION_SEMANTICS[t]).toBeDefined();
      expect(RELATION_SEMANTICS[t].interactionKind).toBeTruthy();
      expect(RELATION_SEMANTICS[t].direction).toBeTruthy();
    }
  });

  it('기본값 상수는 양수여야 한다', () => {
    expect(DEFAULTS.MAX_HOPS).toBeGreaterThan(0);
    expect(DEFAULTS.MAX_VISITED).toBeGreaterThan(0);
    expect(DEFAULTS.TOP_K_PATHS).toBeGreaterThan(0);
    expect(DEFAULTS.RENDER_BATCH_SIZE).toBeGreaterThan(0);
    expect(DEFAULTS.MAX_EVIDENCE_COUNT).toBeGreaterThan(0);
  });
});
