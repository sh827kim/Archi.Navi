/**
 * application.yml 파서
 * Spring Boot 설정 파일에서 DB/Kafka 연결 정보를 추출하여 Relation 추론에 사용
 */
import yaml from 'js-yaml';

// JDBC URL에서 추출한 DB 연결 정보
export interface DatasourceInfo {
  /** JDBC URL 원문 */
  url: string;
  /** DB 종류 (mysql, postgresql, mariadb, oracle, sqlserver) */
  dbType: 'mysql' | 'postgresql' | 'mariadb' | 'oracle' | 'sqlserver' | 'unknown';
  /** DB 호스트 */
  host: string;
  /** DB 포트 */
  port: number;
  /** DB 이름 */
  dbName: string;
}

// Kafka 연결 정보
export interface KafkaInfo {
  /** bootstrap-servers 값 (예: "kafka:9092") */
  bootstrapServers: string;
  /** consumer group-id */
  consumerGroupId: string | null;
  /** consumer가 구독하는 토픽 목록 */
  consumerTopics: string[];
  /** producer 설정 존재 여부 */
  hasProducer: boolean;
}

// application.yml 파싱 결과
export interface AppYmlSignal {
  /** spring.application.name - 서비스 매칭용 */
  serviceName: string | null;
  /** spring.datasource 설정 */
  datasource: DatasourceInfo | null;
  /** spring.kafka 설정 */
  kafka: KafkaInfo | null;
  /** zuul.routes.*.serviceId 목록 */
  routeServiceIds: string[];
  /** server.port */
  serverPort: number | null;
  /** server.servlet.context-path */
  contextPath: string | null;
  /** 원본 파일 경로 */
  filePath: string;
}

/**
 * JDBC URL을 파싱하여 DB 연결 정보 추출
 * 예: jdbc:mysql://db-host:3306/order_db → { dbType: 'mysql', host: 'db-host', port: 3306, dbName: 'order_db' }
 */
function parseJdbcUrl(url: string): Omit<DatasourceInfo, 'url'> | null {
  // jdbc:{type}://{host}:{port}/{dbName} 형태 파싱
  const match = url.match(
    /^jdbc:([a-zA-Z0-9]+):\/\/([^/:]+)(?::(\d+))?\/?([^?]*)/,
  );
  if (!match) return null;

  const rawType = match[1]?.toLowerCase() ?? 'unknown';
  const host = match[2] ?? 'localhost';
  const portStr = match[3];
  const dbName = match[4]?.split('/')[0] ?? '';

  // DB 타입 정규화
  const dbType = normalizeDbType(rawType);

  // 기본 포트
  const defaultPorts: Record<string, number> = {
    mysql: 3306,
    postgresql: 5432,
    mariadb: 3306,
    oracle: 1521,
    sqlserver: 1433,
  };
  const port = portStr ? parseInt(portStr, 10) : (defaultPorts[dbType] ?? 5432);

  return { dbType, host, port, dbName };
}

/** DB 타입 이름 정규화 */
function normalizeDbType(raw: string): DatasourceInfo['dbType'] {
  if (raw === 'mysql') return 'mysql';
  if (raw === 'postgresql' || raw === 'postgres') return 'postgresql';
  if (raw === 'mariadb') return 'mariadb';
  if (raw === 'oracle') return 'oracle';
  if (raw === 'sqlserver' || raw === 'mssql') return 'sqlserver';
  return 'unknown';
}

/**
 * Kafka consumer topics 추출
 * topics는 문자열 또는 배열 형태로 올 수 있음
 */
function extractTopics(topics: unknown): string[] {
  if (!topics) return [];
  if (typeof topics === 'string') {
    // 쉼표로 구분된 문자열 처리 (예: "order.created, payment.completed")
    return topics
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  if (Array.isArray(topics)) {
    return topics.map((t) => String(t).trim()).filter((t) => t.length > 0);
  }
  return [];
}

/**
 * application.yml 파싱
 * @param filePath - 원본 파일 경로 (evidence 저장용)
 * @param content - YAML 파일 내용
 * @returns 파싱된 신호, 파싱 실패 시 빈 신호 반환
 */
export function parseApplicationYml(filePath: string, content: string): AppYmlSignal {
  // 기본 빈 결과 (파싱 실패 시 반환)
  const empty: AppYmlSignal = {
    serviceName: null,
    datasource: null,
    kafka: null,
    routeServiceIds: [],
    serverPort: null,
    contextPath: null,
    filePath,
  };

  if (!content.trim()) return empty;

  let config: unknown;
  try {
    config = yaml.load(content);
  } catch {
    // 잘못된 YAML → 빈 결과 반환
    return empty;
  }

  if (!config || typeof config !== 'object') return empty;

  const root = config as Record<string, unknown>;

  // spring 설정 파싱
  const spring = root['spring'] as Record<string, unknown> | null | undefined;
  const server = root['server'] as Record<string, unknown> | null | undefined;

  // spring.application.name
  const appSection = spring?.['application'] as Record<string, unknown> | null | undefined;
  const serviceName =
    typeof appSection?.['name'] === 'string' ? appSection['name'] : null;

  // spring.datasource.url
  let datasource: DatasourceInfo | null = null;
  const dsSection = spring?.['datasource'] as Record<string, unknown> | null | undefined;
  if (dsSection?.['url'] && typeof dsSection['url'] === 'string') {
    const parsed = parseJdbcUrl(dsSection['url']);
    if (parsed) {
      datasource = { url: dsSection['url'], ...parsed };
    }
  }

  // spring.kafka 설정
  let kafka: KafkaInfo | null = null;
  const kafkaSection = spring?.['kafka'] as Record<string, unknown> | null | undefined;
  if (kafkaSection) {
    const bootstrapServers =
      typeof kafkaSection['bootstrap-servers'] === 'string'
        ? kafkaSection['bootstrap-servers']
        : null;

    if (bootstrapServers) {
      // consumer 설정
      const consumerSection = kafkaSection['consumer'] as
        | Record<string, unknown>
        | null
        | undefined;
      const consumerGroupId =
        typeof consumerSection?.['group-id'] === 'string'
          ? consumerSection['group-id']
          : null;

      // consumer topics: spring.kafka.consumer.topics 또는 spring.kafka.listener.topics
      const listenerSection = kafkaSection['listener'] as
        | Record<string, unknown>
        | null
        | undefined;
      const consumerTopics = extractTopics(
        consumerSection?.['topics'] ?? listenerSection?.['topics'],
      );

      // producer 설정 존재 여부
      const producerSection = kafkaSection['producer'] as
        | Record<string, unknown>
        | null
        | undefined;
      const hasProducer = !!producerSection;

      kafka = { bootstrapServers, consumerGroupId, consumerTopics, hasProducer };
    }
  }

  // zuul.routes.*.serviceId
  const routeServiceIds: string[] = [];
  const zuul = root['zuul'] as Record<string, unknown> | null | undefined;
  const routes = zuul?.['routes'] as Record<string, unknown> | null | undefined;
  if (routes && typeof routes === 'object') {
    for (const routeValue of Object.values(routes)) {
      if (!routeValue || typeof routeValue !== 'object') continue;
      const routeObj = routeValue as Record<string, unknown>;
      const serviceId = routeObj['serviceId'];
      if (typeof serviceId !== 'string') continue;
      const normalized = serviceId.trim();
      if (normalized.length === 0) continue;
      if (!routeServiceIds.includes(normalized)) routeServiceIds.push(normalized);
    }
  }

  // server.port
  const serverPort =
    typeof server?.['port'] === 'number' ? server['port'] : null;

  // server.servlet.context-path
  const servletSection = server?.['servlet'] as
    | Record<string, unknown>
    | null
    | undefined;
  const contextPath =
    typeof servletSection?.['context-path'] === 'string'
      ? servletSection['context-path']
      : null;

  return { serviceName, datasource, kafka, routeServiceIds, serverPort, contextPath, filePath };
}
