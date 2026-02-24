// 기본 워크스페이스 UUID (dev/로컬 환경용 고정 ID)
export const DEFAULT_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

// Object 타입 상수 - 설계 문서의 Canonical Object Type Enum
export const OBJECT_TYPES = [
  'service',
  'api_endpoint',
  'function',
  'database',
  'db_table',
  'db_view',
  'cache_instance',
  'cache_key',
  'message_broker',
  'topic',
  'queue',
  'domain',
] as const;

// Object 카테고리 (COMPUTE / STORAGE / CHANNEL)
export const OBJECT_CATEGORIES = ['COMPUTE', 'STORAGE', 'CHANNEL'] as const;

// Object 세분도 (집합체 / 원자 단위)
export const OBJECT_GRANULARITIES = ['COMPOUND', 'ATOMIC'] as const;

// Relation 타입 상수
export const RELATION_TYPES = [
  'call',
  'expose',
  'read',
  'write',
  'produce',
  'consume',
  'depend_on',
  'fk_reference',
] as const;

// Relation Semantic Axis - interaction_kind
export const INTERACTION_KINDS = ['CONTROL', 'DATA', 'ASYNC', 'STATIC'] as const;

// Relation 방향
export const DIRECTIONS = ['IN', 'OUT'] as const;

// Roll-up 레벨
export const ROLLUP_LEVELS = [
  'SERVICE_TO_SERVICE',
  'SERVICE_TO_DATABASE',
  'SERVICE_TO_BROKER',
  'DOMAIN_TO_DOMAIN',
] as const;

// Query 타입
export const QUERY_TYPES = [
  'IMPACT_ANALYSIS',
  'PATH_DISCOVERY',
  'USAGE_DISCOVERY',
  'DOMAIN_SUMMARY',
] as const;

// Object 가시성
export const VISIBILITY_OPTIONS = ['VISIBLE', 'HIDDEN'] as const;

// Relation 생성 소스
export const RELATION_SOURCES = ['MANUAL', 'INFERRED', 'ROLLUP'] as const;

// 후보(Candidate) 상태
export const CANDIDATE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;

// Domain 소속 소스
export const DOMAIN_AFFINITY_SOURCES = [
  'MANUAL',
  'APPROVED_INFERENCE',
  'DISCOVERY',
] as const;

// Domain 종류
export const DOMAIN_KINDS = ['SEED', 'DISCOVERED'] as const;

// 커뮤니티 탐지 알고리즘
export const DISCOVERY_ALGOS = ['louvain', 'leiden'] as const;

// Rollup Generation 상태
export const GENERATION_STATUSES = ['BUILDING', 'ACTIVE', 'ARCHIVED'] as const;

// 지원 코드 언어 (AST 플러그인)
export const SUPPORTED_LANGUAGES = ['java', 'kotlin', 'typescript', 'javascript', 'python'] as const;

// Evidence 타입
export const EVIDENCE_TYPES = [
  'FILE',
  'CONFIG',
  'API_SPEC',
  'SCHEMA',
  'MANUAL',
] as const;

// AI 쿼리 모드
export const AI_MODES = ['STRICT', 'EXPLORE'] as const;

// 그래프 탐색 방향
export const GRAPH_DIRECTIONS = ['OUT', 'IN', 'BOTH'] as const;

// 기본 설정값
export const DEFAULTS = {
  MAX_HOPS: 6,
  MAX_VISITED: 20_000,
  QUERY_TIMEOUT_MS: 2_000,
  TOP_K_PATHS: 3,
  HUB_DEGREE_THRESHOLD: 200,
  RENDER_BATCH_SIZE: 200,
  SECONDARY_DOMAIN_THRESHOLD: 0.25,
  MIN_CLUSTER_SIZE: 3,
  HEURISTIC_DOMAIN_CAP: 0.3,
  DOMAIN_WEIGHT_CODE: 0.5,
  DOMAIN_WEIGHT_DB: 0.3,
  DOMAIN_WEIGHT_MSG: 0.2,
  EDGE_WEIGHT_CALL: 1.0,
  EDGE_WEIGHT_RW: 0.8,
  EDGE_WEIGHT_MSG: 0.6,
  EDGE_WEIGHT_FK: 0.4,
  EDGE_WEIGHT_CODE: 0.7,
  MAX_EVIDENCE_COUNT: 10,
} as const;

// Object Type별 카테고리 매핑
export const OBJECT_TYPE_CATEGORY: Record<
  (typeof OBJECT_TYPES)[number],
  (typeof OBJECT_CATEGORIES)[number] | 'META'
> = {
  service: 'COMPUTE',
  api_endpoint: 'COMPUTE',
  function: 'COMPUTE',
  database: 'STORAGE',
  db_table: 'STORAGE',
  db_view: 'STORAGE',
  cache_instance: 'STORAGE',
  cache_key: 'STORAGE',
  message_broker: 'CHANNEL',
  topic: 'CHANNEL',
  queue: 'CHANNEL',
  domain: 'META',
} as const;

// Object Type별 세분도 매핑
export const OBJECT_TYPE_GRANULARITY: Record<
  (typeof OBJECT_TYPES)[number],
  (typeof OBJECT_GRANULARITIES)[number]
> = {
  service: 'COMPOUND',
  api_endpoint: 'ATOMIC',
  function: 'ATOMIC',
  database: 'COMPOUND',
  db_table: 'ATOMIC',
  db_view: 'ATOMIC',
  cache_instance: 'COMPOUND',
  cache_key: 'ATOMIC',
  message_broker: 'COMPOUND',
  topic: 'ATOMIC',
  queue: 'ATOMIC',
  domain: 'COMPOUND',
} as const;

// Relation 타입별 Semantic Axis 매핑
export const RELATION_SEMANTICS: Record<
  (typeof RELATION_TYPES)[number],
  { interactionKind: (typeof INTERACTION_KINDS)[number]; direction: (typeof DIRECTIONS)[number] }
> = {
  call: { interactionKind: 'CONTROL', direction: 'OUT' },
  expose: { interactionKind: 'CONTROL', direction: 'IN' },
  read: { interactionKind: 'DATA', direction: 'IN' },
  write: { interactionKind: 'DATA', direction: 'OUT' },
  produce: { interactionKind: 'ASYNC', direction: 'OUT' },
  consume: { interactionKind: 'ASYNC', direction: 'IN' },
  depend_on: { interactionKind: 'STATIC', direction: 'OUT' },
  fk_reference: { interactionKind: 'DATA', direction: 'OUT' },
} as const;
