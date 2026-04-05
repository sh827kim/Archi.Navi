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
  /** zuul route 공통 IR 추출용 원시 route */
  zuulRoutes: Array<{
    routeKey: string;
    path: string;
    serviceId: string | null;
    url: string | null;
    stripPrefix: boolean | null;
    prefix: string | null;
    host: string | null;
    rewriteRegex: string | null;
    rewriteReplacement: string | null;
  }>;
  /** flatten된 config key/value */
  propertyEntries: Array<{
    key: string;
    value: string;
    source: 'bootstrap' | 'application';
  }>;
  /** spring.cloud.gateway.routes */
  springCloudGatewayRoutes: Array<{
    routeKey: string;
    path: string;
    stripPrefixCount: number | null;
    prefixPath: string | null;
    rewriteRegex: string | null;
    rewriteReplacement: string | null;
    uri: string | null;
  }>;
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

function collectStringEntries(
  value: unknown,
  prefix: string,
  output: AppYmlSignal['propertyEntries'],
  source: 'bootstrap' | 'application',
) {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized.length > 0) {
      output.push({ key: prefix, value: normalized, source });
    }
    return;
  }

  if (Array.isArray(value)) {
    const serialized = value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : String(entry).trim()))
      .filter((entry) => entry.length > 0)
      .join(',');
    if (serialized.length > 0) {
      output.push({ key: prefix, value: serialized, source });
    }
    return;
  }

  if (!value || typeof value !== 'object') return;

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    const nextPrefix = prefix.length > 0 ? `${prefix}.${key}` : key;
    collectStringEntries(nestedValue, nextPrefix, output, source);
  }
}

/**
 * application.yml 파싱
 * @param filePath - 원본 파일 경로 (evidence 저장용)
 * @param content - YAML 파일 내용
 * @returns 파싱된 신호, 파싱 실패 시 빈 신호 반환
 */
export function parseApplicationYml(filePath: string, content: string): AppYmlSignal {
  const propertyEntries: AppYmlSignal['propertyEntries'] = [];
  const propertySource = filePath.toLowerCase().includes('bootstrap')
    ? 'bootstrap'
    : 'application';
  // 기본 빈 결과 (파싱 실패 시 반환)
  const empty: AppYmlSignal = {
    serviceName: null,
    datasource: null,
    kafka: null,
    routeServiceIds: [],
    zuulRoutes: [],
    springCloudGatewayRoutes: [],
    propertyEntries,
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
  collectStringEntries(root, '', propertyEntries, propertySource);

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
  const zuulRoutes: AppYmlSignal['zuulRoutes'] = [];
  const zuul = root['zuul'] as Record<string, unknown> | null | undefined;
  const routes = zuul?.['routes'] as Record<string, unknown> | null | undefined;
  if (routes && typeof routes === 'object') {
    for (const [routeKey, routeValue] of Object.entries(routes)) {
      if (!routeValue || typeof routeValue !== 'object') continue;
      const routeObj = routeValue as Record<string, unknown>;
      const serviceId = routeObj['serviceId'] ?? routeObj['service-id'];
      const normalizedServiceId = typeof serviceId === 'string' && serviceId.trim().length > 0
        ? serviceId.trim()
        : null;
      if (normalizedServiceId && !routeServiceIds.includes(normalizedServiceId)) {
        routeServiceIds.push(normalizedServiceId);
      }

      const pathValue = routeObj['path'];
      if (typeof pathValue === 'string' && pathValue.trim().length > 0) {
        zuulRoutes.push({
          routeKey,
          path: pathValue.trim(),
          serviceId: normalizedServiceId,
          url: typeof routeObj['url'] === 'string' ? routeObj['url'].trim() : null,
          stripPrefix:
            typeof routeObj['stripPrefix'] === 'boolean'
              ? routeObj['stripPrefix']
              : typeof routeObj['strip-prefix'] === 'boolean'
                ? routeObj['strip-prefix']
                : null,
          prefix:
            typeof routeObj['prefix'] === 'string'
              ? routeObj['prefix'].trim()
              : typeof zuul?.['prefix'] === 'string'
                ? zuul['prefix'].trim()
                : null,
          host:
            typeof routeObj['host'] === 'string'
              ? routeObj['host'].trim()
              : null,
          rewriteRegex:
            typeof routeObj['rewriteRegex'] === 'string'
              ? routeObj['rewriteRegex'].trim()
              : typeof routeObj['rewrite-regex'] === 'string'
                ? routeObj['rewrite-regex'].trim()
                : null,
          rewriteReplacement:
            typeof routeObj['rewriteReplacement'] === 'string'
              ? routeObj['rewriteReplacement'].trim()
              : typeof routeObj['rewrite-replacement'] === 'string'
                ? routeObj['rewrite-replacement'].trim()
                : null,
        });
      }
    }
  }

  const springCloudGatewayRoutes: AppYmlSignal['springCloudGatewayRoutes'] = [];
  const cloud = toRecord(spring?.['cloud']);
  const gateway = toRecord(cloud?.['gateway']);
  const gatewayRoutes = gateway?.['routes'];
  const gatewayRoutePredicateEntries = gatewayRoutes && typeof gatewayRoutes === 'object' && !Array.isArray(gatewayRoutes)
    ? gatewayRoutes as Record<string, unknown>
    : null;

  if (Array.isArray(gatewayRoutes)) {
    for (const gatewayRouteValue of gatewayRoutes) {
      const routeObj = toRecord(gatewayRouteValue);
      if (!routeObj) continue;

      const routeKey = toStringValue(routeObj['id']);
      const uri = toStringValue(routeObj['uri']);
      const path = parseSpringCloudGatewayPathPredicate(toStringArray(routeObj['predicates']));
      if (!routeKey || !uri || !uri.startsWith('lb://') || !path) {
        continue;
      }

      springCloudGatewayRoutes.push({
        routeKey,
        path,
        stripPrefixCount: parseSpringCloudGatewayStripPrefix(toStringArray(routeObj['filters'])),
        prefixPath: parseSpringCloudGatewayPrefixPath(toStringArray(routeObj['filters'])),
        rewriteRegex: parseSpringCloudGatewayRewriteRegex(toStringArray(routeObj['filters'])),
        rewriteReplacement: parseSpringCloudGatewayRewriteReplacement(toStringArray(routeObj['filters'])),
        uri,
      });
    }
  } else if (gatewayRoutePredicateEntries) {
    for (const [routeKey, routeValue] of Object.entries(gatewayRoutePredicateEntries)) {
      const routeObj = toRecord(routeValue);
      if (!routeObj) continue;

      const uri = toStringValue(routeObj['uri']);
      const path = parseSpringCloudGatewayPathPredicate(toStringArray(routeObj['predicates']));
      if (!uri || !uri.startsWith('lb://') || !path) {
        continue;
      }

      springCloudGatewayRoutes.push({
        routeKey,
        path,
        stripPrefixCount: parseSpringCloudGatewayStripPrefix(toStringArray(routeObj['filters'])),
        prefixPath: parseSpringCloudGatewayPrefixPath(toStringArray(routeObj['filters'])),
        rewriteRegex: parseSpringCloudGatewayRewriteRegex(toStringArray(routeObj['filters'])),
        rewriteReplacement: parseSpringCloudGatewayRewriteReplacement(toStringArray(routeObj['filters'])),
        uri,
      });
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

  return {
    serviceName,
    datasource,
    kafka,
    routeServiceIds,
    zuulRoutes,
    springCloudGatewayRoutes,
    propertyEntries,
    serverPort,
    contextPath,
    filePath,
  };
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toStringValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === 'string' ? entry : String(entry))).filter((entry) => entry.trim().length > 0);
}

function parseSpringCloudGatewayPathPredicate(predicates: string[]): string | null {
  for (const predicate of predicates) {
    const normalized = predicate.trim();
    if (!normalized.startsWith('Path=')) continue;
    const path = normalized.slice('Path='.length).trim();
    if (!path) continue;
    return path;
  }
  return null;
}

function parseSpringCloudGatewayFilters(filters: string[]): string[] {
  return filters.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function parseSpringCloudGatewayStripPrefix(filters: string[]): number | null {
  for (const filter of parseSpringCloudGatewayFilters(filters)) {
    if (!filter.startsWith('StripPrefix=')) continue;
    const value = toStringValue(filter.slice('StripPrefix='.length));
    if (!value) continue;
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 0) continue;
    return parsed;
  }
  return null;
}

function parseSpringCloudGatewayPrefixPath(filters: string[]): string | null {
  for (const filter of parseSpringCloudGatewayFilters(filters)) {
    if (!filter.startsWith('PrefixPath=')) continue;
    const value = toStringValue(filter.slice('PrefixPath='.length));
    if (!value) continue;
    return value;
  }
  return null;
}

function parseSpringCloudGatewayRewriteRegex(filters: string[]): string | null {
  return parseSpringCloudGatewayRewrite(filters)?.regex ?? null;
}

function parseSpringCloudGatewayRewriteReplacement(filters: string[]): string | null {
  return parseSpringCloudGatewayRewrite(filters)?.replacement ?? null;
}

function parseSpringCloudGatewayRewrite(filters: string[]): { regex: string; replacement: string } | null {
  for (const filter of parseSpringCloudGatewayFilters(filters)) {
    if (!filter.startsWith('RewritePath=')) continue;
    const raw = filter.slice('RewritePath='.length).trim();
    const commaIndex = raw.indexOf(',');
    if (commaIndex <= 0) continue;
    const regex = toStringValue(raw.slice(0, commaIndex));
    const replacement = toStringValue(raw.slice(commaIndex + 1));
    if (!regex || !replacement) continue;
    return { regex, replacement };
  }
  return null;
}
