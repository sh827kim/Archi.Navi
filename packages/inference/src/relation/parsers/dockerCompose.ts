/**
 * docker-compose.yml 파서
 * depends_on, DB/Broker 이미지 정보 추출
 */
import yaml from 'js-yaml';

// DB 이미지 키워드 → DB 타입 매핑
const DB_IMAGE_KEYWORDS: Record<string, string> = {
  mysql: 'mysql',
  postgres: 'postgresql',
  mariadb: 'mariadb',
  mongo: 'mongodb',
};

// Broker 이미지 키워드 → Broker 타입 매핑
const BROKER_IMAGE_KEYWORDS: Record<string, string> = {
  kafka: 'kafka',
  rabbitmq: 'rabbitmq',
  redpanda: 'kafka', // redpanda는 Kafka-compatible
};

// 환경변수에서 DB 이름을 읽는 키 목록
const DB_NAME_ENV_KEYS = ['MYSQL_DATABASE', 'POSTGRES_DB', 'MARIADB_DATABASE'];

// Docker Compose 서비스 파싱 결과
export interface DockerComposeService {
  /** 서비스 이름 */
  name: string;
  /** 이미지 (없으면 null) */
  image: string | null;
  /** 의존하는 서비스 이름 목록 (depends_on) */
  dependsOn: string[];
  /** DB 정보 (DB 이미지인 경우) */
  dbInfo: { dbType: string; dbName: string | null } | null;
  /** Broker 정보 (Broker 이미지인 경우) */
  brokerInfo: { brokerType: string } | null;
}

// docker-compose.yml 파싱 결과
export interface DockerComposeSignal {
  /** 파싱된 서비스 목록 */
  services: DockerComposeService[];
  /** 원본 파일 경로 */
  filePath: string;
}

/**
 * 이미지 문자열에서 DB 타입 추출
 * 예: "mysql:8.0" → "mysql", "confluentinc/cp-kafka:7.0" → null
 */
function detectDbType(image: string): string | null {
  const normalized = image.toLowerCase();
  for (const [keyword, dbType] of Object.entries(DB_IMAGE_KEYWORDS)) {
    if (normalized.includes(keyword)) return dbType;
  }
  return null;
}

/**
 * 이미지 문자열에서 Broker 타입 추출
 * 예: "confluentinc/cp-kafka:7.0" → "kafka", "rabbitmq:3" → "rabbitmq"
 */
function detectBrokerType(image: string): string | null {
  const normalized = image.toLowerCase();
  for (const [keyword, brokerType] of Object.entries(BROKER_IMAGE_KEYWORDS)) {
    if (normalized.includes(keyword)) return brokerType;
  }
  return null;
}

/**
 * depends_on 파싱
 * 배열 형식: ["service-a", "service-b"]
 * 객체 형식: { "service-a": { condition: "service_healthy" } }
 */
function parseDependsOn(dependsOn: unknown): string[] {
  if (!dependsOn) return [];
  if (Array.isArray(dependsOn)) {
    return dependsOn.map((d) => String(d));
  }
  if (typeof dependsOn === 'object' && dependsOn !== null) {
    return Object.keys(dependsOn as Record<string, unknown>);
  }
  return [];
}

/**
 * 환경변수 맵에서 DB 이름 추출
 * 배열 형식: ["KEY=value", ...]
 * 객체 형식: { KEY: "value", ... }
 */
function extractDbName(
  environment: unknown,
): string | null {
  if (!environment) return null;

  const envMap: Record<string, string> = {};

  if (Array.isArray(environment)) {
    // "KEY=VALUE" 형식 파싱
    for (const entry of environment) {
      if (typeof entry === 'string') {
        const eqIdx = entry.indexOf('=');
        if (eqIdx !== -1) {
          envMap[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
        }
      }
    }
  } else if (typeof environment === 'object' && environment !== null) {
    const envObj = environment as Record<string, unknown>;
    for (const [key, value] of Object.entries(envObj)) {
      envMap[key] = String(value ?? '');
    }
  }

  // DB 이름 환경변수 확인
  for (const key of DB_NAME_ENV_KEYS) {
    if (envMap[key]) return envMap[key];
  }

  return null;
}

/**
 * docker-compose.yml 파싱
 * @param filePath - 원본 파일 경로 (evidence 저장용)
 * @param content - YAML 파일 내용
 * @returns 파싱된 신호, 파싱 실패 시 빈 결과 반환
 */
export function parseDockerCompose(filePath: string, content: string): DockerComposeSignal {
  const empty: DockerComposeSignal = { services: [], filePath };

  if (!content.trim()) return empty;

  let config: unknown;
  try {
    config = yaml.load(content);
  } catch {
    return empty;
  }

  if (!config || typeof config !== 'object') return empty;

  const root = config as Record<string, unknown>;

  // services 섹션 추출
  const servicesSection = root['services'] as Record<string, unknown> | null | undefined;
  if (!servicesSection || typeof servicesSection !== 'object') return empty;

  const services: DockerComposeService[] = [];

  for (const [serviceName, serviceConfig] of Object.entries(servicesSection)) {
    if (!serviceConfig || typeof serviceConfig !== 'object') continue;

    const svc = serviceConfig as Record<string, unknown>;
    const image = typeof svc['image'] === 'string' ? svc['image'] : null;
    const dependsOn = parseDependsOn(svc['depends_on']);

    let dbInfo: DockerComposeService['dbInfo'] = null;
    let brokerInfo: DockerComposeService['brokerInfo'] = null;

    if (image) {
      const dbType = detectDbType(image);
      if (dbType) {
        const dbName = extractDbName(svc['environment']);
        dbInfo = { dbType, dbName };
      } else {
        const brokerType = detectBrokerType(image);
        if (brokerType) {
          brokerInfo = { brokerType };
        }
      }
    }

    services.push({ name: serviceName, image, dependsOn, dbInfo, brokerInfo });
  }

  return { services, filePath };
}
