import { describe, it, expect } from 'vitest';
import {
  generateId,
  buildUrn,
  buildPath,
  normalizeAffinity,
  calculatePurity,
  getPrimaryDomain,
  getSecondaryDomains,
  calculatePathScore,
} from '../utils/index';

describe('shared/utils', () => {
  it('generateId는 유효한 문자열 ID를 반환해야 한다', () => {
    const id1 = generateId();
    const id2 = generateId();
    expect(typeof id1).toBe('string');
    expect(id1.length).toBeGreaterThan(10);
    expect(id1).not.toBe(id2);
  });

  it('buildUrn은 category를 소문자로 정규화해야 한다', () => {
    expect(buildUrn('ws-1', 'STORAGE', 'database', 'host:db')).toBe(
      'urn:ws-1:storage:database:host:db',
    );
  });

  it('buildPath는 루트/null 부모를 올바르게 처리해야 한다', () => {
    expect(buildPath(null, 'a')).toBe('/a');
    expect(buildPath('/', 'b')).toBe('/b');
    expect(buildPath('/root', 'c')).toBe('/root/c');
  });

  it('normalizeAffinity는 총합이 0이면 원본을 반환해야 한다', () => {
    const input = { a: 0, b: 0 };
    expect(normalizeAffinity(input)).toEqual(input);
  });

  it('normalizeAffinity는 합이 1이 되도록 정규화해야 한다', () => {
    const normalized = normalizeAffinity({ a: 2, b: 1 });
    expect(normalized.a).toBeCloseTo(2 / 3, 5);
    expect(normalized.b).toBeCloseTo(1 / 3, 5);
  });

  it('calculatePurity는 빈 affinity에서 0을 반환해야 한다', () => {
    expect(calculatePurity({})).toBe(0);
  });

  it('calculatePurity는 최대 affinity를 반환해야 한다', () => {
    expect(calculatePurity({ a: 0.2, b: 0.8, c: 0.4 })).toBe(0.8);
  });

  it('getPrimaryDomain은 빈 affinity에서 null을 반환해야 한다', () => {
    expect(getPrimaryDomain({})).toBeNull();
  });

  it('getPrimaryDomain은 최고 점수 도메인을 반환해야 한다', () => {
    expect(getPrimaryDomain({ order: 0.7, payment: 0.2, inventory: 0.1 })).toBe('order');
  });

  it('getSecondaryDomains는 primary를 제외하고 threshold 이상을 반환해야 한다', () => {
    const affinity = { order: 0.6, payment: 0.3, inventory: 0.1 };
    expect(getSecondaryDomains(affinity, 0.25)).toEqual(['payment']);
  });

  it('calculatePathScore는 hop penalty를 반영해야 한다', () => {
    const hop1 = calculatePathScore(0.9, 3, 1);
    const hop3 = calculatePathScore(0.9, 3, 3);
    expect(hop1).toBeGreaterThan(hop3);
  });
});
