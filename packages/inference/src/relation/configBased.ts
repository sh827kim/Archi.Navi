/**
 * Config 기반 Relation 추론
 * application.yml / docker-compose.yml / K8s manifest를 파싱하여
 * relation_candidates + evidences 테이블에 PENDING 상태로 저장
 *
 * 설계 참조: docs/03-inference-engine.md §7 Config 파싱 전략, §2.3.3
 */
import { readFileSync } from 'fs';
import { extname } from 'path';
import { createHash } from 'crypto';
import { eq, and, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { objects, evidences, codeArtifacts } from '@archi-navi/db';
import { generateId, buildUrn } from '@archi-navi/shared';
import { parseApplicationYml } from './parsers/applicationYml';
import { parseDockerCompose } from './parsers/dockerCompose';
import { parseK8sManifest } from './parsers/k8sManifest';
import type { AppYmlSignal } from './parsers/applicationYml';
import type { DockerComposeSignal } from './parsers/dockerCompose';
import type { K8sSignal } from './parsers/k8sManifest';
import { saveRelationCandidate } from './candidateStore';
import { findFiles } from '../utils/fileDiscovery';

// Confidence 상수 (설계 문서 §2.3.3)
const CONFIDENCE = {
  DATASOURCE_RELATION: 0.9,   // spring.datasource.url → read/write
  KAFKA_BROKER: 0.9,          // spring.kafka.bootstrap-servers → broker
  KAFKA_CONSUME: 0.85,        // spring.kafka.consumer → consume
  KAFKA_PRODUCE: 0.85,        // spring.kafka.producer → produce
  DOCKER_DEPENDS_ON: 0.6,     // docker-compose depends_on → depend_on
  DOCKER_DB_OBJECT: 0.8,      // docker-compose DB 이미지 → database Object
  K8S_DB_RELATION: 0.7,       // K8s env DB_URL → read/write
  K8S_KAFKA_RELATION: 0.7,    // K8s env KAFKA_BROKERS → relation
  ZUUL_ROUTE_CALL: 0.7,       // zuul.routes.*.serviceId → call
} as const;

/** 추론 옵션 */
export interface ConfigInferenceOptions {
  workspaceId: string;
  /** 탐색 대상 리포 루트 경로 */
  repoRoot: string;
  /** true: SHA256 기반 변경 파일만 처리, false: 전체 재처리 */
  incremental?: boolean;
  candidateGenerationMode?: 'compat_deterministic';
}

/** 추론 결과 */
export interface ConfigInferenceResult {
  /** 새로 생성된 relation_candidate 수 */
  candidateCount: number;
  /** 생성된 Object 수 (database, message_broker, topic) */
  objectCount: number;
  /** 스캔 대상 config 파일 수 */
  fileCount: number;
  /** 실제 파싱/처리한 파일 수 */
  processedFileCount: number;
  /** SHA256 미변경으로 건너뛴 파일 수 */
  skippedFileCount: number;
}

// ─── 파일 탐색 유틸리티 ───────────────────────────────────────────────────────

/** application*.yml 파일 탐색 */
function findApplicationYmls(repoRoot: string): string[] {
  return findFiles(repoRoot, (p) => {
    const base = p.split('/').pop() ?? '';
    return (
      (base.startsWith('application') || base.startsWith('bootstrap')) &&
      (base.endsWith('.yml') || base.endsWith('.yaml'))
    );
  });
}

/** docker-compose*.yml 파일 탐색 */
function findDockerComposeFiles(repoRoot: string): string[] {
  return findFiles(repoRoot, (p) => {
    const base = p.split('/').pop() ?? '';
    return (
      base.startsWith('docker-compose') &&
      (base.endsWith('.yml') || base.endsWith('.yaml'))
    );
  });
}

/** K8s manifest 파일 탐색 (k8s/ 디렉토리 또는 deployment*.yml) */
function findK8sManifests(repoRoot: string): string[] {
  return findFiles(repoRoot, (p) => {
    if (extname(p) !== '.yml' && extname(p) !== '.yaml') return false;
    const normalized = p.replace(/\\/g, '/');
    const base = p.split('/').pop() ?? '';
    return (
      normalized.includes('/k8s/') ||
      normalized.includes('/kubernetes/') ||
      normalized.includes('/manifests/') ||
      base.startsWith('deployment') ||
      base.startsWith('service')
    );
  });
}

interface ConfigArtifactEntry {
  id: string;
  sha256: string | null;
}

function hashContentSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function hashServiceInventory(services: { id: string; name: string }[]): string {
  const normalized = services
    .map((service) => `${service.id}:${service.name.toLowerCase()}`)
    .sort()
    .join('\n');
  return hashContentSha256(normalized);
}

function hashConfigArtifact(contentSha256: string, serviceInventoryHash: string): string {
  return hashContentSha256(`${contentSha256}::services:${serviceInventoryHash}`);
}

async function loadConfigArtifactMap(
  db: DbClient,
  workspaceId: string,
  filePaths: string[],
): Promise<Map<string, ConfigArtifactEntry>> {
  if (filePaths.length === 0) return new Map();

  const rows = await db
    .select({
      id: codeArtifacts.id,
      filePath: codeArtifacts.filePath,
      sha256: codeArtifacts.sha256,
    })
    .from(codeArtifacts)
    .where(
      and(
        eq(codeArtifacts.workspaceId, workspaceId),
        eq(codeArtifacts.language, 'config'),
        inArray(codeArtifacts.filePath, filePaths),
      ),
    );

  return new Map(
    rows.map((row) => [row.filePath, { id: row.id, sha256: row.sha256 }]),
  );
}

async function upsertConfigArtifact(
  db: DbClient,
  params: {
    workspaceId: string;
    repoRoot: string;
    filePath: string;
    sha256: string;
    existingId?: string;
  },
): Promise<string> {
  const { workspaceId, repoRoot, filePath, sha256, existingId } = params;

  if (existingId) {
    await db
      .update(codeArtifacts)
      .set({ sha256, repoRoot, updatedAt: new Date() })
      .where(eq(codeArtifacts.id, existingId));
    return existingId;
  }

  const artifactId = generateId();
  await db.insert(codeArtifacts).values({
    id: artifactId,
    workspaceId,
    language: 'config',
    repoRoot,
    filePath,
    sha256,
    ownerObjectId: null,
  });
  return artifactId;
}

// ─── Object 생성/조회 ─────────────────────────────────────────────────────────

interface ObjectUpsertResult {
  id: string;
  isNew: boolean;
}

/**
 * URN 기반으로 Object를 조회하거나 없으면 신규 생성
 * @returns { id, isNew }
 */
async function upsertObject(
  db: DbClient,
  params: {
    workspaceId: string;
    objectType: 'database' | 'message_broker' | 'topic';
    category: 'STORAGE' | 'CHANNEL';
    granularity: 'COMPOUND' | 'ATOMIC';
    urn: string;
    name: string;
    displayName: string;
    metadata: Record<string, unknown>;
  },
): Promise<ObjectUpsertResult> {
  // URN으로 기존 Object 조회
  const existing = await db
    .select({ id: objects.id })
    .from(objects)
    .where(
      and(
        eq(objects.workspaceId, params.workspaceId),
        eq(objects.urn, params.urn),
      ),
    )
    .limit(1);

  if (existing[0]) {
    return { id: existing[0].id, isNew: false };
  }

  // 신규 생성
  const id = generateId();
  await db.insert(objects).values({
    id,
    workspaceId: params.workspaceId,
    objectType: params.objectType,
    category: params.category,
    granularity: params.granularity,
    urn: params.urn,
    name: params.name,
    displayName: params.displayName,
    path: `/${id}`,
    depth: 0,
    visibility: 'VISIBLE',
    metadata: params.metadata,
  });

  return { id, isNew: true };
}

/** database Object 생성/조회 */
async function upsertDatabase(
  db: DbClient,
  workspaceId: string,
  host: string,
  dbName: string,
  dbType: string,
): Promise<ObjectUpsertResult> {
  const urn = buildUrn(workspaceId, 'storage', 'database', `${host}:${dbName}`);
  const name = dbName || host;
  return upsertObject(db, {
    workspaceId,
    objectType: 'database',
    category: 'STORAGE',
    granularity: 'COMPOUND',
    urn,
    name,
    displayName: `${dbType}:${name}`,
    metadata: { host, dbName, dbType },
  });
}

/** message_broker Object 생성/조회 */
async function upsertMessageBroker(
  db: DbClient,
  workspaceId: string,
  host: string,
  brokerType: string,
): Promise<ObjectUpsertResult> {
  // host에 포트 포함 가능 (kafka:9092) → 호스트 부분만 추출
  const hostOnly = host.split(':')[0] ?? host;
  const urn = buildUrn(workspaceId, 'channel', 'message_broker', hostOnly);
  return upsertObject(db, {
    workspaceId,
    objectType: 'message_broker',
    category: 'CHANNEL',
    granularity: 'COMPOUND',
    urn,
    name: hostOnly,
    displayName: `${brokerType}:${hostOnly}`,
    metadata: { host, brokerType },
  });
}

/** topic Object 생성/조회 */
async function upsertTopic(
  db: DbClient,
  workspaceId: string,
  topicName: string,
): Promise<ObjectUpsertResult> {
  const urn = buildUrn(workspaceId, 'channel', 'topic', topicName);
  return upsertObject(db, {
    workspaceId,
    objectType: 'topic',
    category: 'CHANNEL',
    granularity: 'ATOMIC',
    urn,
    name: topicName,
    displayName: topicName,
    metadata: {},
  });
}

// ─── Service 매칭 ─────────────────────────────────────────────────────────────

/**
 * 서비스 이름으로 workspaceId의 service Object 조회
 * 정확 매칭 → 부분 매칭 순서로 시도
 */
async function findServiceByName(
  db: DbClient,
  workspaceId: string,
  serviceName: string,
  allServices: { id: string; name: string }[],
): Promise<string | null> {
  // 대소문자 무시한 정확 매칭
  const exactMatch = allServices.find(
    (s) => s.name.toLowerCase() === serviceName.toLowerCase(),
  );
  if (exactMatch) return exactMatch.id;

  // 하이픈/언더스코어 정규화 후 매칭
  const normalizedInput = serviceName.toLowerCase().replace(/[-_]/g, '');
  const normalizedMatch = allServices.find(
    (s) => s.name.toLowerCase().replace(/[-_]/g, '') === normalizedInput,
  );
  if (normalizedMatch) return normalizedMatch.id;

  return null;
}

/** evidence 저장 및 ID 반환 */
async function saveEvidence(
  db: DbClient,
  workspaceId: string,
  filePath: string,
  excerpt: string,
): Promise<string> {
  const evidenceId = generateId();
  await db.insert(evidences).values({
    id: evidenceId,
    workspaceId,
    evidenceType: 'CONFIG',
    filePath,
    excerpt,
    metadata: {},
  });
  return evidenceId;
}

// ─── 파싱 결과 → DB 저장 처리 ────────────────────────────────────────────────

interface ProcessContext {
  db: DbClient;
  workspaceId: string;
  repoRoot: string;
  allServices: { id: string; name: string }[];
  candidateGenerationMode?: 'compat_deterministic';
}

interface ProcessStats {
  candidateCount: number;
  objectCount: number;
}

function withConfigProvenance(
  metadata: Record<string, unknown>,
  repoRoot: string,
  filePath: string,
): Record<string, unknown> {
  return {
    ...metadata,
    repoRoot,
    specFile: filePath,
  };
}

function withCandidateGenerationMode(
  metadata: Record<string, unknown>,
  candidateGenerationMode?: 'compat_deterministic',
): Record<string, unknown> {
  return candidateGenerationMode
    ? {
        ...metadata,
        generationMode: candidateGenerationMode,
      }
    : metadata;
}

/**
 * application.yml 신호 처리
 * - datasource → database Object + read/write relation
 * - kafka → message_broker Object + produce/consume relation
 */
async function processAppYmlSignal(
  signal: AppYmlSignal,
  ctx: ProcessContext,
  stats: ProcessStats,
): Promise<void> {
  const { db, workspaceId, repoRoot, allServices } = ctx;

  // service 매칭 (spring.application.name 기준)
  let serviceId: string | null = null;
  if (signal.serviceName) {
    serviceId = await findServiceByName(db, workspaceId, signal.serviceName, allServices);
  }

  // spring.datasource.url → database Object + read/write relation
  if (signal.datasource) {
    const { host, dbName, dbType, url } = signal.datasource;

    const dbResult = await upsertDatabase(db, workspaceId, host, dbName, dbType);
    stats.objectCount += Number(dbResult.isNew);

    if (serviceId) {
      const evidenceId = await saveEvidence(
        db,
        workspaceId,
        signal.filePath,
        `spring.datasource.url=${url}`,
      );

      // read relation
      const readResult = await saveRelationCandidate(
        db,
        {
          workspaceId,
          relationType: 'read',
          subjectObjectId: serviceId,
          objectId: dbResult.id,
          confidence: CONFIDENCE.DATASOURCE_RELATION,
          metadata: withCandidateGenerationMode(
            withConfigProvenance(
              { source: 'application_yml', configKey: 'spring.datasource.url' },
              repoRoot,
              signal.filePath,
            ),
            ctx.candidateGenerationMode,
          ),
        },
        evidenceId,
      );
      stats.candidateCount += Number(readResult.created);

      // write relation
      const writeResult = await saveRelationCandidate(
        db,
        {
          workspaceId,
          relationType: 'write',
          subjectObjectId: serviceId,
          objectId: dbResult.id,
          confidence: CONFIDENCE.DATASOURCE_RELATION,
          metadata: withCandidateGenerationMode(
            withConfigProvenance(
              { source: 'application_yml', configKey: 'spring.datasource.url' },
              repoRoot,
              signal.filePath,
            ),
            ctx.candidateGenerationMode,
          ),
        },
        evidenceId,
      );
      stats.candidateCount += Number(writeResult.created);
    }
  }

  // spring.kafka.bootstrap-servers → message_broker Object
  if (signal.kafka) {
    const { bootstrapServers, consumerTopics, consumerGroupId, hasProducer } = signal.kafka;
    // 첫 번째 broker 주소만 사용 (여러 개일 경우)
    const primaryBroker = bootstrapServers.split(',')[0]?.trim() ?? bootstrapServers;
    const brokerHost = primaryBroker;

    const brokerResult = await upsertMessageBroker(db, workspaceId, brokerHost, 'kafka');
    stats.objectCount += Number(brokerResult.isNew);

    if (serviceId) {
      const brokerEvidenceId = await saveEvidence(
        db,
        workspaceId,
        signal.filePath,
        `spring.kafka.bootstrap-servers=${bootstrapServers}`,
      );

      // consumer topics → consume relation
      for (const topicName of consumerTopics) {
        const topicResult = await upsertTopic(db, workspaceId, topicName);
        stats.objectCount += Number(topicResult.isNew);

        const consumeEvidenceId = await saveEvidence(
          db,
          workspaceId,
          signal.filePath,
          `spring.kafka.consumer.topics=${topicName}${consumerGroupId ? `, group-id=${consumerGroupId}` : ''}`,
        );

        const consumeResult = await saveRelationCandidate(
          db,
          {
            workspaceId,
            relationType: 'consume',
            subjectObjectId: serviceId,
            objectId: topicResult.id,
            confidence: CONFIDENCE.KAFKA_CONSUME,
            metadata: withCandidateGenerationMode(
              withConfigProvenance(
                {
                  source: 'application_yml',
                  configKey: 'spring.kafka.consumer',
                  groupId: consumerGroupId,
                },
                repoRoot,
                signal.filePath,
              ),
              ctx.candidateGenerationMode,
            ),
          },
          consumeEvidenceId,
        );
        stats.candidateCount += Number(consumeResult.created);
      }

      // producer 설정 존재 → broker에 produce relation
      if (hasProducer) {
        const produceResult = await saveRelationCandidate(
          db,
          {
            workspaceId,
            relationType: 'produce',
            subjectObjectId: serviceId,
            objectId: brokerResult.id,
            confidence: CONFIDENCE.KAFKA_PRODUCE,
            metadata: withCandidateGenerationMode(
              withConfigProvenance(
                { source: 'application_yml', configKey: 'spring.kafka.producer' },
                repoRoot,
                signal.filePath,
              ),
              ctx.candidateGenerationMode,
            ),
          },
          brokerEvidenceId,
        );
        stats.candidateCount += Number(produceResult.created);
      }
    }
  }

  // zuul.routes.*.serviceId → service call relation
  if (serviceId && signal.routeServiceIds.length > 0) {
    for (const targetServiceName of signal.routeServiceIds) {
      const targetServiceId = await findServiceByName(
        db,
        workspaceId,
        targetServiceName,
        allServices,
      );
      if (!targetServiceId || targetServiceId === serviceId) continue;

      const evidenceId = await saveEvidence(
        db,
        workspaceId,
        signal.filePath,
        `zuul.routes.*.serviceId=${targetServiceName}`,
      );

      const callResult = await saveRelationCandidate(
        db,
        {
          workspaceId,
          relationType: 'call',
          subjectObjectId: serviceId,
          objectId: targetServiceId,
          confidence: CONFIDENCE.ZUUL_ROUTE_CALL,
          metadata: withCandidateGenerationMode(
            withConfigProvenance(
              { source: 'application_yml', configKey: 'zuul.routes.serviceId' },
              repoRoot,
              signal.filePath,
            ),
            ctx.candidateGenerationMode,
          ),
        },
        evidenceId,
      );
      stats.candidateCount += Number(callResult.created);
    }
  }
}

/**
 * docker-compose.yml 신호 처리
 * - depends_on → depend_on relation
 * - DB 이미지 → database Object
 * - Broker 이미지 → message_broker Object
 */
async function processDockerComposeSignal(
  signal: DockerComposeSignal,
  ctx: ProcessContext,
  stats: ProcessStats,
): Promise<void> {
  const { db, workspaceId, repoRoot, allServices } = ctx;

  // 서비스 이름 → Object ID 맵 구성 (docker-compose 서비스 이름 기준)
  const serviceIdMap = new Map<string, string>();
  for (const svc of signal.services) {
    if (!svc.dbInfo && !svc.brokerInfo) {
      // 애플리케이션 서비스 (DB/Broker가 아닌 것)
      const id = await findServiceByName(db, workspaceId, svc.name, allServices);
      if (id) serviceIdMap.set(svc.name, id);
    }
  }

  // DB/Broker 서비스 → Object 생성
  const infraObjectMap = new Map<string, string>(); // 서비스 이름 → Object ID

  for (const svc of signal.services) {
    if (svc.dbInfo) {
      const evidenceId = await saveEvidence(
        db,
        workspaceId,
        signal.filePath,
        `services.${svc.name}.image=${svc.image}`,
      );
      const dbName = svc.dbInfo.dbName ?? svc.name;
      const dbResult = await upsertDatabase(
        db,
        workspaceId,
        svc.name, // docker-compose 서비스명을 호스트로 사용
        dbName,
        svc.dbInfo.dbType,
      );
      stats.objectCount += Number(dbResult.isNew);
      infraObjectMap.set(svc.name, dbResult.id);
    } else if (svc.brokerInfo) {
      const brokerResult = await upsertMessageBroker(
        db,
        workspaceId,
        svc.name,
        svc.brokerInfo.brokerType,
      );
      stats.objectCount += Number(brokerResult.isNew);
      infraObjectMap.set(svc.name, brokerResult.id);
    }
  }

  // depends_on → depend_on relation
  for (const svc of signal.services) {
    const subjectId = serviceIdMap.get(svc.name);
    if (!subjectId || svc.dependsOn.length === 0) continue;

    for (const depName of svc.dependsOn) {
      // 의존 대상이 workspaceId의 service Object인 경우
      const depServiceId = serviceIdMap.get(depName);
      // 의존 대상이 infra Object (DB/Broker)인 경우
      const depInfraId = infraObjectMap.get(depName);

      const objectId = depServiceId ?? depInfraId;
      if (!objectId) continue;

      const evidenceId = await saveEvidence(
        db,
        workspaceId,
        signal.filePath,
        `services.${svc.name}.depends_on=${depName}`,
      );

      const result = await saveRelationCandidate(
        db,
        {
          workspaceId,
          relationType: 'depend_on',
          subjectObjectId: subjectId,
          objectId,
          confidence: CONFIDENCE.DOCKER_DEPENDS_ON,
          metadata: withCandidateGenerationMode(
            withConfigProvenance(
              { source: 'docker_compose', configKey: 'depends_on' },
              repoRoot,
              signal.filePath,
            ),
            ctx.candidateGenerationMode,
          ),
        },
        evidenceId,
      );
      stats.candidateCount += Number(result.created);
    }
  }
}

/**
 * K8s manifest 신호 처리
 * - env DB_URL → database Object + read/write relation
 * - env KAFKA_BROKERS → message_broker Object + produce/consume relation
 */
async function processK8sSignal(
  signal: K8sSignal,
  ctx: ProcessContext,
  stats: ProcessStats,
): Promise<void> {
  const { db, workspaceId, repoRoot, allServices } = ctx;

  // K8s Deployment 이름으로 service 매칭
  let serviceId: string | null = null;
  if (signal.serviceName) {
    serviceId = await findServiceByName(db, workspaceId, signal.serviceName, allServices);
  }

  if (!serviceId) return;

  // env DB_URL → database Object + read/write relation
  for (const dbUrl of signal.dbUrls) {
    // JDBC URL 또는 일반 DB URL 파싱
    const jdbcMatch = dbUrl.match(
      /(?:jdbc:)?(?:\w+:\/\/)?([^/:]+)(?::(\d+))?\/([^?]+)/,
    );
    if (!jdbcMatch) continue;

    const host = jdbcMatch[1] ?? 'unknown';
    const dbName = jdbcMatch[3] ?? 'unknown';

    const evidenceId = await saveEvidence(
      db,
      workspaceId,
      signal.filePath,
      `env.DB_URL=${dbUrl}`,
    );

    const dbResult = await upsertDatabase(db, workspaceId, host, dbName, 'unknown');
    stats.objectCount += Number(dbResult.isNew);

    const readResult = await saveRelationCandidate(
      db,
      {
        workspaceId,
        relationType: 'read',
        subjectObjectId: serviceId,
        objectId: dbResult.id,
        confidence: CONFIDENCE.K8S_DB_RELATION,
        metadata: withCandidateGenerationMode(
          withConfigProvenance(
            { source: 'k8s_manifest', envKey: 'DB_URL' },
            repoRoot,
            signal.filePath,
          ),
          ctx.candidateGenerationMode,
        ),
      },
      evidenceId,
    );
    stats.candidateCount += Number(readResult.created);

    const writeResult = await saveRelationCandidate(
      db,
      {
        workspaceId,
        relationType: 'write',
        subjectObjectId: serviceId,
        objectId: dbResult.id,
        confidence: CONFIDENCE.K8S_DB_RELATION,
        metadata: withCandidateGenerationMode(
          withConfigProvenance(
            { source: 'k8s_manifest', envKey: 'DB_URL' },
            repoRoot,
            signal.filePath,
          ),
          ctx.candidateGenerationMode,
        ),
      },
      evidenceId,
    );
    stats.candidateCount += Number(writeResult.created);
  }

  // env KAFKA_BROKERS → message_broker Object + produce relation
  for (const brokerAddr of signal.kafkaBrokers) {
    const primaryBroker = brokerAddr.split(',')[0]?.trim() ?? brokerAddr;

    const evidenceId = await saveEvidence(
      db,
      workspaceId,
      signal.filePath,
      `env.KAFKA_BROKERS=${brokerAddr}`,
    );

    const brokerResult = await upsertMessageBroker(db, workspaceId, primaryBroker, 'kafka');
    stats.objectCount += Number(brokerResult.isNew);

    const result = await saveRelationCandidate(
      db,
      {
        workspaceId,
        relationType: 'produce',
        subjectObjectId: serviceId,
        objectId: brokerResult.id,
        confidence: CONFIDENCE.K8S_KAFKA_RELATION,
        metadata: withCandidateGenerationMode(
          withConfigProvenance(
            { source: 'k8s_manifest', envKey: 'KAFKA_BROKERS' },
            repoRoot,
            signal.filePath,
          ),
          ctx.candidateGenerationMode,
        ),
      },
      evidenceId,
    );
    stats.candidateCount += Number(result.created);
  }
}

// ─── 메인 추론 함수 ───────────────────────────────────────────────────────────

/**
 * Config 기반 Relation 추론 실행
 * 1. repoRoot에서 설정 파일 탐색
 * 2. 각 파서 실행하여 신호 수집
 * 3. Object 생성/조회 (database, message_broker, topic)
 * 4. relation_candidates + evidences 저장
 *
 * @param db - DB 클라이언트
 * @param options - 추론 옵션 (workspaceId, repoRoot)
 * @returns 생성된 후보 수와 Object 수
 */
export async function inferRelationsFromConfig(
  db: DbClient,
  options: ConfigInferenceOptions,
): Promise<ConfigInferenceResult> {
  const { workspaceId, repoRoot, incremental = false, candidateGenerationMode } = options;

  // 워크스페이스의 서비스 Object 목록 미리 조회
  const allServices = await db
    .select({ id: objects.id, name: objects.name })
    .from(objects)
    .where(
      and(
        eq(objects.workspaceId, workspaceId),
        eq(objects.objectType, 'service'),
      ),
    );

  const ctx: ProcessContext = {
    db,
    workspaceId,
    repoRoot,
    allServices,
    ...(candidateGenerationMode ? { candidateGenerationMode } : {}),
  };
  const stats: ProcessStats = { candidateCount: 0, objectCount: 0 };
  const serviceInventoryHash = hashServiceInventory(allServices);

  const appYmlFiles = findApplicationYmls(repoRoot);
  const dockerComposeFiles = findDockerComposeFiles(repoRoot);
  const k8sFiles = findK8sManifests(repoRoot);

  const allConfigFiles = [...appYmlFiles, ...dockerComposeFiles, ...k8sFiles];
  const artifactMap = await loadConfigArtifactMap(db, workspaceId, allConfigFiles);

  let processedFileCount = 0;
  let skippedFileCount = 0;

  // 1. application.yml 파일 처리
  for (const filePath of appYmlFiles) {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const contentSha256 = hashContentSha256(content);
    const sha256 = hashConfigArtifact(contentSha256, serviceInventoryHash);
    const existingArtifact = artifactMap.get(filePath);
    if (incremental && existingArtifact?.sha256 === sha256) {
      skippedFileCount += 1;
      continue;
    }

    const signal = parseApplicationYml(filePath, content);
    await processAppYmlSignal(signal, ctx, stats);
    const artifactId = await upsertConfigArtifact(db, {
      workspaceId,
      repoRoot,
      filePath,
      sha256,
      ...(existingArtifact?.id ? { existingId: existingArtifact.id } : {}),
    });
    artifactMap.set(filePath, { id: artifactId, sha256 });
    processedFileCount += 1;
  }

  // 2. docker-compose.yml 파일 처리
  for (const filePath of dockerComposeFiles) {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const contentSha256 = hashContentSha256(content);
    const sha256 = hashConfigArtifact(contentSha256, serviceInventoryHash);
    const existingArtifact = artifactMap.get(filePath);
    if (incremental && existingArtifact?.sha256 === sha256) {
      skippedFileCount += 1;
      continue;
    }

    const signal = parseDockerCompose(filePath, content);
    await processDockerComposeSignal(signal, ctx, stats);
    const artifactId = await upsertConfigArtifact(db, {
      workspaceId,
      repoRoot,
      filePath,
      sha256,
      ...(existingArtifact?.id ? { existingId: existingArtifact.id } : {}),
    });
    artifactMap.set(filePath, { id: artifactId, sha256 });
    processedFileCount += 1;
  }

  // 3. K8s manifest 파일 처리
  for (const filePath of k8sFiles) {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const contentSha256 = hashContentSha256(content);
    const sha256 = hashConfigArtifact(contentSha256, serviceInventoryHash);
    const existingArtifact = artifactMap.get(filePath);
    if (incremental && existingArtifact?.sha256 === sha256) {
      skippedFileCount += 1;
      continue;
    }

    const k8sSignals = parseK8sManifest(filePath, content);
    for (const signal of k8sSignals) {
      await processK8sSignal(signal, ctx, stats);
    }
    const artifactId = await upsertConfigArtifact(db, {
      workspaceId,
      repoRoot,
      filePath,
      sha256,
      ...(existingArtifact?.id ? { existingId: existingArtifact.id } : {}),
    });
    artifactMap.set(filePath, { id: artifactId, sha256 });
    processedFileCount += 1;
  }

  return {
    ...stats,
    fileCount: allConfigFiles.length,
    processedFileCount,
    skippedFileCount,
  };
}
