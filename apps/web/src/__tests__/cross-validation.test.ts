import { describe, expect, it } from 'vitest';
import { summarizeCrossValidation } from '@/lib/cross-validation';

describe('summarizeCrossValidation', () => {
  it('CONFIG, FILE, SCHEMA evidence를 config/code/db 소스로 집계해야 한다', () => {
    const result = summarizeCrossValidation([
      { evidenceType: 'CONFIG' },
      { evidenceType: 'FILE' },
      { evidenceType: 'SCHEMA' },
      { evidenceType: 'FILE' },
    ]);

    expect(result).toEqual({
      validated: true,
      supportCount: 3,
      supportingSources: ['config', 'code', 'db'],
      contradictions: [],
    });
  });

  it('동일 계열 evidence는 하나의 소스로만 계산해야 한다', () => {
    const result = summarizeCrossValidation([
      { evidenceType: 'FILE' },
      { evidenceType: 'LLM_CODE' },
    ]);

    expect(result).toEqual({
      validated: false,
      supportCount: 1,
      supportingSources: ['code'],
      contradictions: [],
    });
  });

  it('알 수 없는 evidenceType만 있으면 교차 검증 정보를 비워야 한다', () => {
    const result = summarizeCrossValidation([{ evidenceType: 'MANUAL' }]);

    expect(result).toEqual({
      validated: false,
      supportCount: 0,
      supportingSources: [],
      contradictions: [],
    });
  });

  it('metadata contradictions를 그대로 포함해야 한다', () => {
    const result = summarizeCrossValidation(
      [{ evidenceType: 'CONFIG' }],
      [{ ruleId: 'C1', type: 'STALE_CONFIG', penalty: 0.15 }],
    );

    expect(result).toEqual({
      validated: false,
      supportCount: 1,
      supportingSources: ['config'],
      contradictions: [{ ruleId: 'C1', type: 'STALE_CONFIG', penalty: 0.15 }],
    });
  });

  it('C2~C4 contradiction shape도 손실 없이 유지해야 한다', () => {
    const result = summarizeCrossValidation(
      [{ evidenceType: 'FILE' }],
      [
        { ruleId: 'C2', type: 'PHANTOM_CALL', penalty: 0.15 },
        { ruleId: 'C3', type: 'DEAD_TOPIC', penalty: 0.15 },
        { ruleId: 'C4', type: 'ORPHAN_FK', penalty: 0.15 },
      ],
    );

    expect(result).toEqual({
      validated: false,
      supportCount: 1,
      supportingSources: ['code'],
      contradictions: [
        { ruleId: 'C2', type: 'PHANTOM_CALL', penalty: 0.15 },
        { ruleId: 'C3', type: 'DEAD_TOPIC', penalty: 0.15 },
        { ruleId: 'C4', type: 'ORPHAN_FK', penalty: 0.15 },
      ],
    });
  });
});
