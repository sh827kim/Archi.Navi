/**
 * docker-compose.yml 파서 단위 테스트
 */
import { describe, it, expect } from 'vitest';
import { parseDockerCompose } from '../../../relation/parsers/dockerCompose';

describe('parseDockerCompose', () => {
  // ─── 정상 케이스 ────────────────────────────────────────────────────────────

  it('depends_on + DB + Broker 모두 있는 경우를 올바르게 파싱해야 한다', () => {
    const yaml = `
version: '3.8'
services:
  order-service:
    image: order-service:latest
    depends_on:
      - mysql-db
      - kafka
  mysql-db:
    image: mysql:8.0
    environment:
      MYSQL_DATABASE: order_db
  kafka:
    image: confluentinc/cp-kafka:7.0
`;
    const result = parseDockerCompose('/project/docker-compose.yml', yaml);

    expect(result.services).toHaveLength(3);

    const orderService = result.services.find((s) => s.name === 'order-service');
    expect(orderService?.dependsOn).toEqual(['mysql-db', 'kafka']);
    expect(orderService?.dbInfo).toBeNull();
    expect(orderService?.brokerInfo).toBeNull();

    const mysqlService = result.services.find((s) => s.name === 'mysql-db');
    expect(mysqlService?.dbInfo).toMatchObject({ dbType: 'mysql', dbName: 'order_db' });

    const kafkaService = result.services.find((s) => s.name === 'kafka');
    expect(kafkaService?.brokerInfo).toMatchObject({ brokerType: 'kafka' });
  });

  it('depends_on 배열 형식을 올바르게 파싱해야 한다', () => {
    const yaml = `
services:
  app:
    image: myapp:1.0
    depends_on:
      - db
      - redis
`;
    const result = parseDockerCompose('', yaml);
    const app = result.services.find((s) => s.name === 'app');
    expect(app?.dependsOn).toEqual(['db', 'redis']);
  });

  it('depends_on 객체 형식(condition 포함)을 올바르게 파싱해야 한다', () => {
    const yaml = `
services:
  api:
    image: api:latest
    depends_on:
      postgres:
        condition: service_healthy
      kafka:
        condition: service_started
`;
    const result = parseDockerCompose('', yaml);
    const api = result.services.find((s) => s.name === 'api');
    expect(api?.dependsOn).toContain('postgres');
    expect(api?.dependsOn).toContain('kafka');
  });

  // ─── DB 이미지 분류 ───────────────────────────────────────────────────────────

  it('MySQL 이미지를 database로 분류해야 한다', () => {
    const yaml = `
services:
  db:
    image: mysql:8.0
    environment:
      MYSQL_DATABASE: mydb
`;
    const result = parseDockerCompose('', yaml);
    expect(result.services[0]?.dbInfo?.dbType).toBe('mysql');
    expect(result.services[0]?.dbInfo?.dbName).toBe('mydb');
  });

  it('PostgreSQL 이미지를 database로 분류해야 한다', () => {
    const yaml = `
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: payment_db
`;
    const result = parseDockerCompose('', yaml);
    expect(result.services[0]?.dbInfo?.dbType).toBe('postgresql');
    expect(result.services[0]?.dbInfo?.dbName).toBe('payment_db');
  });

  it('MariaDB 이미지를 database로 분류해야 한다', () => {
    const yaml = `
services:
  mariadb:
    image: mariadb:10.6
    environment:
      MARIADB_DATABASE: user_db
`;
    const result = parseDockerCompose('', yaml);
    expect(result.services[0]?.dbInfo?.dbType).toBe('mariadb');
  });

  // ─── Broker 이미지 분류 ────────────────────────────────────────────────────────

  it('Kafka 이미지를 message_broker로 분류해야 한다', () => {
    const yaml = `
services:
  kafka:
    image: confluentinc/cp-kafka:7.0
`;
    const result = parseDockerCompose('', yaml);
    expect(result.services[0]?.brokerInfo?.brokerType).toBe('kafka');
  });

  it('RabbitMQ 이미지를 message_broker로 분류해야 한다', () => {
    const yaml = `
services:
  rabbitmq:
    image: rabbitmq:3-management
`;
    const result = parseDockerCompose('', yaml);
    expect(result.services[0]?.brokerInfo?.brokerType).toBe('rabbitmq');
  });

  it('Redpanda 이미지를 kafka 타입 broker로 분류해야 한다', () => {
    const yaml = `
services:
  redpanda:
    image: redpandadata/redpanda:v23.1.13
`;
    const result = parseDockerCompose('', yaml);
    expect(result.services[0]?.brokerInfo?.brokerType).toBe('kafka');
  });

  // ─── 환경변수 형식 ─────────────────────────────────────────────────────────────

  it('환경변수 배열 형식에서 DB 이름을 추출해야 한다', () => {
    const yaml = `
services:
  db:
    image: mysql:8.0
    environment:
      - MYSQL_DATABASE=inventory
      - MYSQL_ROOT_PASSWORD=secret
`;
    const result = parseDockerCompose('', yaml);
    expect(result.services[0]?.dbInfo?.dbName).toBe('inventory');
  });

  // ─── 엣지 케이스 ─────────────────────────────────────────────────────────────

  it('빈 YAML은 빈 결과를 반환해야 한다', () => {
    const result = parseDockerCompose('/path', '');
    expect(result.services).toHaveLength(0);
  });

  it('잘못된 YAML은 빈 결과를 반환해야 한다', () => {
    const result = parseDockerCompose('/path', '{{ invalid yaml');
    expect(result.services).toHaveLength(0);
  });

  it('services 섹션 없는 YAML은 빈 결과를 반환해야 한다', () => {
    const yaml = `
version: '3.8'
networks:
  default:
    driver: bridge
`;
    const result = parseDockerCompose('/path', yaml);
    expect(result.services).toHaveLength(0);
  });

  it('depends_on 없는 서비스는 빈 배열을 반환해야 한다', () => {
    const yaml = `
services:
  standalone:
    image: standalone:latest
`;
    const result = parseDockerCompose('', yaml);
    expect(result.services[0]?.dependsOn).toEqual([]);
  });

  it('filePath를 올바르게 보존해야 한다', () => {
    const result = parseDockerCompose('/project/docker-compose.prod.yml', '');
    expect(result.filePath).toBe('/project/docker-compose.prod.yml');
  });
});
