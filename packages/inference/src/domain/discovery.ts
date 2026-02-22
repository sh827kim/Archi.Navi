/**
 * Track B: Seed-less Domain Discovery
 * graphology + Louvain 커뮤니티 탐지로 도메인 군집 자동 발견
 *
 * 1-5 다중 레이어 통합:
 * - enabled_layers (프로필 설정) 에 따라 call/db/msg 레이어 선택적 사용
 * - 엣지 가중치: edge_w_call / edge_w_rw / edge_w_msg 프로필 값 적용
 */
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { eq, and } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
    objectRollups,
    domainDiscoveryRuns,
    domainDiscoveryMemberships,
    domainInferenceProfiles,
    objects,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';

interface DiscoveryOptions {
    workspaceId: string;
    profileId?: string;
    generationVersion: number;
    /** 최소 클러스터 크기 (프로필보다 우선) */
    minClusterSize?: number;
    /** Louvain resolution (프로필보다 우선) */
    resolution?: number;
}

/** 프로필에서 추출한 가중치 설정 */
interface EdgeWeights {
    call: number; // SERVICE_TO_SERVICE
    rw: number;   // SERVICE_TO_DATABASE
    msg: number;  // SERVICE_TO_BROKER
}

/**
 * Seed-less Discovery 실행
 * 1. 프로필에서 enabled_layers / 엣지 가중치 조회
 * 2. 활성화된 레이어의 rollup으로 가중 그래프 구성
 * 3. Louvain 커뮤니티 탐지
 * 4. Domain object 생성 + 멤버십 저장
 */
export async function runDiscovery(
    db: DbClient,
    options: DiscoveryOptions,
): Promise<{ runId: string; clusterCount: number }> {
    const {
        workspaceId,
        profileId,
        generationVersion,
        minClusterSize: minClusterSizeOpt,
        resolution: resolutionOpt,
    } = options;

    // 프로필 조회
    let profile: {
        edgeWCall: number | null;
        edgeWRw: number | null;
        edgeWMsg: number | null;
        enabledLayers: unknown;
        minClusterSize: number | null;
        resolution: number | null;
    } | null = null;

    if (profileId) {
        const rows = await db
            .select({
                edgeWCall: domainInferenceProfiles.edgeWCall,
                edgeWRw: domainInferenceProfiles.edgeWRw,
                edgeWMsg: domainInferenceProfiles.edgeWMsg,
                enabledLayers: domainInferenceProfiles.enabledLayers,
                minClusterSize: domainInferenceProfiles.minClusterSize,
                resolution: domainInferenceProfiles.resolution,
            })
            .from(domainInferenceProfiles)
            .where(
                and(
                    eq(domainInferenceProfiles.id, profileId),
                    eq(domainInferenceProfiles.workspaceId, workspaceId),
                ),
            )
            .limit(1);
        profile = rows[0] ?? null;
    }

    // 파라미터 결정 (옵션 > 프로필 > 기본값)
    const minClusterSize = minClusterSizeOpt ?? profile?.minClusterSize ?? 3;
    const resolution = resolutionOpt ?? profile?.resolution ?? 1.0;

    // enabled_layers: 'call' | 'db' | 'msg' | 'code'
    // 기본값: ['call', 'db', 'msg'] ('code'는 아직 rollup 미구현)
    const enabledLayers: string[] = Array.isArray(profile?.enabledLayers)
        ? (profile.enabledLayers as string[])
        : ['call', 'db', 'msg'];

    // 엣지 가중치 (프로필 > 기본값)
    const edgeWeights: EdgeWeights = {
        call: profile?.edgeWCall ?? 1.0,
        rw: profile?.edgeWRw ?? 0.8,
        msg: profile?.edgeWMsg ?? 0.6,
    };

    const runId = generateId();
    const startedAt = new Date();

    // 실제 사용된 레이어 목록
    const actualInputLayers: string[] = [];
    if (enabledLayers.includes('call')) actualInputLayers.push('call');
    if (enabledLayers.includes('db')) actualInputLayers.push('db');
    if (enabledLayers.includes('msg')) actualInputLayers.push('msg');

    // Discovery run 기록 시작
    await db.insert(domainDiscoveryRuns).values({
        id: runId,
        workspaceId,
        ...(profileId ? { profileId } : {}),
        algo: 'louvain',
        algoVersion: '1.0',
        inputLayers: actualInputLayers,
        parameters: {
            minClusterSize,
            resolution,
            edgeWeights,
        },
        graphStats: {},
        status: 'DONE',
        startedAt,
    });

    // graphology 가중 그래프 구성
    const graph = new Graph({ multi: false, type: 'undirected' });

    /** 노드가 없으면 추가 */
    function ensureNode(nodeId: string): void {
        if (!graph.hasNode(nodeId)) graph.addNode(nodeId);
    }

    /** 동일 노드 쌍의 가중치 누적 (undirected) */
    function addOrMergeEdge(nodeA: string, nodeB: string, weight: number): void {
        if (weight <= 0) return; // 0 이하 가중치는 추가하지 않음
        const edgeKey = [nodeA, nodeB].sort().join('--');
        if (graph.hasEdge(edgeKey)) {
            graph.updateEdgeAttribute(edgeKey, 'weight', (w: number) => w + weight);
        } else {
            graph.addEdgeWithKey(edgeKey, nodeA, nodeB, { weight });
        }
    }

    // 1. SERVICE_TO_SERVICE rollup (call 레이어)
    if (enabledLayers.includes('call')) {
        const s2sEdges = await db
            .select()
            .from(objectRollups)
            .where(
                and(
                    eq(objectRollups.workspaceId, workspaceId),
                    eq(objectRollups.generationVersion, generationVersion),
                    eq(objectRollups.rollupLevel, 'SERVICE_TO_SERVICE'),
                ),
            );

        for (const edge of s2sEdges) {
            ensureNode(edge.subjectObjectId);
            ensureNode(edge.objectId);
            addOrMergeEdge(
                edge.subjectObjectId,
                edge.objectId,
                edgeWeights.call * edge.edgeWeight,
            );
        }
    }

    // 2. SERVICE_TO_DATABASE rollup (db 레이어)
    if (enabledLayers.includes('db')) {
        const s2dbEdges = await db
            .select()
            .from(objectRollups)
            .where(
                and(
                    eq(objectRollups.workspaceId, workspaceId),
                    eq(objectRollups.generationVersion, generationVersion),
                    eq(objectRollups.rollupLevel, 'SERVICE_TO_DATABASE'),
                ),
            );

        for (const edge of s2dbEdges) {
            ensureNode(edge.subjectObjectId);
            ensureNode(edge.objectId);
            addOrMergeEdge(
                edge.subjectObjectId,
                edge.objectId,
                edgeWeights.rw * edge.edgeWeight,
            );
        }
    }

    // 3. SERVICE_TO_BROKER rollup (msg 레이어)
    if (enabledLayers.includes('msg')) {
        const s2brokerEdges = await db
            .select()
            .from(objectRollups)
            .where(
                and(
                    eq(objectRollups.workspaceId, workspaceId),
                    eq(objectRollups.generationVersion, generationVersion),
                    eq(objectRollups.rollupLevel, 'SERVICE_TO_BROKER'),
                ),
            );

        for (const edge of s2brokerEdges) {
            ensureNode(edge.subjectObjectId);
            ensureNode(edge.objectId);
            addOrMergeEdge(
                edge.subjectObjectId,
                edge.objectId,
                edgeWeights.msg * edge.edgeWeight,
            );
        }
    }

    // 그래프가 비어있으면 조기 반환
    if (graph.order === 0) {
        return { runId, clusterCount: 0 };
    }

    // Louvain 커뮤니티 탐지
    const communities: Record<string, number> = louvain(graph, {
        resolution,
        getEdgeWeight: 'weight',
    });

    // 클러스터별 멤버 그룹화
    const clusters = new Map<number, string[]>();
    for (const [nodeId, clusterId] of Object.entries(communities)) {
        const members = clusters.get(clusterId) ?? [];
        members.push(nodeId);
        clusters.set(clusterId, members);
    }

    // min_cluster_size 이상인 클러스터만 처리
    const validClusters = [...clusters.entries()].filter(
        ([, members]) => members.length >= minClusterSize,
    );

    for (const [clusterId, members] of validClusters) {
        // Domain object 생성 (kind=DISCOVERED)
        const domainId = generateId();
        const clusterName = `cluster-${clusterId}`;

        await db.insert(objects).values({
            id: domainId,
            workspaceId,
            objectType: 'domain',
            category: null,
            granularity: 'COMPOUND',
            name: `discovered:${clusterName}`,
            displayName: `Cluster ${clusterId}`,
            path: `/${domainId}`,
            depth: 0,
            visibility: 'VISIBLE',
            metadata: {
                kind: 'DISCOVERED',
                clusterId: `c-${clusterId}`,
                algo: 'louvain',
                algoVersion: '1.0',
                inputLayers: actualInputLayers,
                labelCandidates: [], // 1-6에서 구현
            },
        });

        // 멤버십 저장
        for (const memberId of members) {
            await db.insert(domainDiscoveryMemberships).values({
                id: generateId(),
                workspaceId,
                runId,
                objectId: memberId,
                domainId,
                affinity: 1.0,
                purity: null,
            });
        }
    }

    // run 완료 기록
    await db
        .update(domainDiscoveryRuns)
        .set({
            finishedAt: new Date(),
            graphStats: {
                nodeCount: graph.order,
                edgeCount: graph.size,
                clusterCount: validClusters.length,
            },
        })
        .where(eq(domainDiscoveryRuns.id, runId));

    return { runId, clusterCount: validClusters.length };
}
