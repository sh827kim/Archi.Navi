/**
 * K8s manifest 파서 단위 테스트
 */
import { describe, it, expect } from 'vitest';
import { parseK8sManifest } from '../../../relation/parsers/k8sManifest';

describe('parseK8sManifest', () => {
  // ─── 정상 케이스 ────────────────────────────────────────────────────────────

  it('DB_URL + KAFKA_BROKERS 환경변수가 있는 Deployment를 파싱해야 한다', () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
spec:
  template:
    spec:
      containers:
        - name: order-service
          image: order-service:latest
          env:
            - name: DB_URL
              value: jdbc:mysql://db-host:3306/order_db
            - name: KAFKA_BROKERS
              value: kafka:9092
`;
    const signals = parseK8sManifest('/k8s/order-deployment.yml', yaml);

    expect(signals).toHaveLength(1);
    const signal = signals[0]!;
    expect(signal.serviceName).toBe('order-service');
    expect(signal.dbUrls).toEqual(['jdbc:mysql://db-host:3306/order_db']);
    expect(signal.kafkaBrokers).toEqual(['kafka:9092']);
    expect(signal.filePath).toBe('/k8s/order-deployment.yml');
  });

  it('DATABASE_URL 환경변수를 인식해야 한다', () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
spec:
  template:
    spec:
      containers:
        - name: app
          env:
            - name: DATABASE_URL
              value: postgresql://pg-host:5432/payment_db
`;
    const signals = parseK8sManifest('', yaml);
    expect(signals[0]?.dbUrls).toEqual(['postgresql://pg-host:5432/payment_db']);
  });

  it('KAFKA_BOOTSTRAP_SERVERS 환경변수를 인식해야 한다', () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inventory-service
spec:
  template:
    spec:
      containers:
        - name: app
          env:
            - name: KAFKA_BOOTSTRAP_SERVERS
              value: kafka1:9092,kafka2:9092
`;
    const signals = parseK8sManifest('', yaml);
    expect(signals[0]?.kafkaBrokers).toEqual(['kafka1:9092,kafka2:9092']);
  });

  it('SPRING_KAFKA_BOOTSTRAP_SERVERS 환경변수를 인식해야 한다', () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: notification-service
spec:
  template:
    spec:
      containers:
        - name: app
          env:
            - name: SPRING_KAFKA_BOOTSTRAP_SERVERS
              value: kafka:9092
`;
    const signals = parseK8sManifest('', yaml);
    expect(signals[0]?.kafkaBrokers).toEqual(['kafka:9092']);
  });

  // ─── 멀티 문서 (---) 처리 ─────────────────────────────────────────────────────

  it('멀티 YAML 문서에서 Deployment만 파싱해야 한다', () => {
    const yaml = `
apiVersion: v1
kind: Service
metadata:
  name: order-service
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
spec:
  template:
    spec:
      containers:
        - name: app
          env:
            - name: DB_URL
              value: jdbc:mysql://db:3306/orders
`;
    const signals = parseK8sManifest('', yaml);
    // Service kind는 무시되고 Deployment만 파싱
    expect(signals).toHaveLength(1);
    expect(signals[0]?.serviceName).toBe('order-service');
    expect(signals[0]?.dbUrls).toHaveLength(1);
  });

  // ─── 비-Deployment 리소스 무시 ────────────────────────────────────────────────

  it('kind: Service는 무시해야 한다', () => {
    const yaml = `
apiVersion: v1
kind: Service
metadata:
  name: order-service
spec:
  ports:
    - port: 8080
`;
    const signals = parseK8sManifest('', yaml);
    expect(signals).toHaveLength(0);
  });

  it('kind: ConfigMap은 무시해야 한다', () => {
    const yaml = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  DB_URL: jdbc:mysql://db:3306/mydb
`;
    const signals = parseK8sManifest('', yaml);
    expect(signals).toHaveLength(0);
  });

  // ─── 관련 환경변수 없는 경우 ───────────────────────────────────────────────────

  it('DB/Kafka 환경변수가 없는 Deployment는 신호를 생성하지 않아야 한다', () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: simple-service
spec:
  template:
    spec:
      containers:
        - name: app
          env:
            - name: LOG_LEVEL
              value: INFO
`;
    const signals = parseK8sManifest('', yaml);
    expect(signals).toHaveLength(0);
  });

  it('env 섹션이 없는 Deployment는 신호를 생성하지 않아야 한다', () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: no-env-service
spec:
  template:
    spec:
      containers:
        - name: app
          image: myapp:latest
`;
    const signals = parseK8sManifest('', yaml);
    expect(signals).toHaveLength(0);
  });

  // ─── 엣지 케이스 ─────────────────────────────────────────────────────────────

  it('빈 YAML은 빈 배열을 반환해야 한다', () => {
    const signals = parseK8sManifest('/path', '');
    expect(signals).toHaveLength(0);
  });

  it('잘못된 YAML은 빈 배열을 반환해야 한다', () => {
    const signals = parseK8sManifest('/path', '{{ invalid yaml');
    expect(signals).toHaveLength(0);
  });

  it('filePath를 올바르게 보존해야 한다', () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: svc
spec:
  template:
    spec:
      containers:
        - name: app
          env:
            - name: DB_URL
              value: jdbc:mysql://db:3306/mydb
`;
    const signals = parseK8sManifest('/k8s/deployment.yml', yaml);
    expect(signals[0]?.filePath).toBe('/k8s/deployment.yml');
  });
});
