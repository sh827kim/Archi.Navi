export type CrossValidationSource = 'config' | 'code' | 'db';
export type CrossValidationRuleId = 'C1' | 'C2' | 'C3' | 'C4';
export type CrossValidationContradictionType =
  | 'STALE_CONFIG'
  | 'PHANTOM_CALL'
  | 'DEAD_TOPIC'
  | 'ORPHAN_FK';

export const CROSS_VALIDATION_RULE_IDS: CrossValidationRuleId[] = ['C1', 'C2', 'C3', 'C4'];
export const CROSS_VALIDATION_CONTRADICTION_TYPES: CrossValidationContradictionType[] = [
  'STALE_CONFIG',
  'PHANTOM_CALL',
  'DEAD_TOPIC',
  'ORPHAN_FK',
];

export interface CrossValidationContradiction {
  ruleId: CrossValidationRuleId;
  type: CrossValidationContradictionType;
  penalty: number;
}

export interface CrossValidationSummary {
  validated: boolean;
  supportCount: number;
  supportingSources: CrossValidationSource[];
  contradictions: CrossValidationContradiction[];
}

export interface EvidenceSupportRow {
  evidenceType: string | null;
}

const SOURCE_ORDER: CrossValidationSource[] = ['config', 'code', 'db'];

function classifyEvidenceSource(evidenceType: string | null): CrossValidationSource | null {
  if (evidenceType === 'CONFIG' || evidenceType === 'LLM_CONFIG') return 'config';
  if (evidenceType === 'FILE' || evidenceType === 'LLM_CODE') return 'code';
  if (evidenceType === 'SCHEMA') return 'db';
  return null;
}

function normalizeContradictions(
  contradictions: CrossValidationContradiction[] | undefined,
): CrossValidationContradiction[] {
  return Array.isArray(contradictions) ? contradictions : [];
}

export function getCrossValidationContradictionLabel(
  type: CrossValidationContradictionType,
): string {
  if (type === 'STALE_CONFIG') return 'STALE_CONFIG 경고';
  if (type === 'PHANTOM_CALL') return 'PHANTOM_CALL 경고';
  if (type === 'DEAD_TOPIC') return 'DEAD_TOPIC 경고';
  return 'ORPHAN_FK 경고';
}

export function summarizeCrossValidation(
  rows: EvidenceSupportRow[],
  contradictions?: CrossValidationContradiction[],
): CrossValidationSummary {
  const sourceSet = new Set<CrossValidationSource>();

  for (const row of rows) {
    const source = classifyEvidenceSource(row.evidenceType);
    if (source) sourceSet.add(source);
  }

  const supportingSources = SOURCE_ORDER.filter((source) => sourceSet.has(source));
  const normalizedContradictions = normalizeContradictions(contradictions);
  return {
    validated: supportingSources.length > 1 && normalizedContradictions.length === 0,
    supportCount: supportingSources.length,
    supportingSources,
    contradictions: normalizedContradictions,
  };
}
