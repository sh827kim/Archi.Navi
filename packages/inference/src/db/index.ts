/**
 * DB 스키마 신호 추출 모듈
 * Phase 1: FK 제약조건/컬럼 패턴 기반 신호 추출 + dbScore 계산
 */
export { extractDbSchemaSignals, computeDbScores } from './dbSchemaSignal';
export type { DbSchemaSignalOptions, DbSchemaSignalResult } from './dbSchemaSignal';
