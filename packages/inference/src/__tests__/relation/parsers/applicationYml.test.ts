/**
 * application.yml 파서 단위 테스트
 */
import { describe, it, expect } from 'vitest';
import { parseApplicationYml } from '../../../relation/parsers/applicationYml';

describe('parseApplicationYml', () => {
  // ─── 정상 케이스 ────────────────────────────────────────────────────────────

  it('datasource + kafka 모두 있는 경우 모든 필드를 올바르게 파싱해야 한다', () => {
    const yaml = `
spring:
  application:
    name: order-service
  datasource:
    url: jdbc:mysql://db-host:3306/order_db
  kafka:
    bootstrap-servers: kafka:9092
    consumer:
      group-id: order-group
      topics: order.created, payment.completed
    producer:
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
server:
  port: 8080
  servlet:
    context-path: /api/orders
`;
    const result = parseApplicationYml('/path/to/application.yml', yaml);

    expect(result.serviceName).toBe('order-service');
    expect(result.datasource).toMatchObject({
      url: 'jdbc:mysql://db-host:3306/order_db',
      dbType: 'mysql',
      host: 'db-host',
      port: 3306,
      dbName: 'order_db',
    });
    expect(result.kafka).toMatchObject({
      bootstrapServers: 'kafka:9092',
      consumerGroupId: 'order-group',
      consumerTopics: ['order.created', 'payment.completed'],
      hasProducer: true,
    });
    expect(result.serverPort).toBe(8080);
    expect(result.contextPath).toBe('/api/orders');
    expect(result.filePath).toBe('/path/to/application.yml');
  });

  it('datasource만 있는 경우 kafka는 null이어야 한다', () => {
    const yaml = `
spring:
  application:
    name: user-service
  datasource:
    url: jdbc:postgresql://postgres:5432/user_db
`;
    const result = parseApplicationYml('/app/application.yml', yaml);

    expect(result.serviceName).toBe('user-service');
    expect(result.datasource).toMatchObject({
      dbType: 'postgresql',
      host: 'postgres',
      port: 5432,
      dbName: 'user_db',
    });
    expect(result.kafka).toBeNull();
  });

  it('kafka만 있는 경우 datasource는 null이어야 한다', () => {
    const yaml = `
spring:
  kafka:
    bootstrap-servers: kafka-broker:9092
    consumer:
      group-id: notification-group
`;
    const result = parseApplicationYml('/app/application.yml', yaml);

    expect(result.datasource).toBeNull();
    expect(result.kafka).toMatchObject({
      bootstrapServers: 'kafka-broker:9092',
      consumerGroupId: 'notification-group',
      consumerTopics: [],
      hasProducer: false,
    });
  });

  // ─── JDBC URL 파싱 ────────────────────────────────────────────────────────────

  it('PostgreSQL JDBC URL을 올바르게 파싱해야 한다', () => {
    const yaml = `
spring:
  datasource:
    url: jdbc:postgresql://pg-host:5432/my_db
`;
    const result = parseApplicationYml('', yaml);
    expect(result.datasource?.dbType).toBe('postgresql');
    expect(result.datasource?.host).toBe('pg-host');
    expect(result.datasource?.port).toBe(5432);
    expect(result.datasource?.dbName).toBe('my_db');
  });

  it('MariaDB JDBC URL을 올바르게 파싱해야 한다', () => {
    const yaml = `
spring:
  datasource:
    url: jdbc:mariadb://mariadb-host/inventory_db
`;
    const result = parseApplicationYml('', yaml);
    expect(result.datasource?.dbType).toBe('mariadb');
    expect(result.datasource?.host).toBe('mariadb-host');
    expect(result.datasource?.port).toBe(3306); // 기본 포트
    expect(result.datasource?.dbName).toBe('inventory_db');
  });

  it('mssql JDBC URL은 sqlserver로 정규화해야 한다', () => {
    const yaml = `
spring:
  datasource:
    url: jdbc:mssql://mssql-host:1433/order_db
`;
    const result = parseApplicationYml('', yaml);
    expect(result.datasource?.dbType).toBe('sqlserver');
    expect(result.datasource?.port).toBe(1433);
  });

  it('알 수 없는 JDBC 타입은 unknown으로 파싱해야 한다', () => {
    const yaml = `
spring:
  datasource:
    url: jdbc:sqlite://localhost/test_db
`;
    const result = parseApplicationYml('', yaml);
    expect(result.datasource?.dbType).toBe('unknown');
  });

  // ─── Kafka topics 파싱 ───────────────────────────────────────────────────────

  it('topics가 배열 형식인 경우를 올바르게 파싱해야 한다', () => {
    const yaml = `
spring:
  kafka:
    bootstrap-servers: kafka:9092
    consumer:
      group-id: payment-group
      topics:
        - payment.created
        - payment.completed
`;
    const result = parseApplicationYml('', yaml);
    expect(result.kafka?.consumerTopics).toEqual(['payment.created', 'payment.completed']);
  });

  it('topics가 지원하지 않는 타입이면 빈 배열이어야 한다', () => {
    const yaml = `
spring:
  kafka:
    bootstrap-servers: kafka:9092
    consumer:
      topics: 12345
`;
    const result = parseApplicationYml('', yaml);
    expect(result.kafka?.consumerTopics).toEqual([]);
  });

  it('listener.topics 경로도 지원해야 한다', () => {
    const yaml = `
spring:
  kafka:
    bootstrap-servers: kafka:9092
    listener:
      topics: order.events
`;
    const result = parseApplicationYml('', yaml);
    expect(result.kafka?.consumerTopics).toEqual(['order.events']);
  });

  it('producer만 있고 consumer가 없는 경우 hasProducer=true이어야 한다', () => {
    const yaml = `
spring:
  kafka:
    bootstrap-servers: kafka:9092
    producer:
      value-serializer: org.springframework.kafka.support.serializer.JsonSerializer
`;
    const result = parseApplicationYml('', yaml);
    expect(result.kafka?.hasProducer).toBe(true);
    expect(result.kafka?.consumerTopics).toEqual([]);
  });

  it('zuul.routes.*.serviceId를 서비스 의존 후보로 파싱해야 한다', () => {
    const yaml = `
spring:
  application:
    name: api-gateway
zuul:
  routes:
    article:
      path: /articles/**
      serviceId: article-service
    author:
      path: /authors/**
      serviceId: author-service
`;
    const result = parseApplicationYml('/app/application.yml', yaml);
    expect(result.routeServiceIds).toEqual(['article-service', 'author-service']);
  });

  // ─── 엣지 케이스 ─────────────────────────────────────────────────────────────

  it('spring.profiles.active가 있어도 동일 파일의 설정은 정상 파싱해야 한다', () => {
    // 파서는 profiles 분기를 하지 않고 단순 YAML 파싱 — profile별 파일은 개별 탐색으로 처리
    const yaml = `
spring:
  profiles:
    active: prod
  application:
    name: order-service
  datasource:
    url: jdbc:mysql://db-host:3306/order_db
`;
    const result = parseApplicationYml('/path/application.yml', yaml);
    // profiles 설정이 있어도 같은 파일의 다른 설정은 정상 파싱
    expect(result.serviceName).toBe('order-service');
    expect(result.datasource?.dbType).toBe('mysql');
    expect(result.datasource?.host).toBe('db-host');
  });

  it('빈 YAML 문자열은 빈 결과를 반환해야 한다', () => {
    const result = parseApplicationYml('/path', '');
    expect(result.serviceName).toBeNull();
    expect(result.datasource).toBeNull();
    expect(result.kafka).toBeNull();
    expect(result.routeServiceIds).toEqual([]);
  });

  it('잘못된 YAML 형식은 빈 결과를 반환해야 한다', () => {
    const result = parseApplicationYml('/path', '{{ invalid: yaml: content');
    expect(result.serviceName).toBeNull();
    expect(result.datasource).toBeNull();
    expect(result.kafka).toBeNull();
    expect(result.routeServiceIds).toEqual([]);
  });

  it('spring 섹션 없이 다른 설정만 있는 경우 빈 결과를 반환해야 한다', () => {
    const yaml = `
logging:
  level:
    root: INFO
`;
    const result = parseApplicationYml('/path', yaml);
    expect(result.serviceName).toBeNull();
    expect(result.datasource).toBeNull();
    expect(result.kafka).toBeNull();
    expect(result.routeServiceIds).toEqual([]);
  });

  it('spring.kafka.bootstrap-servers 없이 consumer 설정만 있으면 kafka가 null이어야 한다', () => {
    const yaml = `
spring:
  kafka:
    consumer:
      group-id: my-group
`;
    const result = parseApplicationYml('', yaml);
    // bootstrap-servers가 없으면 kafka 추론 불가
    expect(result.kafka).toBeNull();
  });

  it('datasource.url이 문자열이 아니면 datasource는 null이어야 한다', () => {
    const yaml = `
spring:
  datasource:
    url:
      nested: true
`;
    const result = parseApplicationYml('/path', yaml);
    expect(result.datasource).toBeNull();
  });

  it('filePath를 올바르게 보존해야 한다', () => {
    const result = parseApplicationYml('/services/order/src/main/resources/application.yml', '');
    expect(result.filePath).toBe('/services/order/src/main/resources/application.yml');
  });
});
