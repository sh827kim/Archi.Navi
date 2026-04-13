/**
 * 코드 스캔 관련 타입 정의
 * CLI 및 Web UI 양쪽에서 공유
 */

/** 스캔 모드 — 4가지 소스 지원 */
export type ScanMode = 'local' | 'workspace-dir' | 'github-repo' | 'github-org';

/** 스캔 요청 파라미터 */
export interface ScanRequest {
  workspaceId: string;
  mode: ScanMode;
  /** 모드별 대상: 디렉토리 경로 / owner/repo / org명 */
  target: string;
  /** 언어 필터 (선택) */
  lang?: string;
  /** true면 등록 없이 발견 목록만 반환 */
  dryRun?: boolean;
  /** true일 때만 DB 관련 bootstrap을 허용 */
  enableDbScan?: boolean;
}

/** 프로젝트 감지 결과 */
export interface DiscoveredProject {
  name: string;
  path: string;
  language: string;
  markerFile: string;
}

/** 스캔 실행 결과 */
export interface ScanResult {
  mode: ScanMode;
  target: string;
  projects: DiscoveredProject[];
  /** DB에 등록된 프로젝트 수 */
  registered: number;
  /** 이미 존재하여 건너뛴 프로젝트 수 */
  skipped: number;
  /** 스캔 직후 수행한 1차 코드 분석 요약 */
  bootstrap?: {
    analyzedProjectCount: number;
    signalCount: number;
    candidateCount: number;
    createdEndpointCount: number;
    createdAtomicCount: number;
    warnings: string[];
  };
}
