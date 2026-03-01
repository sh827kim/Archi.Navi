/**
 * Rollup Builder - Materialized Roll-up 계산 파이프라인
 *
 * 계산 순서:
 * 1. SERVICE_TO_SERVICE (call+expose → service-to-service)
 * 2. SERVICE_TO_DATABASE (read/write + parent → service-to-db)
 * 3. SERVICE_TO_BROKER (produce/consume + parent → service-to-broker)
 * 4. DOMAIN_TO_DOMAIN (SERVICE_TO_SERVICE + affinities → domain-to-domain)
 */
import { eq, and, or, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
  objectRelations,
  objects,
  objectRollups,
  objectRollupProvenances,
  objectDomainAffinities,
  objectGraphStats,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { createNewGeneration, activateGeneration, getActiveGeneration, updateGenerationMeta } from './generationManager';
import { invalidateCache } from '../graph-index/index';
import type { ChangeEvent, AffectedScope, AffectedRollupLevel } from './types';

interface RollupInsertInput {
  rollupLevel: string;
  relationType: string;
  subjectObjectId: string;
  objectId: string;
  edgeWeight: number;
  confidence: number | null;
  baseRelationIds: string[];
}

async function insertRollupsWithProvenance(
  db: DbClient,
  workspaceId: string,
  generationVersion: number,
  inputs: RollupInsertInput[],
): Promise<void> {
  if (inputs.length === 0) return;

  const rollupRows = inputs.map((input) => ({
    id: generateId(),
    workspaceId,
    rollupLevel: input.rollupLevel,
    relationType: input.relationType,
    subjectObjectId: input.subjectObjectId,
    objectId: input.objectId,
    edgeWeight: input.edgeWeight,
    confidence: input.confidence,
    generationVersion,
  }));

  await db.insert(objectRollups).values(rollupRows);

  const provenanceRows = rollupRows.flatMap((rollupRow, idx) => {
    const baseRelationIds = [...new Set(inputs[idx]?.baseRelationIds ?? [])];
    return baseRelationIds.map((baseRelationId) => ({
      id: generateId(),
      workspaceId,
      generationVersion,
      rollupId: rollupRow.id,
      baseRelationId,
    }));
  });

  if (provenanceRows.length > 0) {
    await db.insert(objectRollupProvenances).values(provenanceRows);
  }
}

/**
 * 전체 Rollup 재빌드
 * relation 승인/삭제, parent 변경 등 이벤트 발생 시 호출
 */
export async function rebuildRollups(
  db: DbClient,
  workspaceId: string,
): Promise<number> {
  // 1. 새 generation 생성
  const newVersion = await createNewGeneration(db, workspaceId);

  try {
    // 2. SERVICE_TO_SERVICE 계산
    await buildServiceToService(db, workspaceId, newVersion);

    // 3. SERVICE_TO_DATABASE 계산
    await buildServiceToDatabase(db, workspaceId, newVersion);

    // 4. SERVICE_TO_BROKER 계산
    await buildServiceToBroker(db, workspaceId, newVersion);

    // 5. DOMAIN_TO_DOMAIN 계산
    await buildDomainToDomain(db, workspaceId, newVersion);

    // 6. object_graph_stats 계산 (Hub 감지용 degree 통계)
    await buildObjectGraphStats(db, workspaceId, newVersion);

    // 7. generation ACTIVE로 전환
    await activateGeneration(db, workspaceId, newVersion);

    // 8. 그래프 캐시 무효화
    invalidateCache(workspaceId);

    return newVersion;
  } catch (error) {
    // 빌드 실패 시 BUILDING 상태 유지 (수동 재시도 필요)
    console.error(`Rollup build failed for workspace ${workspaceId}:`, error);
    throw error;
  }
}

/**
 * SERVICE_TO_SERVICE 계산
 * A --call--> endpoint E, B --expose--> endpoint E → A --call--> B
 */
async function buildServiceToService(
  db: DbClient,
  workspaceId: string,
  generationVersion: number,
): Promise<void> {
  // call 관계 조회 (service → api_endpoint)
  const callRelations = await db
    .select()
    .from(objectRelations)
    .where(
      and(
        eq(objectRelations.workspaceId, workspaceId),
        eq(objectRelations.relationType, 'call'),
        eq(objectRelations.isDerived, false),
        eq(objectRelations.status, 'APPROVED'),
      ),
    );

  // expose 관계 조회 (service → api_endpoint)
  const exposeRelations = await db
    .select()
    .from(objectRelations)
    .where(
      and(
        eq(objectRelations.workspaceId, workspaceId),
        eq(objectRelations.relationType, 'expose'),
        eq(objectRelations.isDerived, false),
        eq(objectRelations.status, 'APPROVED'),
      ),
    );

  // endpoint별 expose 서비스 매핑
  const endpointToService = new Map<string, string>();
  for (const expose of exposeRelations) {
    endpointToService.set(expose.objectId, expose.subjectObjectId);
  }

  // A --call--> E, E --expose--> B → A --call--> B 집계
  const rollupMap = new Map<
    string,
    { edgeWeight: number; confidences: number[]; baseRelationIds: Set<string> }
  >();

  for (const call of callRelations) {
    const callerServiceId = call.subjectObjectId;
    const endpointId = call.objectId;
    const exposingServiceId = endpointToService.get(endpointId);

    if (!exposingServiceId || callerServiceId === exposingServiceId) continue;

    const key = `${callerServiceId}|${exposingServiceId}`;
    const existing = rollupMap.get(key) ?? {
      edgeWeight: 0,
      confidences: [],
      baseRelationIds: new Set<string>(),
    };
    existing.edgeWeight += 1;
    if (call.confidence != null) existing.confidences.push(call.confidence);
    existing.baseRelationIds.add(call.id);
    rollupMap.set(key, existing);
  }

  const rollups = [...rollupMap.entries()].map(
    ([key, { edgeWeight, confidences, baseRelationIds }]) => {
    const [subjectObjectId, objectId] = key.split('|') as [string, string];
    const confidence = confidences.length > 0
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : null;
    return {
      rollupLevel: 'SERVICE_TO_SERVICE',
      relationType: 'call',
      subjectObjectId,
      objectId,
      edgeWeight,
      confidence,
      baseRelationIds: [...baseRelationIds],
    };
  });

  await insertRollupsWithProvenance(db, workspaceId, generationVersion, rollups);
}

/**
 * SERVICE_TO_DATABASE 계산
 * S --read/write--> Table T, T.parent = DB → S --read/write--> DB
 */
async function buildServiceToDatabase(
  db: DbClient,
  workspaceId: string,
  generationVersion: number,
): Promise<void> {
  for (const relType of ['read', 'write']) {
    const relations = await db
      .select({
        relation: objectRelations,
        tableParentId: objects.parentId,
      })
      .from(objectRelations)
      .innerJoin(objects, eq(objectRelations.objectId, objects.id))
      .where(
        and(
          eq(objectRelations.workspaceId, workspaceId),
          eq(objectRelations.relationType, relType),
          eq(objectRelations.isDerived, false),
          eq(objectRelations.status, 'APPROVED'),
        ),
      );

    const rollupMap = new Map<
      string,
      { edgeWeight: number; confidences: number[]; baseRelationIds: Set<string> }
    >();

    for (const { relation, tableParentId } of relations) {
      if (!tableParentId) continue;
      const key = `${relation.subjectObjectId}|${tableParentId}`;
      const existing = rollupMap.get(key) ?? {
        edgeWeight: 0,
        confidences: [],
        baseRelationIds: new Set<string>(),
      };
      existing.edgeWeight += 1;
      if (relation.confidence != null) existing.confidences.push(relation.confidence);
      existing.baseRelationIds.add(relation.id);
      rollupMap.set(key, existing);
    }

    const rollups = [...rollupMap.entries()].map(
      ([key, { edgeWeight, confidences, baseRelationIds }]) => {
      const [subjectObjectId, objectId] = key.split('|') as [string, string];
      const confidence = confidences.length > 0
        ? confidences.reduce((a, b) => a + b, 0) / confidences.length
        : null;
      return {
        rollupLevel: 'SERVICE_TO_DATABASE',
        relationType: relType,
        subjectObjectId,
        objectId,
        edgeWeight,
        confidence,
        baseRelationIds: [...baseRelationIds],
      };
    });

    await insertRollupsWithProvenance(db, workspaceId, generationVersion, rollups);
  }
}

/**
 * SERVICE_TO_BROKER 계산
 * S --produce/consume--> Topic T, T.parent = Broker → S --produce/consume--> Broker
 */
async function buildServiceToBroker(
  db: DbClient,
  workspaceId: string,
  generationVersion: number,
): Promise<void> {
  for (const relType of ['produce', 'consume']) {
    const relations = await db
      .select({
        relation: objectRelations,
        topicParentId: objects.parentId,
      })
      .from(objectRelations)
      .innerJoin(objects, eq(objectRelations.objectId, objects.id))
      .where(
        and(
          eq(objectRelations.workspaceId, workspaceId),
          eq(objectRelations.relationType, relType),
          eq(objectRelations.isDerived, false),
          eq(objectRelations.status, 'APPROVED'),
        ),
      );

    const rollupMap = new Map<
      string,
      { edgeWeight: number; confidences: number[]; baseRelationIds: Set<string> }
    >();

    for (const { relation, topicParentId } of relations) {
      if (!topicParentId) continue;
      const key = `${relation.subjectObjectId}|${topicParentId}`;
      const existing = rollupMap.get(key) ?? {
        edgeWeight: 0,
        confidences: [],
        baseRelationIds: new Set<string>(),
      };
      existing.edgeWeight += 1;
      if (relation.confidence != null) existing.confidences.push(relation.confidence);
      existing.baseRelationIds.add(relation.id);
      rollupMap.set(key, existing);
    }

    const rollups = [...rollupMap.entries()].map(
      ([key, { edgeWeight, confidences, baseRelationIds }]) => {
      const [subjectObjectId, objectId] = key.split('|') as [string, string];
      const confidence = confidences.length > 0
        ? confidences.reduce((a, b) => a + b, 0) / confidences.length
        : null;
      return {
        rollupLevel: 'SERVICE_TO_BROKER',
        relationType: relType,
        subjectObjectId,
        objectId,
        edgeWeight,
        confidence,
        baseRelationIds: [...baseRelationIds],
      };
    });

    await insertRollupsWithProvenance(db, workspaceId, generationVersion, rollups);
  }
}

/**
 * DOMAIN_TO_DOMAIN 계산
 * 설계 문서의 공식 구현:
 *   edge_weight[X,Y] += w_ab × a[X] × b[Y]
 *   confidence[X,Y] = sum(c_ab × w_ab × a[X] × b[Y]) / sum(w_ab × a[X] × b[Y])
 */
async function buildDomainToDomain(
  db: DbClient,
  workspaceId: string,
  generationVersion: number,
): Promise<void> {
  // SERVICE_TO_SERVICE rollup 조회 (현재 generation)
  const s2sRollups = await db
    .select()
    .from(objectRollups)
    .where(
      and(
        eq(objectRollups.workspaceId, workspaceId),
        eq(objectRollups.generationVersion, generationVersion),
        eq(objectRollups.rollupLevel, 'SERVICE_TO_SERVICE'),
      ),
    );

  if (s2sRollups.length === 0) return;

  const s2sRollupIds = s2sRollups
    .map((r) => r.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const s2sProvenanceRows =
    s2sRollupIds.length > 0
      ? await db
          .select({
            rollupId: objectRollupProvenances.rollupId,
            baseRelationId: objectRollupProvenances.baseRelationId,
          })
          .from(objectRollupProvenances)
          .where(
            and(
              eq(objectRollupProvenances.workspaceId, workspaceId),
              eq(objectRollupProvenances.generationVersion, generationVersion),
              inArray(objectRollupProvenances.rollupId, s2sRollupIds),
            ),
          )
      : [];
  const baseRelationIdsByS2SRollup = new Map<string, string[]>();
  for (const row of s2sProvenanceRows) {
    const existing = baseRelationIdsByS2SRollup.get(row.rollupId) ?? [];
    existing.push(row.baseRelationId);
    baseRelationIdsByS2SRollup.set(row.rollupId, existing);
  }

  // 모든 서비스의 도메인 affinity 조회
  const allServiceIds = [...new Set([
    ...s2sRollups.map((r: typeof s2sRollups[0]) => r.subjectObjectId),
    ...s2sRollups.map((r: typeof s2sRollups[0]) => r.objectId),
  ])];

  const affinities = await db
    .select()
    .from(objectDomainAffinities)
    .where(
      and(
        eq(objectDomainAffinities.workspaceId, workspaceId),
        inArray(objectDomainAffinities.objectId, allServiceIds),
      ),
    );

  // 서비스별 affinity 맵 구성
  const serviceAffinityMap = new Map<string, Map<string, number>>();
  for (const aff of affinities) {
    if (!serviceAffinityMap.has(aff.objectId)) {
      serviceAffinityMap.set(aff.objectId, new Map());
    }
    serviceAffinityMap.get(aff.objectId)!.set(aff.domainId, aff.affinity);
  }

  // DOMAIN_TO_DOMAIN 집계
  const d2dMap = new Map<
    string,
    {
      weightedSum: number;
      weightedConfSum: number;
      denominator: number;
      baseRelationIds: Set<string>;
    }
  >();

  for (const rollup of s2sRollups) {
    const wAb = rollup.edgeWeight;
    const cAb = rollup.confidence ?? 0;
    const aAffinities = serviceAffinityMap.get(rollup.subjectObjectId);
    const bAffinities = serviceAffinityMap.get(rollup.objectId);

    if (!aAffinities || !bAffinities) continue;

    for (const [domainX, ax] of aAffinities) {
      for (const [domainY, by] of bAffinities) {
        if (ax < 0.2 || by < 0.2) continue; // min_membership_threshold

        const key = `${domainX}|${domainY}`;
        const existing =
          d2dMap.get(key) ??
          {
            weightedSum: 0,
            weightedConfSum: 0,
            denominator: 0,
            baseRelationIds: new Set<string>(),
          };
        const contribution = wAb * ax * by;
        existing.weightedSum += contribution;
        existing.weightedConfSum += cAb * contribution;
        existing.denominator += contribution;
        for (const baseRelationId of baseRelationIdsByS2SRollup.get(rollup.id) ?? []) {
          existing.baseRelationIds.add(baseRelationId);
        }
        d2dMap.set(key, existing);
      }
    }
  }

  const rollups = [...d2dMap.entries()].map(
    ([key, { weightedSum, weightedConfSum, denominator, baseRelationIds }]) => {
      const [domainX, domainY] = key.split('|') as [string, string];
      return {
        rollupLevel: 'DOMAIN_TO_DOMAIN' as const,
        relationType: 'call',
        subjectObjectId: domainX,
        objectId: domainY,
        edgeWeight: Math.round(weightedSum),
        confidence: denominator > 0 ? weightedConfSum / denominator : null,
        baseRelationIds: [...baseRelationIds],
      };
    },
  );

  await insertRollupsWithProvenance(db, workspaceId, generationVersion, rollups);
}

/**
 * object_graph_stats 계산
 * 각 rollup level별로 노드의 inDegree / outDegree를 집계하여 저장
 */
async function buildObjectGraphStats(
  db: DbClient,
  workspaceId: string,
  generationVersion: number,
): Promise<void> {
  const LEVELS = [
    'SERVICE_TO_SERVICE',
    'SERVICE_TO_DATABASE',
    'SERVICE_TO_BROKER',
    'DOMAIN_TO_DOMAIN',
  ];

  for (const level of LEVELS) {
    // 현재 generation의 rollup 데이터 조회
    const levelRollups = await db
      .select({
        subjectObjectId: objectRollups.subjectObjectId,
        objectId: objectRollups.objectId,
      })
      .from(objectRollups)
      .where(
        and(
          eq(objectRollups.workspaceId, workspaceId),
          eq(objectRollups.generationVersion, generationVersion),
          eq(objectRollups.rollupLevel, level),
        ),
      );

    if (levelRollups.length === 0) continue;

    // outDegree: subjectObjectId 기준 카운트
    const outMap = new Map<string, number>();
    // inDegree: objectId 기준 카운트
    const inMap = new Map<string, number>();

    for (const r of levelRollups) {
      outMap.set(r.subjectObjectId, (outMap.get(r.subjectObjectId) ?? 0) + 1);
      inMap.set(r.objectId, (inMap.get(r.objectId) ?? 0) + 1);
    }

    // 모든 관련 노드 ID 수집
    const allNodeIds = new Set([...outMap.keys(), ...inMap.keys()]);

    const statsRows = [...allNodeIds].map((nodeId) => ({
      workspaceId,
      generationVersion,
      rollupLevel: level,
      objectId: nodeId,
      outDegree: outMap.get(nodeId) ?? 0,
      inDegree: inMap.get(nodeId) ?? 0,
    }));

    if (statsRows.length > 0) {
      await db.insert(objectGraphStats).values(statsRows);
    }
  }
}

// ─── 증분 리빌드 ──────────────────────────────────────────────────────────────

/**
 * 증분 Rollup 리빌드
 * 변경 이벤트 기반으로 영향받는 rollup edge만 부분 재계산한다.
 * 동일 generation_version을 유지 (in-place update).
 */
export async function incrementalRebuild(
  db: DbClient,
  workspaceId: string,
  events: ChangeEvent[],
): Promise<number> {
  // ACTIVE generation 확인 — 없으면 전체 리빌드 fallback
  const activeVersion = await getActiveGeneration(db, workspaceId);
  if (activeVersion === null) {
    return rebuildRollups(db, workspaceId);
  }

  // 이벤트가 비어 있으면 변경 없음
  if (events.length === 0) {
    return activeVersion;
  }

  // 영향 범위 분석 (DB 역추적 포함)
  const scope = await resolveAffectedScope(db, workspaceId, events);

  if (scope.levels.size === 0) {
    return activeVersion;
  }

  // S2S 증분 재계산
  if (scope.levels.has('SERVICE_TO_SERVICE')) {
    await incrementalBuildS2S(db, workspaceId, activeVersion, scope.s2sAffectedServiceIds);
  }

  // S2DB 증분 재계산
  if (scope.levels.has('SERVICE_TO_DATABASE')) {
    await incrementalBuildS2DB(db, workspaceId, activeVersion, scope.s2dbAffectedServiceIds);
  }

  // S2B 증분 재계산
  if (scope.levels.has('SERVICE_TO_BROKER')) {
    await incrementalBuildS2B(db, workspaceId, activeVersion, scope.s2bAffectedServiceIds);
  }

  // D2D — 전체 재계산 (domain 수가 적으므로 부분 대비 이득 없음)
  if (scope.levels.has('DOMAIN_TO_DOMAIN')) {
    await deleteRollupsByLevel(db, workspaceId, activeVersion, 'DOMAIN_TO_DOMAIN');
    await buildDomainToDomain(db, workspaceId, activeVersion);
  }

  // 영향받는 level의 graph stats 재계산
  await incrementalBuildGraphStats(db, workspaceId, activeVersion, scope.levels);

  // generation meta 업데이트
  await updateGenerationMeta(db, workspaceId, activeVersion, {
    lastIncrementalAt: new Date().toISOString(),
    eventCount: events.length,
  });

  // 그래프 캐시 무효화
  invalidateCache(workspaceId);

  return activeVersion;
}

/**
 * 이벤트 분석 → 영향받는 rollup level + affected 서비스 ID 식별
 * expose/parent 변경 시 DB 역추적으로 관련 서비스를 찾는다.
 */
async function resolveAffectedScope(
  db: DbClient,
  workspaceId: string,
  events: ChangeEvent[],
): Promise<AffectedScope> {
  const levels = new Set<AffectedRollupLevel>();
  const s2sAffected = new Set<string>();
  const s2dbAffected = new Set<string>();
  const s2bAffected = new Set<string>();

  for (const event of events) {
    switch (event.type) {
      case 'RELATION_APPROVED':
      case 'RELATION_DELETED': {
        const { relationType, subjectObjectId } = event.payload;
        if (relationType === 'call') {
          levels.add('SERVICE_TO_SERVICE');
          s2sAffected.add(subjectObjectId);
        }
        if (relationType === 'expose') {
          levels.add('SERVICE_TO_SERVICE');
          s2sAffected.add(subjectObjectId);
        }
        if (relationType === 'read' || relationType === 'write') {
          levels.add('SERVICE_TO_DATABASE');
          s2dbAffected.add(subjectObjectId);
        }
        if (relationType === 'produce' || relationType === 'consume') {
          levels.add('SERVICE_TO_BROKER');
          s2bAffected.add(subjectObjectId);
        }
        break;
      }
      case 'EXPOSE_CHANGED': {
        levels.add('SERVICE_TO_SERVICE');
        s2sAffected.add(event.payload.subjectObjectId);
        // expose 변경 시, 해당 endpoint를 call하는 서비스도 영향
        const callers = await findCallersOfEndpoint(db, workspaceId, event.payload.objectId);
        for (const callerId of callers) s2sAffected.add(callerId);
        break;
      }
      case 'OBJECT_PARENT_CHANGED': {
        levels.add('SERVICE_TO_DATABASE');
        levels.add('SERVICE_TO_BROKER');
        // parent 변경된 object를 참조하는 relation의 subject를 역추적
        const subjects = await findSubjectsReferencingObject(db, workspaceId, event.payload.objectId);
        for (const sid of subjects) {
          s2dbAffected.add(sid);
          s2bAffected.add(sid);
        }
        break;
      }
      case 'DOMAIN_AFFINITY_CHANGED': {
        levels.add('DOMAIN_TO_DOMAIN');
        break;
      }
    }
  }

  // S2S 변경 시 D2D도 연쇄 재계산
  if (levels.has('SERVICE_TO_SERVICE')) {
    levels.add('DOMAIN_TO_DOMAIN');
  }

  return { levels, s2sAffectedServiceIds: s2sAffected, s2dbAffectedServiceIds: s2dbAffected, s2bAffectedServiceIds: s2bAffected };
}

/** 특정 endpoint를 call하는 서비스 ID 목록 조회 */
async function findCallersOfEndpoint(
  db: DbClient,
  workspaceId: string,
  endpointId: string,
): Promise<string[]> {
  const rows = await db
    .select({ subjectObjectId: objectRelations.subjectObjectId })
    .from(objectRelations)
    .where(
      and(
        eq(objectRelations.workspaceId, workspaceId),
        eq(objectRelations.relationType, 'call'),
        eq(objectRelations.objectId, endpointId),
        eq(objectRelations.isDerived, false),
        eq(objectRelations.status, 'APPROVED'),
      ),
    );
  return rows.map((r) => r.subjectObjectId);
}

/** 특정 object를 참조(read/write/produce/consume)하는 서비스 ID 목록 조회 */
async function findSubjectsReferencingObject(
  db: DbClient,
  workspaceId: string,
  objectId: string,
): Promise<string[]> {
  const rows = await db
    .select({ subjectObjectId: objectRelations.subjectObjectId })
    .from(objectRelations)
    .where(
      and(
        eq(objectRelations.workspaceId, workspaceId),
        eq(objectRelations.objectId, objectId),
        eq(objectRelations.isDerived, false),
        eq(objectRelations.status, 'APPROVED'),
      ),
    );
  return rows.map((r) => r.subjectObjectId);
}

/** 특정 level의 rollup 전체 삭제 */
async function deleteRollupsByLevel(
  db: DbClient,
  workspaceId: string,
  generationVersion: number,
  rollupLevel: string,
): Promise<void> {
  await db.delete(objectRollups).where(
    and(
      eq(objectRollups.workspaceId, workspaceId),
      eq(objectRollups.generationVersion, generationVersion),
      eq(objectRollups.rollupLevel, rollupLevel),
    ),
  );
}

/** affected 노드 관련 rollup edge 삭제 (subject OR object가 affected set에 포함) */
async function deleteRollupsByAffectedNodes(
  db: DbClient,
  workspaceId: string,
  generationVersion: number,
  rollupLevel: string,
  affectedIds: Set<string>,
): Promise<void> {
  if (affectedIds.size === 0) return;
  const idArray = [...affectedIds];
  await db.delete(objectRollups).where(
    and(
      eq(objectRollups.workspaceId, workspaceId),
      eq(objectRollups.generationVersion, generationVersion),
      eq(objectRollups.rollupLevel, rollupLevel),
      or(
        inArray(objectRollups.subjectObjectId, idArray),
        inArray(objectRollups.objectId, idArray),
      ),
    ),
  );
}

/**
 * S2S 증분 재계산
 * affected 서비스 관련 기존 edge 삭제 → 전체 call/expose 기반 재계산 후 affected 관련만 insert
 */
async function incrementalBuildS2S(
  db: DbClient,
  workspaceId: string,
  generationVersion: number,
  affectedServiceIds: Set<string>,
): Promise<void> {
  if (affectedServiceIds.size === 0) return;

  // 기존 affected 관련 S2S rollup 삭제
  await deleteRollupsByAffectedNodes(db, workspaceId, generationVersion, 'SERVICE_TO_SERVICE', affectedServiceIds);

  // 전체 call/expose relation 조회 (변경된 서비스의 edge를 정확히 재계산하려면 전체 필요)
  const callRelations = await db
    .select()
    .from(objectRelations)
    .where(
      and(
        eq(objectRelations.workspaceId, workspaceId),
        eq(objectRelations.relationType, 'call'),
        eq(objectRelations.isDerived, false),
        eq(objectRelations.status, 'APPROVED'),
      ),
    );

  const exposeRelations = await db
    .select()
    .from(objectRelations)
    .where(
      and(
        eq(objectRelations.workspaceId, workspaceId),
        eq(objectRelations.relationType, 'expose'),
        eq(objectRelations.isDerived, false),
        eq(objectRelations.status, 'APPROVED'),
      ),
    );

  // endpoint → 서비스 매핑
  const endpointToService = new Map<string, string>();
  for (const expose of exposeRelations) {
    endpointToService.set(expose.objectId, expose.subjectObjectId);
  }

  // S2S 집계 (affected 관련만 필터)
  const rollupMap = new Map<
    string,
    { edgeWeight: number; confidences: number[]; baseRelationIds: Set<string> }
  >();
  for (const call of callRelations) {
    const callerServiceId = call.subjectObjectId;
    const exposingServiceId = endpointToService.get(call.objectId);
    if (!exposingServiceId || callerServiceId === exposingServiceId) continue;

    // affected 서비스가 caller 또는 target인 경우만
    if (!affectedServiceIds.has(callerServiceId) && !affectedServiceIds.has(exposingServiceId)) continue;

    const key = `${callerServiceId}|${exposingServiceId}`;
    const existing = rollupMap.get(key) ?? {
      edgeWeight: 0,
      confidences: [],
      baseRelationIds: new Set<string>(),
    };
    existing.edgeWeight += 1;
    if (call.confidence != null) existing.confidences.push(call.confidence);
    existing.baseRelationIds.add(call.id);
    rollupMap.set(key, existing);
  }

  const rollups = [...rollupMap.entries()].map(
    ([key, { edgeWeight, confidences, baseRelationIds }]) => {
    const [subjectObjectId, objectId] = key.split('|') as [string, string];
    const confidence = confidences.length > 0
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : null;
    return {
      rollupLevel: 'SERVICE_TO_SERVICE',
      relationType: 'call',
      subjectObjectId,
      objectId,
      edgeWeight,
      confidence,
      baseRelationIds: [...baseRelationIds],
    };
  });

  await insertRollupsWithProvenance(db, workspaceId, generationVersion, rollups);
}

/**
 * S2DB 증분 재계산
 * affected 서비스의 read/write rollup만 삭제 후 재계산
 */
async function incrementalBuildS2DB(
  db: DbClient,
  workspaceId: string,
  generationVersion: number,
  affectedServiceIds: Set<string>,
): Promise<void> {
  if (affectedServiceIds.size === 0) return;

  // affected 서비스의 기존 S2DB rollup 삭제 (subject 기준)
  const idArray = [...affectedServiceIds];
  await db.delete(objectRollups).where(
    and(
      eq(objectRollups.workspaceId, workspaceId),
      eq(objectRollups.generationVersion, generationVersion),
      eq(objectRollups.rollupLevel, 'SERVICE_TO_DATABASE'),
      inArray(objectRollups.subjectObjectId, idArray),
    ),
  );

  // affected 서비스의 read/write relation 재조회 + parent join
  for (const relType of ['read', 'write']) {
    const relations = await db
      .select({
        relation: objectRelations,
        tableParentId: objects.parentId,
      })
      .from(objectRelations)
      .innerJoin(objects, eq(objectRelations.objectId, objects.id))
      .where(
        and(
          eq(objectRelations.workspaceId, workspaceId),
          eq(objectRelations.relationType, relType),
          eq(objectRelations.isDerived, false),
          eq(objectRelations.status, 'APPROVED'),
          inArray(objectRelations.subjectObjectId, idArray),
        ),
      );

    const rollupMap = new Map<
      string,
      { edgeWeight: number; confidences: number[]; baseRelationIds: Set<string> }
    >();
    for (const { relation, tableParentId } of relations) {
      if (!tableParentId) continue;
      const key = `${relation.subjectObjectId}|${tableParentId}`;
      const existing = rollupMap.get(key) ?? {
        edgeWeight: 0,
        confidences: [],
        baseRelationIds: new Set<string>(),
      };
      existing.edgeWeight += 1;
      if (relation.confidence != null) existing.confidences.push(relation.confidence);
      existing.baseRelationIds.add(relation.id);
      rollupMap.set(key, existing);
    }

    const rollups = [...rollupMap.entries()].map(
      ([key, { edgeWeight, confidences, baseRelationIds }]) => {
      const [subjectObjectId, objectId] = key.split('|') as [string, string];
      const confidence = confidences.length > 0
        ? confidences.reduce((a, b) => a + b, 0) / confidences.length
        : null;
      return {
        rollupLevel: 'SERVICE_TO_DATABASE',
        relationType: relType,
        subjectObjectId,
        objectId,
        edgeWeight,
        confidence,
        baseRelationIds: [...baseRelationIds],
      };
    });

    await insertRollupsWithProvenance(db, workspaceId, generationVersion, rollups);
  }
}

/**
 * S2B 증분 재계산
 * affected 서비스의 produce/consume rollup만 삭제 후 재계산
 */
async function incrementalBuildS2B(
  db: DbClient,
  workspaceId: string,
  generationVersion: number,
  affectedServiceIds: Set<string>,
): Promise<void> {
  if (affectedServiceIds.size === 0) return;

  const idArray = [...affectedServiceIds];
  await db.delete(objectRollups).where(
    and(
      eq(objectRollups.workspaceId, workspaceId),
      eq(objectRollups.generationVersion, generationVersion),
      eq(objectRollups.rollupLevel, 'SERVICE_TO_BROKER'),
      inArray(objectRollups.subjectObjectId, idArray),
    ),
  );

  for (const relType of ['produce', 'consume']) {
    const relations = await db
      .select({
        relation: objectRelations,
        topicParentId: objects.parentId,
      })
      .from(objectRelations)
      .innerJoin(objects, eq(objectRelations.objectId, objects.id))
      .where(
        and(
          eq(objectRelations.workspaceId, workspaceId),
          eq(objectRelations.relationType, relType),
          eq(objectRelations.isDerived, false),
          eq(objectRelations.status, 'APPROVED'),
          inArray(objectRelations.subjectObjectId, idArray),
        ),
      );

    const rollupMap = new Map<
      string,
      { edgeWeight: number; confidences: number[]; baseRelationIds: Set<string> }
    >();
    for (const { relation, topicParentId } of relations) {
      if (!topicParentId) continue;
      const key = `${relation.subjectObjectId}|${topicParentId}`;
      const existing = rollupMap.get(key) ?? {
        edgeWeight: 0,
        confidences: [],
        baseRelationIds: new Set<string>(),
      };
      existing.edgeWeight += 1;
      if (relation.confidence != null) existing.confidences.push(relation.confidence);
      existing.baseRelationIds.add(relation.id);
      rollupMap.set(key, existing);
    }

    const rollups = [...rollupMap.entries()].map(
      ([key, { edgeWeight, confidences, baseRelationIds }]) => {
      const [subjectObjectId, objectId] = key.split('|') as [string, string];
      const confidence = confidences.length > 0
        ? confidences.reduce((a, b) => a + b, 0) / confidences.length
        : null;
      return {
        rollupLevel: 'SERVICE_TO_BROKER',
        relationType: relType,
        subjectObjectId,
        objectId,
        edgeWeight,
        confidence,
        baseRelationIds: [...baseRelationIds],
      };
    });

    await insertRollupsWithProvenance(db, workspaceId, generationVersion, rollups);
  }
}

/**
 * 영향받는 level의 graph stats만 삭제 후 재계산
 */
async function incrementalBuildGraphStats(
  db: DbClient,
  workspaceId: string,
  generationVersion: number,
  affectedLevels: Set<AffectedRollupLevel>,
): Promise<void> {
  for (const level of affectedLevels) {
    // 해당 level의 기존 stats 삭제
    await db.delete(objectGraphStats).where(
      and(
        eq(objectGraphStats.workspaceId, workspaceId),
        eq(objectGraphStats.generationVersion, generationVersion),
        eq(objectGraphStats.rollupLevel, level),
      ),
    );

    // 해당 level의 rollup 데이터 조회
    const levelRollups = await db
      .select({
        subjectObjectId: objectRollups.subjectObjectId,
        objectId: objectRollups.objectId,
      })
      .from(objectRollups)
      .where(
        and(
          eq(objectRollups.workspaceId, workspaceId),
          eq(objectRollups.generationVersion, generationVersion),
          eq(objectRollups.rollupLevel, level),
        ),
      );

    if (levelRollups.length === 0) continue;

    const outMap = new Map<string, number>();
    const inMap = new Map<string, number>();
    for (const r of levelRollups) {
      outMap.set(r.subjectObjectId, (outMap.get(r.subjectObjectId) ?? 0) + 1);
      inMap.set(r.objectId, (inMap.get(r.objectId) ?? 0) + 1);
    }

    const allNodeIds = new Set([...outMap.keys(), ...inMap.keys()]);
    const statsRows = [...allNodeIds].map((nodeId) => ({
      workspaceId,
      generationVersion,
      rollupLevel: level,
      objectId: nodeId,
      outDegree: outMap.get(nodeId) ?? 0,
      inDegree: inMap.get(nodeId) ?? 0,
    }));

    if (statsRows.length > 0) {
      await db.insert(objectGraphStats).values(statsRows);
    }
  }
}
