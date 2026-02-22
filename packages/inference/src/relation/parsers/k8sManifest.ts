/**
 * Kubernetes manifest 파서
 * Deployment 리소스에서 환경변수 기반 DB/Kafka 연결 정보 추출
 */
import yaml from 'js-yaml';

// DB URL 환경변수 키 목록
const DB_URL_ENV_KEYS = ['DB_URL', 'DATABASE_URL', 'JDBC_URL', 'DB_CONNECTION_URL'];

// Kafka Broker 환경변수 키 목록
const KAFKA_BROKER_ENV_KEYS = [
  'KAFKA_BROKERS',
  'KAFKA_BOOTSTRAP_SERVERS',
  'KAFKA_SERVER',
  'SPRING_KAFKA_BOOTSTRAP_SERVERS',
];

// K8s manifest 파싱 결과
export interface K8sSignal {
  /** metadata.name (서비스명 매칭용) */
  serviceName: string | null;
  /** 발견된 DB URL 목록 */
  dbUrls: string[];
  /** 발견된 Kafka Broker 주소 목록 */
  kafkaBrokers: string[];
  /** 원본 파일 경로 */
  filePath: string;
}

// K8s 환경변수 항목
interface K8sEnvItem {
  name: string;
  value?: string;
}

/**
 * K8s 컨테이너 spec에서 env 배열 추출
 */
function extractEnvVars(containers: unknown[]): K8sEnvItem[] {
  const result: K8sEnvItem[] = [];
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    const c = container as Record<string, unknown>;
    const env = c['env'];
    if (!Array.isArray(env)) continue;

    for (const item of env) {
      if (!item || typeof item !== 'object') continue;
      const e = item as Record<string, unknown>;
      if (typeof e['name'] === 'string') {
        const item: K8sEnvItem =
          typeof e['value'] === 'string'
            ? { name: e['name'], value: e['value'] }
            : { name: e['name'] };
        result.push(item);
      }
    }
  }
  return result;
}

/**
 * K8s manifest YAML 파싱 (단일 문서)
 * @param filePath - 원본 파일 경로
 * @param content - YAML 파일 내용 (단일 또는 멀티 문서)
 * @returns 파싱된 신호 목록 (각 Deployment별 신호)
 */
export function parseK8sManifest(filePath: string, content: string): K8sSignal[] {
  if (!content.trim()) return [];

  let documents: unknown[];
  try {
    // K8s 파일은 멀티 YAML 문서(---)를 포함할 수 있음
    documents = yaml.loadAll(content);
  } catch {
    return [];
  }

  const signals: K8sSignal[] = [];

  for (const doc of documents) {
    if (!doc || typeof doc !== 'object') continue;

    const manifest = doc as Record<string, unknown>;

    // Deployment만 처리
    if (manifest['kind'] !== 'Deployment') continue;

    // metadata.name 추출
    const metadata = manifest['metadata'] as Record<string, unknown> | null | undefined;
    const serviceName =
      typeof metadata?.['name'] === 'string' ? metadata['name'] : null;

    // spec.template.spec.containers 추출
    const spec = manifest['spec'] as Record<string, unknown> | null | undefined;
    const template = spec?.['template'] as Record<string, unknown> | null | undefined;
    const podSpec = template?.['spec'] as Record<string, unknown> | null | undefined;
    const containers = podSpec?.['containers'];
    const containerList = Array.isArray(containers) ? containers : [];

    const envVars = extractEnvVars(containerList);

    // DB URL 환경변수 탐색
    const dbUrls: string[] = [];
    for (const env of envVars) {
      if (DB_URL_ENV_KEYS.includes(env.name) && env.value) {
        dbUrls.push(env.value);
      }
    }

    // Kafka Broker 환경변수 탐색
    const kafkaBrokers: string[] = [];
    for (const env of envVars) {
      if (KAFKA_BROKER_ENV_KEYS.includes(env.name) && env.value) {
        kafkaBrokers.push(env.value);
      }
    }

    // 발견된 정보가 있는 경우만 포함
    if (dbUrls.length > 0 || kafkaBrokers.length > 0) {
      signals.push({ serviceName, dbUrls, kafkaBrokers, filePath });
    }
  }

  return signals;
}
