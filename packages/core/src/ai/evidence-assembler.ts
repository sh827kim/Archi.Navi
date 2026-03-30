/**
 * Evidence Assembler (Phase 2, 2-2)
 *
 * QueryResponse(결정론적 쿼리 결과)를 받아 LLM에 주입할 증거 체인을 구조화한다.
 *
 * 설계 참조: docs/archive/ArchiNavi_AI_Reasoning_레이어_설계안_v1.md §4
 * 로드맵: docs/08-roadmap.md §2-2
 *
 * 선택 기준:
 *  1. score = confidence × edgeWeight / (hop + 1) 내림차순
 *  2. 동점 시: edgeWeight → confidence → hop 순
 *  3. 최대 MAX_EVIDENCE_COUNT(10)개 제한
 *
 * 출력 형식: formatEvidenceChain()으로 Chat API 시스템 프롬프트에 주입 가능한 텍스트 생성
 */
import { inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { relationEvidences, evidences } from '@archi-navi/db';
import type { QueryResponse } from '@archi-navi/shared';

// ─── 타입 정의 ────────────────────────────────────────────────────────────────

/** 증거 체인 개별 항목 */
export interface EvidenceItem {
    /** 증거 유형: rollup(집계 엣지) | code(코드 파일) | config(설정) | db(DB 스키마) */
    type: 'rollup' | 'code' | 'config' | 'db';
    /** 호출/관계 주체 서비스/객체 ID */
    sourceId: string;
    /** 호출/관계 주체 서비스/객체 이름 */
    sourceName: string;
    /** 호출/관계 대상 서비스/객체 ID */
    targetId: string;
    /** 호출/관계 대상 서비스/객체 이름 */
    targetName: string;
    /** 관계 타입 (call, expose, read, write, produce, consume) */
    relationType: string;
    /** 신뢰도 (0~1) */
    confidence: number;
    /** 롤업 엣지 가중치 (관계를 뒷받침하는 base relation 수) */
    edgeWeight: number;
    /** 탐색 출발점으로부터의 홉 거리 (0부터 시작) */
    hop: number;
    /** 코드 파일 경로 (code 타입인 경우) */
    filePath?: string;
    /** 코드 시작 라인 */
    lineStart?: number;
    /** 코드 종료 라인 */
    lineEnd?: number;
    /** 코드 발췌문 */
    excerpt?: string;
    /** 외부 URI (config, db 타입인 경우) */
    uri?: string;
    /**
     * 정렬 점수: confidence × edgeWeight / (hop + 1)
     * 신뢰도 높고, 관계가 많이 관측되고, 가까울수록 높음
     */
    score: number;
}

/** 조립된 증거 체인 */
export interface EvidenceChain {
    /** 우선순위 정렬된 증거 목록 (max MAX_EVIDENCE_COUNT개) */
    items: EvidenceItem[];
    /** 우선순위 선택 이전의 전체 증거 수 */
    totalCount: number;
    /** MAX_EVIDENCE_COUNT 초과로 잘렸는지 여부 */
    truncated: boolean;
    /** 원본 쿼리 타입 */
    queryType: string;
}

/** 어셈블러 옵션 */
export interface AssembleOptions {
    /** 최대 증거 수 (기본: 10) */
    maxCount?: number;
    /** 최소 confidence 필터 (기본: 0) */
    minConfidence?: number;
}

const MAX_EVIDENCE_COUNT = 10;

// ─── 점수 계산 ────────────────────────────────────────────────────────────────

/**
 * 증거 항목의 우선순위 점수 계산
 * score = confidence × edgeWeight / (hop + 1)
 */
function calcScore(confidence: number, edgeWeight: number, hop: number): number {
    return (confidence * edgeWeight) / (hop + 1);
}

function makeEvidenceDedupKey(item: EvidenceItem): string {
    return [
        item.type,
        item.sourceId,
        item.targetId,
        item.relationType,
        item.filePath ?? '',
        item.lineStart?.toString() ?? '',
        item.lineEnd?.toString() ?? '',
        item.uri ?? '',
        item.excerpt ?? '',
    ].join('|');
}

function dedupeEvidenceItems(items: EvidenceItem[]): EvidenceItem[] {
    const deduped = new Map<string, EvidenceItem>();
    for (const item of items) {
        const key = makeEvidenceDedupKey(item);
        const existing = deduped.get(key);

        if (!existing) {
            deduped.set(key, item);
            continue;
        }

        // 동일 evidence key라면 점수가 더 높은 항목을 유지한다.
        if (
            item.score > existing.score
            || (item.score === existing.score && item.edgeWeight > existing.edgeWeight)
            || (
                item.score === existing.score
                && item.edgeWeight === existing.edgeWeight
                && item.confidence > existing.confidence
            )
        ) {
            deduped.set(key, item);
        }
    }
    return [...deduped.values()];
}

// ─── 핵심 함수 ────────────────────────────────────────────────────────────────

/**
 * QueryResponse의 엣지에서 각 엣지의 홉 거리를 추론한다.
 * BFS 탐색 결과에서 paths가 있으면 paths 기반, 없으면 nodes 순서 기반.
 */
function buildHopMap(queryResponse: QueryResponse): Map<string, number> {
    const hopMap = new Map<string, number>(); // edgeKey → hop

    const { edges, paths, nodes } = queryResponse.result;

    if (paths && paths.length > 0) {
        // PATH_DISCOVERY: paths[0] 기준 홉 거리 계산
        for (const path of paths) {
            path.nodeIds.forEach((nodeId, idx) => {
                if (idx === 0) return;
                const prevNodeId = path.nodeIds[idx - 1];
                if (!prevNodeId) return;
                const key = `${prevNodeId}→${nodeId}`;
                const existingHop = hopMap.get(key);
                if (existingHop === undefined || idx - 1 < existingHop) {
                    hopMap.set(key, idx - 1); // hop = edge index
                }
            });
        }
    } else {
        // IMPACT_ANALYSIS/USAGE_DISCOVERY: nodes 배열 순서에서 depth 사용
        const nodeDepthMap = new Map<string, number>();
        for (const node of nodes) {
            nodeDepthMap.set(node.id, node.depth ?? 0);
        }

        for (const edge of edges) {
            const subjectDepth = nodeDepthMap.get(edge.subjectId) ?? 0;
            const key = `${edge.subjectId}→${edge.objectId}`;
            hopMap.set(key, subjectDepth);
        }
    }

    return hopMap;
}

/**
 * QueryResponse → EvidenceChain 조립
 *
 * 1. QueryResponse.result.edges → 롤업 수준 EvidenceItem 생성
 * 2. edges의 provenance.baseRelationIds → relation_evidences → evidences 조회
 * 3. 파일 경로/라인/excerpt를 각 롤업 EvidenceItem에 연결
 * 4. score 기준 내림차순 정렬 후 maxCount개 slice
 */
export async function assembleEvidenceChain(
    db: DbClient,
    queryResponse: QueryResponse,
    options: AssembleOptions = {},
): Promise<EvidenceChain> {
    const maxCount = options.maxCount ?? MAX_EVIDENCE_COUNT;
    const minConfidence = options.minConfidence ?? 0;

    const { edges, nodes } = queryResponse.result;

    // 노드 이름 조회용 맵
    const nodeNameMap = new Map<string, string>();
    for (const node of nodes) {
        nodeNameMap.set(node.id, node.displayName ?? node.name);
    }

    // 홉 거리 맵 계산
    const hopMap = buildHopMap(queryResponse);

    // ─── 1. 롤업 엣지 → EvidenceItem 변환 ───────────────────────────────────

    // baseRelationId 전체 수집 (중복 제거)
    const allBaseRelationIds = new Set<string>();
    for (const edge of edges) {
        for (const relId of (edge.provenance?.baseRelationIds ?? [])) {
            allBaseRelationIds.add(relId);
        }
    }

    // ─── 2. DB에서 evidences 조회 ─────────────────────────────────────────────

    // relationId → evidenceRows 맵 구성
    const relationEvidenceMap = new Map<string, Array<typeof evidences.$inferSelect>>();

    if (allBaseRelationIds.size > 0) {
        const relIds = [...allBaseRelationIds];
        try {
            // 1단계: relation_evidences에서 relationId → evidenceId 매핑 조회
            const reRows = await db
                .select()
                .from(relationEvidences)
                .where(inArray(relationEvidences.relationId, relIds));

            // 2단계: evidences 조회
            const evIds = [...new Set(reRows.map((r) => r.evidenceId))];
            if (evIds.length > 0) {
                const evRows = await db
                    .select()
                    .from(evidences)
                    .where(inArray(evidences.id, evIds));

                const evMap = new Map(evRows.map((e) => [e.id, e]));
                for (const re of reRows) {
                    const ev = evMap.get(re.evidenceId);
                    if (!ev) continue;
                    const existing = relationEvidenceMap.get(re.relationId) ?? [];
                    existing.push(ev);
                    relationEvidenceMap.set(re.relationId, existing);
                }
            }
        } catch {
            // DB 조회 실패 시 롤업 정보만 사용
        }
    }

    // ─── 3. EvidenceItem 목록 구성 ────────────────────────────────────────────

    const allItems: EvidenceItem[] = [];

    for (const edge of edges) {
        if (edge.confidence < minConfidence) continue;

        const edgeKey = `${edge.subjectId}→${edge.objectId}`;
        const hop = hopMap.get(edgeKey) ?? 0;
        const sourceName = nodeNameMap.get(edge.subjectId) ?? edge.subjectId;
        const targetName = nodeNameMap.get(edge.objectId) ?? edge.objectId;

        const baseRelIds = edge.provenance?.baseRelationIds ?? [];
        const evidenceRows = baseRelIds.flatMap((relId) => relationEvidenceMap.get(relId) ?? []);

        if (evidenceRows.length === 0) {
            // 롤업 evidence만 있는 경우 (베이스 relation evidence 없음)
            allItems.push({
                type: 'rollup',
                sourceId: edge.subjectId,
                sourceName,
                targetId: edge.objectId,
                targetName,
                relationType: edge.relationType,
                confidence: edge.confidence,
                edgeWeight: edge.edgeWeight,
                hop,
                score: calcScore(edge.confidence, edge.edgeWeight, hop),
            });
        } else {
            // 각 베이스 evidence별로 EvidenceItem 생성
            for (const ev of evidenceRows) {
                const evType = mapEvidenceType(ev.evidenceType);
                const item: EvidenceItem = {
                    type: evType,
                    sourceId: edge.subjectId,
                    sourceName,
                    targetId: edge.objectId,
                    targetName,
                    relationType: edge.relationType,
                    confidence: edge.confidence,
                    edgeWeight: edge.edgeWeight,
                    hop,
                    score: calcScore(edge.confidence, edge.edgeWeight, hop),
                };
                // exactOptionalPropertyTypes 준수: null이 아닐 때만 할당
                if (ev.filePath !== null) item.filePath = ev.filePath;
                if (ev.lineStart !== null) item.lineStart = ev.lineStart;
                if (ev.lineEnd !== null) item.lineEnd = ev.lineEnd;
                if (ev.excerpt !== null) item.excerpt = ev.excerpt;
                if (ev.uri !== null) item.uri = ev.uri;
                allItems.push(item);
            }
        }
    }

    // ─── 4. 정렬 및 slice ─────────────────────────────────────────────────────

    const uniqueItems = dedupeEvidenceItems(allItems);

    uniqueItems.sort((a, b) => {
        // 1차: score 내림차순
        if (b.score !== a.score) return b.score - a.score;
        // 2차: edgeWeight 내림차순
        if (b.edgeWeight !== a.edgeWeight) return b.edgeWeight - a.edgeWeight;
        // 3차: confidence 내림차순
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        // 4차: hop 오름차순 (가까운 것 우선)
        return a.hop - b.hop;
    });

    const totalCount = uniqueItems.length;
    const items = uniqueItems.slice(0, maxCount);

    return {
        items,
        totalCount,
        truncated: totalCount > maxCount,
        queryType: queryResponse.queryType,
    };
}

// ─── 텍스트 포맷터 ───────────────────────────────────────────────────────────

/**
 * EvidenceChain → Chat API 시스템 프롬프트 주입용 텍스트 변환
 *
 * 출력 형식:
 * ```
 * [아키텍처 분석 결과 — IMPACT_ANALYSIS]
 * 총 N개의 관계 증거 발견 (상위 10개 표시)
 *
 * 1. order-service → payment-service (call, confidence: 0.91, weight: 7)
 *    파일: OrderController.java:120-145
 *    발췌: restTemplate.getForObject("http://payment-service/pay", ...)
 *
 * 2. ...
 * ```
 */
export function formatEvidenceChain(chain: EvidenceChain): string {
    if (chain.items.length === 0) {
        return '';
    }

    const header = chain.truncated
        ? `[아키텍처 분석 결과 — ${chain.queryType}]\n총 ${chain.totalCount}개의 관계 증거 발견 (상위 ${chain.items.length}개 표시)\n`
        : `[아키텍처 분석 결과 — ${chain.queryType}]\n총 ${chain.totalCount}개의 관계 증거 발견\n`;

    const lines = chain.items.map((item, idx) => {
        const parts: string[] = [];

        // 기본 관계 정보
        const confidencePct = (item.confidence * 100).toFixed(0);
        parts.push(
            `${idx + 1}. ${item.sourceName} → ${item.targetName}` +
            ` (${item.relationType}, confidence: ${item.confidence.toFixed(2)}, weight: ${item.edgeWeight}, confidence%: ${confidencePct}%)`,
        );

        // 파일 위치
        if (item.filePath) {
            const loc = item.lineStart
                ? `${item.filePath}:${item.lineStart}${item.lineEnd && item.lineEnd !== item.lineStart ? `-${item.lineEnd}` : ''}`
                : item.filePath;
            parts.push(`   파일: ${loc}`);
        }

        // URI (config/db 타입)
        if (item.uri) {
            parts.push(`   URI: ${item.uri}`);
        }

        // 코드 발췌
        if (item.excerpt) {
            const trimmed = item.excerpt.length > 120
                ? item.excerpt.slice(0, 120) + '...'
                : item.excerpt;
            parts.push(`   발췌: ${trimmed}`);
        }

        // 홉 거리
        if (item.hop > 0) {
            parts.push(`   홉 거리: ${item.hop}`);
        }

        return parts.join('\n');
    });

    return header + '\n' + lines.join('\n\n');
}

// ─── 내부 헬퍼 ───────────────────────────────────────────────────────────────

function mapEvidenceType(evidenceType: string): EvidenceItem['type'] {
    switch (evidenceType.toUpperCase()) {
        case 'FILE': return 'code';
        case 'CONFIG': return 'config';
        case 'SCHEMA':
        case 'DB_SCHEMA': return 'db';
        default: return 'rollup';
    }
}
