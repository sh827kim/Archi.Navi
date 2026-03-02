'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn, Spinner } from '@archi-navi/ui';
import { useWorkspace } from '@/contexts/workspace-context';
import {
  RollupGraph3D,
  type RollupGraph3DLink,
  type RollupGraph3DNode,
} from './rollup-graph-3d';

interface ObjectItem {
  id: string;
  name: string;
  displayName: string | null;
  objectType: string;
  granularity: string;
  parentId: string | null;
  depth: number;
}

interface RelationItem {
  id: string;
  subjectObjectId: string;
  objectId: string;
  relationType: string;
}

type ViewLevel =
  | 'SERVICE_TO_SERVICE'
  | 'SERVICE_TO_DATABASE'
  | 'SERVICE_TO_BROKER'
  | 'DOMAIN_TO_DOMAIN'
  | 'COMPOUND_VIEW'
  | 'UNUSED_ATOMIC';

type RollupLevelKey =
  | 'SERVICE_TO_SERVICE'
  | 'SERVICE_TO_DATABASE'
  | 'SERVICE_TO_BROKER'
  | 'DOMAIN_TO_DOMAIN';

interface RollupEdgeApiItem {
  id: string;
  source: string;
  target: string;
  relationType: string;
}

interface GraphStatApiItem {
  objectId: string;
  inDegree: number;
  outDegree: number;
}

interface DomainAffinityApiItem {
  objectId: string;
  domainId: string;
  affinity: number;
}

type RollupRelationMap = Record<RollupLevelKey, RelationItem[]>;
type RollupGraphStatsMap = Record<RollupLevelKey, GraphStatApiItem[]>;

const ROLLUP_HUB_THRESHOLD_KEY = 'archi-navi:rollup:hub-threshold';
const DEFAULT_HUB_THRESHOLD = 50;

const LEVEL_TYPES: Partial<Record<ViewLevel, string[]>> = {
  SERVICE_TO_SERVICE: ['service'],
  SERVICE_TO_DATABASE: ['service', 'database'],
  SERVICE_TO_BROKER: ['service', 'message_broker', 'topic', 'kafka_topic'],
  DOMAIN_TO_DOMAIN: ['domain'],
};

const PANEL_RELATION_TYPES: Partial<Record<ViewLevel, string[]>> = {
  SERVICE_TO_SERVICE: ['call', 'depend_on'],
  SERVICE_TO_DATABASE: ['read', 'write'],
  SERVICE_TO_BROKER: ['produce', 'consume'],
};

const VIEW_LEVELS: { value: ViewLevel; label: string; color: string }[] = [
  { value: 'SERVICE_TO_SERVICE', label: '서비스 ↔ 서비스', color: '#3b82f6' },
  { value: 'SERVICE_TO_DATABASE', label: '서비스 ↔ DB', color: '#10b981' },
  { value: 'SERVICE_TO_BROKER', label: '서비스 ↔ 브로커', color: '#f59e0b' },
  { value: 'DOMAIN_TO_DOMAIN', label: '도메인 ↔ 도메인', color: '#8b5cf6' },
  { value: 'COMPOUND_VIEW', label: '전체 통합 뷰', color: '#f43f5e' },
  { value: 'UNUSED_ATOMIC', label: '미사용 Atomic', color: '#f97316' },
];

const NODE_COLORS: Record<string, string> = {
  service: '#818cf8',
  api_endpoint: '#c084fc',
  database: '#34d399',
  db_table: '#22d3ee',
  topic: '#fbbf24',
  kafka_topic: '#fbbf24',
  message_broker: '#fbbf24',
  domain: '#22d3ee',
  default: '#94a3b8',
};

const EDGE_COLORS: Record<string, string> = {
  call: '#818cf8',
  expose: '#c084fc',
  read: '#34d399',
  write: '#4ade80',
  produce: '#fbbf24',
  consume: '#fb923c',
  depend_on: '#94a3b8',
  contains: '#f87171',
};

interface CallerInfo {
  compound: { id: string; label: string };
  relationType: string;
}

interface ExposedAtomicInfo {
  id: string;
  label: string;
  objectType: string;
  callers: CallerInfo[];
}

interface ReferencedAtomicInfo {
  id: string;
  label: string;
  objectType: string;
  relationType: string;
  provider: { id: string; label: string } | null;
}

interface RollDownPanelItem {
  targetId: string;
  targetLabel: string;
  targetObjectType: string;
  exposedAtomics: ExposedAtomicInfo[];
  referencedAtomics: ReferencedAtomicInfo[];
}

interface UnusedAtomicItem {
  atomicId: string;
  atomicLabel: string;
  atomicObjectType: string;
  parentCompoundId: string;
  parentCompoundLabel: string;
}

type ContributorGroupBy = 'targetCompound' | 'relationType' | 'sourceAtomic' | 'targetAtomic';
type ContributorScopeMode = 'SUBTREE' | 'GLOBAL';

interface ContributorEvidenceItem {
  id: string;
  evidenceType: string;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  excerpt: string | null;
}

interface ContributorRelationItem {
  relationId: string;
  relationType: string;
  confidence: number | null;
  sourceAtomicId: string;
  sourceAtomicLabel: string;
  sourceCompoundId: string;
  sourceCompoundLabel: string;
  targetAtomicId: string;
  targetAtomicLabel: string;
  targetCompoundId: string;
  targetCompoundLabel: string;
  evidenceCount: number;
  evidences: ContributorEvidenceItem[];
}

interface ContributorGroupItem {
  groupKey: string;
  groupLabel?: string;
  weight: number;
  relations: ContributorRelationItem[];
}

interface ContributorResponse {
  summary: {
    totalCount: number;
    byRelationType: Record<string, number>;
  };
  groups: ContributorGroupItem[];
  scopeMode: ContributorScopeMode;
  pageInfo?: {
    limit: number;
    hasNext: boolean;
    nextCursor: string | null;
  };
}

const USAGE_RELATION_TYPES = new Set(['call', 'consume', 'produce', 'read', 'write']);

function buildUsedAtomicIdSet(relations: RelationItem[]): Set<string> {
  const usedIds = new Set<string>();
  for (const relation of relations) {
    if (!USAGE_RELATION_TYPES.has(relation.relationType)) continue;
    usedIds.add(relation.subjectObjectId);
    usedIds.add(relation.objectId);
  }
  return usedIds;
}

function parseHubThreshold(value: string | null): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_HUB_THRESHOLD;
  return Math.min(500, Math.max(5, parsed));
}

export function RollupGraph() {
  const { workspaceId } = useWorkspace();

  const [loading, setLoading] = useState(true);
  const [isEmpty, setIsEmpty] = useState(false);
  const [viewLevel, setViewLevel] = useState<ViewLevel>('DOMAIN_TO_DOMAIN');
  const [expandedSet, setExpandedSet] = useState<Set<string>>(new Set());
  const [hubThreshold, setHubThreshold] = useState(DEFAULT_HUB_THRESHOLD);
  const [isHubCollapsed, setIsHubCollapsed] = useState(false);
  const [hubNodeCount, setHubNodeCount] = useState(0);
  const [graph3DData, setGraph3DData] = useState<{
    nodes: RollupGraph3DNode[];
    links: RollupGraph3DLink[];
  }>({ nodes: [], links: [] });
  const [selectedDomain, setSelectedDomain] = useState<{ id: string; label: string } | null>(null);
  const [selectedService, setSelectedService] = useState<{ id: string; label: string } | null>(null);
  const [hasDomainObjects, setHasDomainObjects] = useState(false);
  const [showE2ENodeActions, setShowE2ENodeActions] = useState(false);
  const [showE2ELinkActions, setShowE2ELinkActions] = useState(false);
  const [rollDownInfo, setRollDownInfo] = useState<RollDownPanelItem[]>([]);
  const [selectedContributorLink, setSelectedContributorLink] = useState<RollupGraph3DLink | null>(null);
  const [contributorGroupBy, setContributorGroupBy] = useState<ContributorGroupBy>('targetCompound');
  const [contributorScopeMode, setContributorScopeMode] = useState<ContributorScopeMode>('SUBTREE');
  const [contributorLoading, setContributorLoading] = useState(false);
  const [contributorError, setContributorError] = useState<string | null>(null);
  const [contributorData, setContributorData] = useState<ContributorResponse | null>(null);
  const [contributorNextCursor, setContributorNextCursor] = useState<string | null>(null);
  const [contributorLoadingMore, setContributorLoadingMore] = useState(false);
  const [unusedAtomicItems, setUnusedAtomicItems] = useState<UnusedAtomicItem[]>([]);

  useEffect(() => {
    setSelectedDomain(null);
    setSelectedService(null);
    setExpandedSet(new Set());
    setSelectedContributorLink(null);
    setContributorScopeMode('SUBTREE');
    setContributorGroupBy('targetCompound');
    setContributorData(null);
    setContributorError(null);
    setContributorNextCursor(null);
    setContributorLoadingMore(false);
    setUnusedAtomicItems([]);
  }, [workspaceId]);

  useEffect(() => {
    try {
      setShowE2ENodeActions(window.localStorage.getItem('archi-navi:e2e-node-actions') === '1');
      setShowE2ELinkActions(window.localStorage.getItem('archi-navi:e2e-link-actions') === '1');
    } catch {
      setShowE2ENodeActions(false);
      setShowE2ELinkActions(false);
    }
  }, []);

  const handleNodePrimaryAction = useCallback(
    (node: { id: string; objectType: string; isCompound: boolean; label: string }) => {
      if (viewLevel === 'UNUSED_ATOMIC') {
        return;
      }

      if (viewLevel === 'DOMAIN_TO_DOMAIN' && node.objectType === 'domain') {
        setSelectedDomain({ id: node.id, label: node.label });
        setSelectedService(null);
        setExpandedSet(new Set());
        setViewLevel('SERVICE_TO_SERVICE');
        return;
      }

      if (
        viewLevel === 'SERVICE_TO_SERVICE' &&
        selectedDomain &&
        node.objectType === 'service' &&
        node.isCompound
      ) {
        setSelectedService({ id: node.id, label: node.label });
        setExpandedSet(new Set([node.id]));
        return;
      }

      if (node.isCompound && viewLevel !== 'COMPOUND_VIEW') {
        setExpandedSet((prev) => {
          const next = new Set(prev);
          if (next.has(node.id)) next.delete(node.id);
          else next.add(node.id);
          return next;
        });
      }
    },
    [viewLevel, selectedDomain],
  );

  useEffect(() => {
    const syncThreshold = () => {
      const nextValue = parseHubThreshold(window.localStorage.getItem(ROLLUP_HUB_THRESHOLD_KEY));
      setHubThreshold(nextValue);
    };

    syncThreshold();

    const onStorage = (event: StorageEvent) => {
      if (event.key === ROLLUP_HUB_THRESHOLD_KEY) syncThreshold();
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', syncThreshold);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', syncThreshold);
    };
  }, []);

  const fetchData = useCallback(async (includeRelations: boolean) => {
    const rollupLevels: RollupLevelKey[] = [
      'SERVICE_TO_SERVICE',
      'SERVICE_TO_DATABASE',
      'SERVICE_TO_BROKER',
      'DOMAIN_TO_DOMAIN',
    ];

    const [objRes, affinityRes, ...rollupResList] = await Promise.all([
      fetch(`/api/objects?workspaceId=${workspaceId}`),
      fetch(`/api/domain-affinities?workspaceId=${workspaceId}`),
      ...rollupLevels.map((level) => fetch(`/api/rollups?workspaceId=${workspaceId}&level=${level}`)),
    ]);

    if (!objRes.ok || !affinityRes.ok || rollupResList.some((res) => !res.ok)) {
      throw new Error('데이터 로드 실패');
    }

    const allObjects = (await objRes.json()) as ObjectItem[];
    const allDomainAffinities = (await affinityRes.json()) as DomainAffinityApiItem[];

    let allRelations: RelationItem[] = [];
    if (includeRelations) {
      const relRes = await fetch(`/api/relations?workspaceId=${workspaceId}`);
      if (!relRes.ok) throw new Error('관계 데이터 로드 실패');
      allRelations = (await relRes.json()) as RelationItem[];
    }

    const rollups: RollupRelationMap = {
      SERVICE_TO_SERVICE: [],
      SERVICE_TO_DATABASE: [],
      SERVICE_TO_BROKER: [],
      DOMAIN_TO_DOMAIN: [],
    };
    const graphStats: RollupGraphStatsMap = {
      SERVICE_TO_SERVICE: [],
      SERVICE_TO_DATABASE: [],
      SERVICE_TO_BROKER: [],
      DOMAIN_TO_DOMAIN: [],
    };

    for (let idx = 0; idx < rollupLevels.length; idx++) {
      const level = rollupLevels[idx]!;
      const payload = (await rollupResList[idx]!.json()) as {
        edges?: RollupEdgeApiItem[];
        graphStats?: GraphStatApiItem[];
      };
      rollups[level] = (payload.edges ?? []).map((edge) => ({
        id: `rollup-${edge.id}`,
        subjectObjectId: edge.source,
        objectId: edge.target,
        relationType: edge.relationType,
      }));
      graphStats[level] = payload.graphStats ?? [];
    }

    return {
      allObjects,
      allRelations,
      allRollups: rollups,
      allGraphStats: graphStats,
      allDomainAffinities,
    };
  }, [workspaceId]);

  const fetchContributors = useCallback(
    async (
      link: RollupGraph3DLink,
      groupBy: ContributorGroupBy,
      scopeMode: ContributorScopeMode,
      options?: { cursor?: string | null; append?: boolean },
    ) => {
      if (!workspaceId) {
        setContributorError('workspaceId가 필요합니다.');
        setContributorData(null);
        setContributorNextCursor(null);
        return;
      }
      const cursor = options?.cursor ?? null;
      const append = options?.append ?? false;
      const params = new URLSearchParams({
        workspaceId,
        sourceCompoundId: link.semanticSource,
        targetCompoundId: link.semanticTarget,
        groupBy,
        scopeMode,
        limit: '20',
      });
      if (scopeMode === 'SUBTREE' && link.id.startsWith('rollup-')) {
        params.set('rollupId', link.id);
      }
      if (cursor) params.set('cursor', cursor);

      if (append) setContributorLoadingMore(true);
      else setContributorLoading(true);
      if (!append) setContributorError(null);
      try {
        const res = await fetch(`/api/mapping/contributors?${params.toString()}`);
        if (!res.ok) {
          throw new Error('Contributor 데이터를 불러오지 못했습니다.');
        }
        const payload = (await res.json()) as ContributorResponse;
        setContributorNextCursor(payload.pageInfo?.nextCursor ?? null);
        setContributorData((prev) => {
          if (!append || !prev) return payload;
          return {
            ...payload,
            groups: [...prev.groups, ...payload.groups],
          };
        });
      } catch (error) {
        console.error('[RollupGraph] contributors 로드 실패:', error);
        if (!append) setContributorData(null);
        setContributorNextCursor(null);
        setContributorError(error instanceof Error ? error.message : '알 수 없는 오류');
      } finally {
        if (append) setContributorLoadingMore(false);
        else setContributorLoading(false);
      }
    },
    [workspaceId],
  );

  const handleLinkClick = useCallback(
    (link: RollupGraph3DLink) => {
      if (link.isContains) return;
      setSelectedContributorLink(link);
      setContributorNextCursor(null);
      setContributorLoadingMore(false);
      void fetchContributors(link, contributorGroupBy, contributorScopeMode, {
        cursor: null,
        append: false,
      });
    },
    [contributorGroupBy, contributorScopeMode, fetchContributors],
  );

  useEffect(() => {
    if (!selectedContributorLink) return;
    setContributorNextCursor(null);
    setContributorLoadingMore(false);
    void fetchContributors(selectedContributorLink, contributorGroupBy, contributorScopeMode, {
      cursor: null,
      append: false,
    });
  }, [selectedContributorLink, contributorGroupBy, contributorScopeMode, fetchContributors]);

  const buildGraph = useCallback(
    async (level: ViewLevel, expanded: Set<string>) => {
      setLoading(true);
      setIsEmpty(false);

      try {
        const {
          allObjects,
          allRelations,
          allRollups,
          allGraphStats,
          allDomainAffinities,
        } = await fetchData(expanded.size > 0 || level === 'UNUSED_ATOMIC');

        const domainObjects = allObjects.filter((o) => o.objectType === 'domain' && o.depth === 0);
        const domainIdSet = new Set(domainObjects.map((domain) => domain.id));
        const activeSelectedDomain =
          selectedDomain && domainIdSet.has(selectedDomain.id) ? selectedDomain : null;
        const hasDomainData = domainObjects.length > 0;
        setHasDomainObjects(hasDomainData);

        if (selectedDomain && activeSelectedDomain === null) {
          setSelectedDomain(null);
          if (selectedService !== null) setSelectedService(null);
        }

        if (level === 'DOMAIN_TO_DOMAIN' && !hasDomainData) {
          if (selectedDomain !== null) setSelectedDomain(null);
          if (selectedService !== null) setSelectedService(null);
          if (expanded.size > 0) setExpandedSet(new Set());
          setViewLevel('SERVICE_TO_SERVICE');
          return;
        }

        const usedAtomicIds = buildUsedAtomicIdSet(allRelations);

        if (expanded.size > 0) {
          const objMap = new Map(allObjects.map((o) => [o.id, o]));
          const allowedRelTypes: Set<string> | null = PANEL_RELATION_TYPES[level]
            ? new Set(PANEL_RELATION_TYPES[level]!)
            : null;

          const infos: RollDownPanelItem[] = [];

          expanded.forEach((compoundId) => {
            const compound = objMap.get(compoundId);
            if (!compound) return;

            const atomicChildren = allObjects
              .filter((o) => o.parentId === compoundId)
              .filter((o) => o.granularity === 'COMPOUND' || usedAtomicIds.has(o.id));
            const atomicChildIds = new Set(atomicChildren.map((a) => a.id));

            const exposedAtomics: ExposedAtomicInfo[] = atomicChildren.map((atomic) => {
              const callersMap = new Map<string, CallerInfo>();
              allRelations
                .filter((r) => r.objectId === atomic.id)
                .forEach((r) => {
                  if (allowedRelTypes && !allowedRelTypes.has(r.relationType)) return;
                  const callerObj = objMap.get(r.subjectObjectId);
                  if (!callerObj) return;
                  const callerCompound = callerObj.parentId
                    ? (objMap.get(callerObj.parentId) ?? callerObj)
                    : callerObj;
                  if (callerCompound.id === compoundId) return;
                  const key = `${callerCompound.id}|${r.relationType}`;
                  if (!callersMap.has(key)) {
                    callersMap.set(key, {
                      compound: {
                        id: callerCompound.id,
                        label: callerCompound.displayName ?? callerCompound.name,
                      },
                      relationType: r.relationType,
                    });
                  }
                });

              return {
                id: atomic.id,
                label: atomic.displayName ?? atomic.name,
                objectType: atomic.objectType,
                callers: [...callersMap.values()],
              };
            });

            const refMap = new Map<string, ReferencedAtomicInfo>();
            allRelations
              .filter((r) => atomicChildIds.has(r.subjectObjectId) || r.subjectObjectId === compoundId)
              .forEach((r) => {
                if (allowedRelTypes && !allowedRelTypes.has(r.relationType)) return;
                const refObj = objMap.get(r.objectId);
                if (!refObj) return;
                if (refObj.id === compoundId || refObj.parentId === compoundId) return;
                if (refMap.has(r.objectId)) return;
                const provider = refObj.parentId ? objMap.get(refObj.parentId) : null;
                refMap.set(r.objectId, {
                  id: refObj.id,
                  label: refObj.displayName ?? refObj.name,
                  objectType: refObj.objectType,
                  relationType: r.relationType,
                  provider: provider
                    ? { id: provider.id, label: provider.displayName ?? provider.name }
                    : null,
                });
              });

            infos.push({
              targetId: compoundId,
              targetLabel: compound.displayName ?? compound.name,
              targetObjectType: compound.objectType,
              exposedAtomics,
              referencedAtomics: [...refMap.values()],
            });
          });
          setRollDownInfo(infos);
        } else {
          setRollDownInfo([]);
        }

        let filteredObjects: ObjectItem[];
        let filteredRelations: RelationItem[];
        let containsLinks: {
          id: string;
          subjectObjectId: string;
          objectId: string;
          relationType: 'contains';
        }[] = [];

        if (level === 'UNUSED_ATOMIC') {
          const objMap = new Map(allObjects.map((o) => [o.id, o]));
          const unusedAtomics = allObjects.filter(
            (o) => o.granularity === 'ATOMIC' && !usedAtomicIds.has(o.id),
          );
          const parentIds = new Set(
            unusedAtomics
              .map((o) => o.parentId)
              .filter((id): id is string => typeof id === 'string' && id.length > 0),
          );
          const parentCompounds = allObjects.filter((o) => parentIds.has(o.id));
          const parentIdSet = new Set(parentCompounds.map((o) => o.id));

          filteredObjects = [...parentCompounds, ...unusedAtomics];
          filteredRelations = [];
          containsLinks = unusedAtomics
            .filter((atomic) => atomic.parentId && parentIdSet.has(atomic.parentId))
            .map((atomic) => ({
              id: `contains-${atomic.parentId}-${atomic.id}`,
              subjectObjectId: atomic.parentId!,
              objectId: atomic.id,
              relationType: 'contains' as const,
            }));

          const nextUnusedItems = unusedAtomics
            .map((atomic) => {
              const parent = atomic.parentId ? objMap.get(atomic.parentId) : null;
              if (!parent) return null;
              return {
                atomicId: atomic.id,
                atomicLabel: atomic.displayName ?? atomic.name,
                atomicObjectType: atomic.objectType,
                parentCompoundId: parent.id,
                parentCompoundLabel: parent.displayName ?? parent.name,
              } satisfies UnusedAtomicItem;
            })
            .filter((item): item is UnusedAtomicItem => item !== null)
            .sort((a, b) => {
              const parentSort = a.parentCompoundLabel.localeCompare(b.parentCompoundLabel, 'ko');
              if (parentSort !== 0) return parentSort;
              return a.atomicLabel.localeCompare(b.atomicLabel, 'ko');
            });
          setUnusedAtomicItems(nextUnusedItems);
        } else if (level === 'COMPOUND_VIEW') {
          setUnusedAtomicItems([]);
          filteredObjects = allObjects.filter((o) => o.depth === 0);
          const idSet = new Set(filteredObjects.map((o) => o.id));
          const rollupCompoundRelations = [
            ...allRollups.SERVICE_TO_SERVICE,
            ...allRollups.SERVICE_TO_DATABASE,
            ...allRollups.SERVICE_TO_BROKER,
          ];
          const relationMap = new Map<string, RelationItem>();
          rollupCompoundRelations
            .filter((r) => idSet.has(r.subjectObjectId) && idSet.has(r.objectId))
            .forEach((r) => relationMap.set(r.id, r));
          filteredRelations = [...relationMap.values()];
        } else {
          setUnusedAtomicItems([]);
          const allowedTypes = LEVEL_TYPES[level] ?? [];
          let baseObjects = allObjects.filter(
            (o) => allowedTypes.includes(o.objectType) && o.depth === 0,
          );

          if (level === 'SERVICE_TO_SERVICE' && activeSelectedDomain) {
            const bestDomainByService = new Map<string, { domainId: string; affinity: number }>();
            for (const row of allDomainAffinities) {
              const prev = bestDomainByService.get(row.objectId);
              if (!prev || row.affinity > prev.affinity) {
                bestDomainByService.set(row.objectId, {
                  domainId: row.domainId,
                  affinity: row.affinity,
                });
              }
            }
            baseObjects = baseObjects.filter(
              (o) => bestDomainByService.get(o.id)?.domainId === activeSelectedDomain.id,
            );
          }

          const expandedChildren: ObjectItem[] = [];
          expanded.forEach((parentId) => {
            allObjects
              .filter((o) => o.parentId === parentId)
              .filter((o) => o.granularity === 'COMPOUND' || usedAtomicIds.has(o.id))
              .forEach((o) => expandedChildren.push(o));
          });

          filteredObjects = [...baseObjects, ...expandedChildren];

          containsLinks = expandedChildren
            .filter((c) => c.parentId)
            .map((c) => ({
              id: `contains-${c.parentId}-${c.id}`,
              subjectObjectId: c.parentId!,
              objectId: c.id,
              relationType: 'contains' as const,
            }));

          const idSet = new Set(filteredObjects.map((o) => o.id));
          const rollupRelations = allRollups[level].filter(
            (r) => idSet.has(r.subjectObjectId) && idSet.has(r.objectId),
          );
          const drillDownRelations = expanded.size > 0
            ? allRelations.filter((r) => idSet.has(r.subjectObjectId) && idSet.has(r.objectId))
            : [];

          const relationMap = new Map<string, RelationItem>();
          [...rollupRelations, ...drillDownRelations].forEach((r) => relationMap.set(r.id, r));
          filteredRelations = [...relationMap.values()];
        }

        const graphStatsForLevel: GraphStatApiItem[] =
          level === 'COMPOUND_VIEW' || level === 'UNUSED_ATOMIC' ? [] : allGraphStats[level];
        const graphStatMap = new Map(graphStatsForLevel.map((row) => [row.objectId, row]));
        const visibleBeforeHubFilter = new Set(filteredObjects.map((o) => o.id));
        const hubNodeIds = new Set(
          graphStatsForLevel
            .filter((row) => row.inDegree >= hubThreshold && visibleBeforeHubFilter.has(row.objectId))
            .map((row) => row.objectId),
        );
        setHubNodeCount(hubNodeIds.size);

        if (isHubCollapsed && hubNodeIds.size > 0) {
          filteredObjects = filteredObjects.filter((o) => !hubNodeIds.has(o.id));
          const visibleAfterCollapse = new Set(filteredObjects.map((o) => o.id));
          filteredRelations = filteredRelations.filter(
            (r) => visibleAfterCollapse.has(r.subjectObjectId) && visibleAfterCollapse.has(r.objectId),
          );
          containsLinks = containsLinks.filter(
            (r) => visibleAfterCollapse.has(r.subjectObjectId) && visibleAfterCollapse.has(r.objectId),
          );
        }

        if (filteredObjects.length === 0) {
          setIsEmpty(true);
          setGraph3DData({ nodes: [], links: [] });
          return;
        }

        const graph3DNodes: RollupGraph3DNode[] = filteredObjects.map((obj) => {
          const isCompound = obj.granularity === 'COMPOUND';
          const isChild = obj.parentId !== null;
          const stat = graphStatMap.get(obj.id);
          return {
            id: obj.id,
          label: obj.displayName ?? obj.name,
          objectType: obj.objectType,
          color: NODE_COLORS[obj.objectType] ?? NODE_COLORS.default ?? '#94a3b8',
          radius: isCompound ? 22 : isChild ? 12 : 16,
            isHub: hubNodeIds.has(obj.id),
            inDegree: stat?.inDegree ?? 0,
            outDegree: stat?.outDegree ?? 0,
            isCompound,
          };
        });

        const visibleIdSet = new Set(filteredObjects.map((o) => o.id));
        const allLinkRaw = [
          ...filteredRelations.map((r) => ({
            id: r.id,
            subjectObjectId: r.subjectObjectId,
            objectId: r.objectId,
            relationType: r.relationType,
          })),
          ...containsLinks,
        ];

        const sourceTargetRows = allLinkRaw
          .filter((l) => visibleIdSet.has(l.subjectObjectId) && visibleIdSet.has(l.objectId))
          .map((l) => ({
            id: l.id,
            sourceId: l.subjectObjectId,
            targetId: l.objectId,
            semanticSource: l.subjectObjectId,
            semanticTarget: l.objectId,
            relationType: l.relationType,
            color: EDGE_COLORS[l.relationType] ?? '#6b7280',
            isContains: l.relationType === 'contains',
            isReversed: ['read', 'consume'].includes(l.relationType),
          }));

        const containsPairSet = new Set(
          sourceTargetRows
            .filter((row) => row.isContains)
            .map((row) => `${row.semanticSource}|${row.semanticTarget}`),
        );

        const graph3DLinks: RollupGraph3DLink[] = sourceTargetRows
          .filter((row) => {
            if (row.isContains) return true;
            const direct = `${row.semanticSource}|${row.semanticTarget}`;
            const reverse = `${row.semanticTarget}|${row.semanticSource}`;
            return !containsPairSet.has(direct) && !containsPairSet.has(reverse);
          })
          .map((row) => {
            const baseSource = row.isReversed ? row.targetId : row.sourceId;
            const baseTarget = row.isReversed ? row.sourceId : row.targetId;
            const linkSource = row.isContains ? baseTarget : baseSource;
            const linkTarget = row.isContains ? baseSource : baseTarget;
            return {
              id: row.id,
              source: linkSource,
              target: linkTarget,
              semanticSource: row.semanticSource,
              semanticTarget: row.semanticTarget,
              relationType: row.relationType,
              color: row.color,
              isContains: row.isContains,
            };
          });

        setGraph3DData({ nodes: graph3DNodes, links: graph3DLinks });
      } catch (err) {
        console.error('[RollupGraph] 로드 실패:', err);
        setIsEmpty(true);
        setGraph3DData({ nodes: [], links: [] });
        setUnusedAtomicItems([]);
      } finally {
        setLoading(false);
      }
    },
    [fetchData, hubThreshold, isHubCollapsed, selectedDomain, selectedService],
  );

  useEffect(() => {
    void buildGraph(viewLevel, expandedSet);
  }, [viewLevel, expandedSet, buildGraph]);

  const handleLevelChange = (level: ViewLevel) => {
    setSelectedContributorLink(null);
    setContributorScopeMode('SUBTREE');
    setContributorGroupBy('targetCompound');
    setContributorData(null);
    setContributorError(null);
    setContributorNextCursor(null);
    setContributorLoadingMore(false);
    setUnusedAtomicItems([]);

    if (level === 'UNUSED_ATOMIC') {
      setSelectedDomain(null);
      setSelectedService(null);
      setExpandedSet(new Set());
      setViewLevel('UNUSED_ATOMIC');
      return;
    }

    if (hasDomainObjects) {
      if (!selectedDomain) {
        if (level !== 'DOMAIN_TO_DOMAIN') return;
      } else {
        if (level === 'DOMAIN_TO_DOMAIN') {
          setSelectedDomain(null);
          setSelectedService(null);
          setExpandedSet(new Set());
          setViewLevel('DOMAIN_TO_DOMAIN');
          return;
        }
        if (level !== 'SERVICE_TO_SERVICE') return;
      }
    }

    if (level !== 'SERVICE_TO_SERVICE') setSelectedService(null);
    setExpandedSet(new Set());
    setViewLevel(level);
  };

  const nodeLabelById = new Map(graph3DData.nodes.map((node) => [node.id, node.label]));
  const selectedContributorSourceLabel =
    selectedContributorLink && nodeLabelById.get(selectedContributorLink.semanticSource);
  const selectedContributorTargetLabel =
    selectedContributorLink && nodeLabelById.get(selectedContributorLink.semanticTarget);
  const hasContributorNextPage = contributorNextCursor !== null;

  return (
    <div className="relative h-full w-full bg-[#0f0f11]">
      <div className="absolute left-4 top-4 z-10 flex max-w-[calc(100%-20rem)] flex-col gap-2">
        {hasDomainObjects && (
          <div className="flex items-center gap-1.5 rounded-full border border-zinc-700/80 bg-zinc-950/80 px-3 py-1.5 text-[11px] text-zinc-200 backdrop-blur-sm">
            <button
              onClick={() => {
                setSelectedDomain(null);
                setSelectedService(null);
                setExpandedSet(new Set());
                setViewLevel('DOMAIN_TO_DOMAIN');
              }}
              className={cn(
                'rounded px-1.5 py-0.5 font-semibold',
                !selectedDomain ? 'text-primary' : 'text-zinc-300 hover:text-white',
              )}
            >
              Domain
            </button>
            {selectedDomain && (
              <>
                <span className="text-zinc-500">/</span>
                <button
                  onClick={() => {
                    setSelectedService(null);
                    setExpandedSet(new Set());
                    setViewLevel('SERVICE_TO_SERVICE');
                  }}
                  className={cn(
                    'max-w-[12rem] truncate rounded px-1.5 py-0.5 font-semibold',
                    !selectedService ? 'text-primary' : 'text-zinc-300 hover:text-white',
                  )}
                  title={selectedDomain.label}
                >
                  {selectedDomain.label}
                </button>
              </>
            )}
            {selectedService && (
              <>
                <span className="text-zinc-500">/</span>
                <span
                  className="max-w-[12rem] truncate rounded px-1.5 py-0.5 font-semibold text-primary"
                  title={selectedService.label}
                >
                  {selectedService.label}
                </span>
              </>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {VIEW_LEVELS.map((level) => {
            const isAlwaysAllowed = level.value === 'UNUSED_ATOMIC';
            const disabledByDomainFlow =
              hasDomainObjects &&
              !isAlwaysAllowed &&
              (
                (!selectedDomain && level.value !== 'DOMAIN_TO_DOMAIN') ||
                (selectedDomain !== null && !['DOMAIN_TO_DOMAIN', 'SERVICE_TO_SERVICE'].includes(level.value))
              );
            return (
              <button
                key={level.value}
                onClick={() => handleLevelChange(level.value)}
                disabled={disabledByDomainFlow}
                title={disabledByDomainFlow ? 'Domain-first 단계에서 자동 전환됩니다.' : undefined}
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium',
                  'border backdrop-blur-sm whitespace-nowrap transition-opacity',
                  viewLevel === level.value
                    ? 'border-primary bg-primary/20 text-primary'
                    : 'border-white/10 bg-black/40 text-zinc-400 hover:text-white hover:border-white/20',
                  disabledByDomainFlow && 'cursor-not-allowed opacity-45 hover:text-zinc-400 hover:border-white/10',
                )}
              >
                <span
                  className="inline-block h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: level.color }}
                />
                {level.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="absolute right-4 top-4 z-10 flex flex-col items-end gap-1.5">
        {hasDomainObjects && (selectedDomain || selectedService) && (
          <button
            onClick={() => {
              if (selectedService) {
                setSelectedService(null);
                setExpandedSet(new Set());
                setViewLevel('SERVICE_TO_SERVICE');
                return;
              }
              setSelectedDomain(null);
              setExpandedSet(new Set());
              setViewLevel('DOMAIN_TO_DOMAIN');
            }}
            className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium border border-indigo-500/30 bg-indigo-500/10 text-indigo-200 backdrop-blur-sm hover:bg-indigo-500/20"
          >
            ↑ 상위로
          </button>
        )}

        {!['COMPOUND_VIEW', 'UNUSED_ATOMIC'].includes(viewLevel) && hubNodeCount > 0 && (
          <button
            onClick={() => setIsHubCollapsed((prev) => !prev)}
            className={cn(
              'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium border backdrop-blur-sm',
              isHubCollapsed
                ? 'border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20'
                : 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20',
            )}
          >
            {isHubCollapsed ? `Hub 펼치기 (${hubNodeCount})` : `Hub 접기 (${hubNodeCount})`}
            <span className="text-[10px] text-cyan-100/80">in≥{hubThreshold}</span>
          </button>
        )}

        {expandedSet.size > 0 && (
          <button
            onClick={() => {
              setExpandedSet(new Set());
              if (selectedService) setSelectedService(null);
            }}
            className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium border border-rose-500/30 bg-rose-500/10 text-rose-400 backdrop-blur-sm hover:bg-rose-500/20"
          >
            ↩ 모두 접기 ({expandedSet.size})
          </button>
        )}
      </div>

      {rollDownInfo.length > 0 && (
        <div className="absolute left-4 bottom-20 z-20 flex flex-col gap-2 max-h-[55vh] overflow-y-auto min-w-[300px] max-w-[min(520px,calc(100vw-6rem))] pointer-events-none">
          {rollDownInfo.map((info) => (
            <div
              key={info.targetId}
              className="rounded-xl bg-zinc-950/95 border border-zinc-700/80 backdrop-blur-md text-xs pointer-events-auto shadow-xl"
            >
              <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 min-w-0">
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full ring-2 ring-white bg-zinc-300" />
                <span className="font-semibold text-white tracking-tight break-words min-w-0 flex-1">{info.targetLabel}</span>
                <span className="ml-2 shrink-0 text-[10px] text-zinc-500 font-mono">{info.targetObjectType}</span>
              </div>

              <div className="flex">
                <div className="flex-1 min-w-0 p-2.5">
                  <p className="mb-1.5 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider whitespace-nowrap">
                    ← Inbound
                  </p>
                  {info.exposedAtomics.flatMap((atom) =>
                    atom.callers.map((caller) => (
                      <div
                        key={`${atom.id}-${caller.compound.id}-${caller.relationType}`}
                        className="mb-1.5 leading-tight"
                      >
                        <div className="text-indigo-300 font-medium break-words">{caller.compound.label}</div>
                        <div className="flex items-start gap-1 pl-2 text-zinc-500 min-w-0">
                          <span className="shrink-0 text-[9px] font-mono text-violet-400">{caller.relationType}</span>
                          <span className="shrink-0 text-zinc-600">→</span>
                          <span className="text-purple-300 break-all min-w-0">{atom.label}</span>
                        </div>
                      </div>
                    )),
                  )}
                  {info.exposedAtomics.every((a) => a.callers.length === 0) && (
                    <span className="text-zinc-600 italic">없음</span>
                  )}
                </div>

                <div className="w-px shrink-0 bg-zinc-800" />

                <div className="flex-1 min-w-0 p-2.5">
                  <p className="mb-1.5 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider whitespace-nowrap">
                    Outbound →
                  </p>
                  {info.referencedAtomics.map((ref) => (
                    <div key={ref.id} className="mb-1.5 leading-tight">
                      {ref.provider && (
                        <div className="text-indigo-300 font-medium break-words">{ref.provider.label}</div>
                      )}
                      <div className="flex items-start gap-1 pl-2 text-zinc-500 min-w-0">
                        <span className="shrink-0 text-[9px] font-mono text-violet-400">{ref.relationType}</span>
                        <span className="shrink-0 text-zinc-600">→</span>
                        <span className="text-purple-300 break-all min-w-0">{ref.label}</span>
                      </div>
                    </div>
                  ))}
                  {info.referencedAtomics.length === 0 && (
                    <span className="text-zinc-600 italic">없음</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {viewLevel === 'UNUSED_ATOMIC' && !loading && (
        <div className="absolute left-4 bottom-20 z-20 w-[min(520px,calc(100vw-3rem))] max-h-[55vh] rounded-xl border border-zinc-700/80 bg-zinc-950/95 p-3 text-xs shadow-xl backdrop-blur-md">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
              Unused Atomic
            </p>
            <span className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-300">
              total: {unusedAtomicItems.length}
            </span>
          </div>
          {unusedAtomicItems.length === 0 ? (
            <p className="text-zinc-500">미사용 atomic이 없습니다.</p>
          ) : (
            <div className="max-h-[44vh] space-y-1.5 overflow-y-auto pr-1">
              {unusedAtomicItems.map((item) => (
                <div
                  key={item.atomicId}
                  className="rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1.5"
                >
                  <div className="text-[10px] text-indigo-300">{item.parentCompoundLabel}</div>
                  <div className="break-all text-zinc-200">{item.atomicLabel}</div>
                  <div className="text-[10px] font-mono text-zinc-500">{item.atomicObjectType}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {selectedContributorLink && (
        <div className="absolute right-4 bottom-20 z-20 w-[min(560px,calc(100vw-2rem))] max-h-[55vh] rounded-xl border border-zinc-700/80 bg-zinc-950/95 text-xs shadow-xl backdrop-blur-md">
          <div className="flex items-start justify-between gap-2 border-b border-zinc-800 px-3 py-2">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                Contributor
              </p>
              <p className="truncate font-semibold text-zinc-100">
                {selectedContributorSourceLabel ?? selectedContributorLink.semanticSource} →{' '}
                {selectedContributorTargetLabel ?? selectedContributorLink.semanticTarget}
              </p>
              <p className="mt-0.5 text-[10px] text-zinc-500">
                relation: {selectedContributorLink.relationType}
              </p>
            </div>
            <button
              onClick={() => {
                setSelectedContributorLink(null);
                setContributorData(null);
                setContributorError(null);
                setContributorNextCursor(null);
                setContributorLoadingMore(false);
              }}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-300 hover:border-zinc-500 hover:text-white"
            >
              닫기
            </button>
          </div>

          <div className="flex items-center gap-1.5 border-b border-zinc-800 px-3 py-2">
            <span className="text-[10px] text-zinc-500">groupBy</span>
            {(
              [
                ['targetCompound', 'targetCompound'],
                ['relationType', 'relationType'],
                ['sourceAtomic', 'sourceAtomic'],
                ['targetAtomic', 'targetAtomic'],
              ] as const
            ).map(([option, label]) => (
              <button
                key={option}
                onClick={() => setContributorGroupBy(option)}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-medium border',
                  contributorGroupBy === option
                    ? 'border-primary bg-primary/20 text-primary'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500 hover:text-white',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 border-b border-zinc-800 px-3 py-2">
            <span className="text-[10px] text-zinc-500">scope</span>
            {(['SUBTREE', 'GLOBAL'] as ContributorScopeMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setContributorScopeMode(mode)}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-medium border',
                  contributorScopeMode === mode
                    ? 'border-primary bg-primary/20 text-primary'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500 hover:text-white',
                )}
              >
                {mode}
              </button>
            ))}
          </div>

          <div className="max-h-[42vh] overflow-y-auto px-3 py-2">
            {contributorLoading && (
              <div className="flex items-center justify-center py-6 text-zinc-400">
                <Spinner size="sm" />
              </div>
            )}

            {!contributorLoading && contributorError && (
              <p className="py-4 text-rose-300">{contributorError}</p>
            )}

            {!contributorLoading &&
              !contributorError &&
              contributorData &&
              contributorData.summary.totalCount === 0 && (
                <p className="py-4 text-zinc-500">기여 관계가 없습니다.</p>
              )}

            {!contributorLoading &&
              !contributorError &&
              contributorData &&
              contributorData.summary.totalCount > 0 && (
                <div className="space-y-2">
                  <div className="rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-[10px] text-zinc-400">
                    total: {contributorData.summary.totalCount}
                    {' · '}
                    {Object.entries(contributorData.summary.byRelationType)
                      .map(([type, count]) => `${type}:${count}`)
                      .join(', ')}
                  </div>

                  {contributorData.groups.map((group) => (
                    <div key={group.groupKey} className="rounded border border-zinc-800 bg-zinc-900/50 p-2">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="font-semibold text-zinc-200">
                          {group.groupLabel ?? group.groupKey}
                        </span>
                        <span className="text-[10px] text-zinc-500">{group.weight}</span>
                      </div>
                      <div className="space-y-1.5">
                        {group.relations.map((relation) => (
                          <div key={relation.relationId} className="rounded border border-zinc-800/80 bg-zinc-950/60 p-2">
                            <div className="flex items-start gap-1 text-[11px]">
                              <span className="font-mono text-violet-300">{relation.relationType}</span>
                              <span className="text-zinc-300 break-all">
                                {relation.sourceAtomicLabel} → {relation.targetAtomicLabel}
                              </span>
                            </div>
                            <div className="mt-1 text-[10px] text-zinc-500">
                              confidence:{' '}
                              {typeof relation.confidence === 'number'
                                ? relation.confidence.toFixed(2)
                                : 'n/a'}
                              {' · '}evidence:{relation.evidenceCount}
                            </div>
                            {relation.evidences.length > 0 && (
                              <div className="mt-1 space-y-1">
                                {relation.evidences.slice(0, 3).map((evidence) => (
                                  <div key={evidence.id} className="rounded bg-zinc-900/70 px-1.5 py-1 text-[10px] text-zinc-400">
                                    <span className="font-mono text-zinc-300">{evidence.evidenceType}</span>
                                    {evidence.filePath && (
                                      <span className="ml-1 break-all">{evidence.filePath}</span>
                                    )}
                                    {(evidence.lineStart || evidence.lineEnd) && (
                                      <span className="ml-1 text-zinc-500">
                                        [{evidence.lineStart ?? '-'}-{evidence.lineEnd ?? '-'}]
                                      </span>
                                    )}
                                    {evidence.excerpt && (
                                      <div className="mt-1 line-clamp-2 break-all text-zinc-500">
                                        {evidence.excerpt}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                            {relation.evidences.length === 0 && (
                              <div className="mt-1 text-[10px] text-zinc-500">근거 없음</div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}

                  {hasContributorNextPage && selectedContributorLink && (
                    <div className="flex justify-center pt-1">
                      <button
                        onClick={() => {
                          if (!contributorNextCursor || contributorLoadingMore) return;
                          void fetchContributors(
                            selectedContributorLink,
                            contributorGroupBy,
                            contributorScopeMode,
                            { cursor: contributorNextCursor, append: true },
                          );
                        }}
                        disabled={contributorLoadingMore}
                        className={cn(
                          'rounded border px-2 py-1 text-[10px]',
                          contributorLoadingMore
                            ? 'border-zinc-700 bg-zinc-900 text-zinc-500'
                            : 'border-zinc-600 bg-zinc-900 text-zinc-300 hover:border-zinc-400 hover:text-white',
                        )}
                      >
                        {contributorLoadingMore ? '불러오는 중...' : '더 보기'}
                      </button>
                    </div>
                  )}
                </div>
              )}
          </div>
        </div>
      )}

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner size="lg" />
        </div>
      )}

      {!loading && isEmpty && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-zinc-500">
          <p className="text-sm">이 레벨에 해당하는 Object 데이터가 없습니다.</p>
          <p className="text-xs">
            설정 &gt; 개발자 도구에서{' '}
            <span className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-zinc-300">
              샘플 넣기
            </span>
            를 실행하거나 Object를 직접 등록하세요.
          </p>
        </div>
      )}

      {!loading && !isEmpty && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-1.5">
          <div className="flex gap-3 text-[10px] text-zinc-500 bg-black/30 rounded-full px-3 py-1 backdrop-blur-sm">
            <span>드래그: 회전</span>
            <span>휠: 줌</span>
            <span>클릭: 포커스</span>
            {!['COMPOUND_VIEW', 'UNUSED_ATOMIC'].includes(viewLevel) && (
              <span>클릭(COMPOUND): Roll-down</span>
            )}
          </div>
        </div>
      )}

      <RollupGraph3D
        nodes={graph3DData.nodes}
        links={graph3DData.links}
        onNodeClick={(node) => {
          handleNodePrimaryAction({
            id: node.id,
            objectType: node.objectType,
            isCompound: node.isCompound,
            label: node.label,
          });
        }}
        onLinkClick={(link) => {
          handleLinkClick(link);
        }}
        onBackgroundClick={() => {
          setSelectedContributorLink(null);
          setContributorData(null);
          setContributorError(null);
          setContributorNextCursor(null);
          setContributorLoadingMore(false);
        }}
      />

      {showE2ENodeActions && (
        <div
          data-testid="mapping-graph-e2e-node-actions"
          className="absolute bottom-4 right-4 z-30 max-h-40 w-56 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-950/90 p-2 text-[10px] backdrop-blur-sm"
        >
          <p className="mb-1 text-zinc-400">E2E Node Actions</p>
          <div className="flex flex-col gap-1">
            {graph3DData.nodes.map((node) => (
              <button
                key={node.id}
                data-testid="mapping-graph-e2e-node-action"
                data-node-id={node.id}
                aria-hidden="true"
                onClick={() =>
                  handleNodePrimaryAction({
                    id: node.id,
                    objectType: node.objectType,
                    isCompound: node.isCompound,
                    label: node.label,
                  })
                }
                className="truncate rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-left text-zinc-200 hover:border-zinc-500 hover:text-white"
                title={node.label}
              >
                {node.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {showE2ELinkActions && (
        <div
          data-testid="mapping-graph-e2e-link-actions"
          className="absolute bottom-4 right-64 z-30 max-h-40 w-72 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-950/90 p-2 text-[10px] backdrop-blur-sm"
        >
          <p className="mb-1 text-zinc-400">E2E Link Actions</p>
          <div className="flex flex-col gap-1">
            {graph3DData.links
              .filter((link) => !link.isContains)
              .map((link) => (
                <button
                  key={link.id}
                  data-testid="mapping-graph-e2e-link-action"
                  data-link-id={link.id}
                  aria-hidden="true"
                  onClick={() => handleLinkClick(link)}
                  className="truncate rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-left text-zinc-200 hover:border-zinc-500 hover:text-white"
                  title={`${nodeLabelById.get(link.semanticSource) ?? link.semanticSource} -> ${
                    nodeLabelById.get(link.semanticTarget) ?? link.semanticTarget
                  }`}
                >
                  {(nodeLabelById.get(link.semanticSource) ?? link.semanticSource)}
                  {' -> '}
                  {(nodeLabelById.get(link.semanticTarget) ?? link.semanticTarget)}
                  {' ('}
                  {link.relationType}
                  {')'}
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
