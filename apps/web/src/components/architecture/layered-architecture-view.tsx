/**
 * Cytoscape 레이어드 아키텍처 뷰
 * - Layer 노드: 가로 밴드 (sortOrder에 따라 Y축 배치)
 * - Service 노드: Layer 내 배치
 * - Edge: 관계 타입별 색상
 * v1 architecture-graph.tsx 패턴 기반
 */
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import cytoscape, { type Core, type StylesheetCSS, type ElementDefinition } from 'cytoscape';
import {
  Search,
  ZoomIn,
  ZoomOut,
  Maximize,
  Download,
  Eye,
  EyeOff,
  Spline,        // bezier
  CornerDownRight, // taxi (직각)
  Minus,         // straight (직선)
} from 'lucide-react';
import { cn, Input, Button, Spinner } from '@archi-navi/ui';
import { useWorkspace } from '@/contexts/workspace-context';

/* ─── 타입 ─── */
interface LayerData {
  id: string;
  name: string;
  displayName: string | null;
  color: string | null;
  sortOrder: number;
  isEnabled: boolean;
}

interface ObjectData {
  id: string;
  name: string;
  displayName: string | null;
  objectType: string;
  granularity: string; // COMPOUND | ATOMIC
}

interface TagData {
  id: string;
  name: string;
  color: string | null;
}

interface AssignmentData {
  objectId: string;
  layerId: string;
}

interface RelationData {
  id: string;
  subjectObjectId: string;
  objectId: string;
  relationType: string;
}

interface RollupEdgeData {
  id: string;
  source: string;
  target: string;
  relationType: string;
}

/* ─── 엣지 타입별 색상 (Cosmic 테마) ─── */
const EDGE_COLORS: Record<string, string> = {
  call: '#818cf8',          // indigo
  expose: '#c084fc',        // purple
  read: '#34d399',          // emerald
  write: '#4ade80',         // green-400
  produce: '#fbbf24',       // amber
  consume: '#fb923c',       // orange-400
  depend_on: '#94a3b8',     // slate
};

/* ─── 노드 타입별 색상 (Cosmic 테마) ─── */
const NODE_COLORS: Record<string, string> = {
  service: '#818cf8',       // indigo-400
  api_endpoint: '#c084fc',  // purple-400
  database: '#34d399',      // emerald-400
  db_table: '#22d3ee',      // cyan-400  — DB 테이블 ATOMIC
  topic: '#fbbf24',         // amber-400 — Kafka 토픽 ATOMIC
  kafka_topic: '#fbbf24',   // amber-400 — 하위 호환
  message_broker: '#fbbf24',// amber-400
  domain: '#22d3ee',        // cyan-400  — 하위 호환
  default: '#94a3b8',       // slate-400
};

/* ─── 레이어 기본 색상 팔레트 ─── */
const LAYER_COLORS = ['#8b5cf6', '#3b82f6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444'];

/* ─── Cytoscape 스타일시트 ─── */
const cytoscapeStyles: StylesheetCSS[] = [
  {
    selector: 'node[nodeType="layer"]',
    css: {
      'background-color': 'data(bgColor)' as unknown as string,
      'background-opacity': 0.15,
      'border-width': 2,
      'border-color': 'data(borderColor)' as unknown as string,
      'border-opacity': 0.6,
      shape: 'round-rectangle',
      width: 'data(width)' as unknown as number,
      height: 50,
      label: 'data(label)',
      'text-valign': 'center',
      'text-halign': 'center',
      'font-size': 14,
      'font-weight': 'bold',
      color: '#ffffff',
      'text-opacity': 0.8,
    },
  },
  {
    selector: 'node[nodeType="object"]',
    css: {
      'background-color': 'data(bgColor)' as unknown as string,
      'border-width': 1,
      'border-color': 'data(bgColor)' as unknown as string,
      'border-opacity': 0.5,
      shape: 'round-rectangle',
      width: 140,
      height: 44,
      label: 'data(label)',
      'text-valign': 'center',
      'text-halign': 'center',
      'font-size': 11,
      color: '#ffffff',
      'text-wrap': 'wrap',       // 태그 라인을 위해 wrap으로 변경
      'text-max-width': '128px',
    },
  },
  // 태그가 있는 노드 — 높이를 늘려 태그 라인 공간 확보
  {
    selector: 'node[nodeType="object"][hasTags="1"]',
    css: { height: 58 },
  },
  {
    selector: 'edge',
    css: {
      width: 1.5,
      'line-color': 'data(color)' as unknown as string,
      'target-arrow-color': 'data(color)' as unknown as string,
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      opacity: 0.7,
    },
  },
  // read/consume: 데이터 출처에 원형 dot 표시 (source-arrow)
  {
    selector: 'edge[isReversed="1"]',
    css: {
      'source-arrow-shape': 'circle' as const,
      'source-arrow-color': 'data(color)' as unknown as string,
    },
  },
  // 비동기 메시징 (produce/consume) — 긴 점선
  {
    selector: 'edge[relationType="produce"], edge[relationType="consume"]',
    css: { 'line-style': 'dashed', 'line-dash-pattern': [8, 4] as unknown as number[] },
  },
  // 데이터 접근 (read/write) — 짧은 점선
  {
    selector: 'edge[relationType="read"], edge[relationType="write"]',
    css: { 'line-style': 'dashed', 'line-dash-pattern': [3, 4] as unknown as number[] },
  },
  {
    selector: '.dimmed',
    css: { opacity: 0.12 },
  },
  {
    selector: '.highlighted',
    css: { opacity: 1 },
  },
  {
    selector: '.search-match',
    css: {
      'border-width': 3,
      'border-color': '#facc15',
      opacity: 1,
    },
  },
];

/** 화살표 곡선 스타일 옵션 */
type CurveStyle = 'bezier' | 'taxi' | 'straight';

const CURVE_STYLES: { value: CurveStyle; icon: typeof Spline; title: string }[] = [
  { value: 'bezier', icon: Spline, title: '곡선 (Bezier)' },
  { value: 'taxi', icon: CornerDownRight, title: '직각 (Taxi)' },
  { value: 'straight', icon: Minus, title: '직선 (Straight)' },
];

export function LayeredArchitectureView() {
  const { workspaceId } = useWorkspace();
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [hiddenEdgeTypes, setHiddenEdgeTypes] = useState<Set<string>>(new Set());
  const [hasData, setHasData] = useState(false);
  const [curveStyle, setCurveStyle] = useState<CurveStyle>('bezier');
  // 레이어 목록 (뷰 내 visibility 토글용)
  const [activeLayers, setActiveLayers] = useState<LayerData[]>([]);
  const [hiddenLayerIds, setHiddenLayerIds] = useState<Set<string>>(new Set());

  /* ─── 데이터 로드 (workspaceId 변경 시 자동 재실행) ─── */
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const q = `workspaceId=${workspaceId}`;
      const [
        layersRes,
        assignmentsRes,
        objectsRes,
        tagsRes,
        s2sRes,
        s2dbRes,
        s2bRes,
        relationsRes,
      ] =
        await Promise.all([
          fetch(`/api/layers?${q}`),
          fetch(`/api/layers/assignments?${q}`),
          fetch(`/api/objects?${q}`),
          fetch(`/api/object-tags?${q}`), // Object별 태그 일괄 조회
          fetch(`/api/rollups?${q}&level=SERVICE_TO_SERVICE`),
          fetch(`/api/rollups?${q}&level=SERVICE_TO_DATABASE`),
          fetch(`/api/rollups?${q}&level=SERVICE_TO_BROKER`),
          fetch(`/api/relations?${q}`), // depend_on 보강용
        ]);

      const layers = (await layersRes.json()) as LayerData[];
      const assignments = (await assignmentsRes.json()) as AssignmentData[];
      const allObjects = (await objectsRes.json()) as ObjectData[];
      const nodeTags = (await tagsRes.json()) as Record<string, TagData[]>;
      const s2s = (await s2sRes.json()) as { edges?: RollupEdgeData[] };
      const s2db = (await s2dbRes.json()) as { edges?: RollupEdgeData[] };
      const s2b = (await s2bRes.json()) as { edges?: RollupEdgeData[] };
      const directRelations = (await relationsRes.json()) as RelationData[];

      const rollupEdges = [
        ...(s2s.edges ?? []),
        ...(s2db.edges ?? []),
        ...(s2b.edges ?? []),
      ];
      const dependOnEdges = directRelations
        .filter((rel) => rel.relationType === 'depend_on')
        .map((rel) => ({
          id: rel.id,
          source: rel.subjectObjectId,
          target: rel.objectId,
          relationType: rel.relationType,
        }));
      const graphEdges = [...rollupEdges, ...dependOnEdges];

      if (layers.length === 0 && allObjects.length === 0) {
        setHasData(false);
        setLoading(false);
        return;
      }

      setHasData(true);

      // 배치 맵 구축
      const assignMap = new Map<string, string>();
      for (const a of assignments) {
        assignMap.set(a.objectId, a.layerId);
      }

      // 활성 레이어만 (sortOrder 순)
      const newActiveLayers = layers
        .filter((l) => l.isEnabled)
        .sort((a, b) => a.sortOrder - b.sortOrder);

      setActiveLayers(newActiveLayers);
      setHiddenLayerIds(new Set()); // 워크스페이스 전환 시 visibility 초기화

      // 배치된 Object 중 COMPOUND 레벨만 (Atomic은 아키텍처 뷰 대상 아님)
      const assignedObjects = allObjects.filter(
        (o) => assignMap.has(o.id) && o.granularity === 'COMPOUND',
      );

      // 레이어별 Object 그룹
      const layerObjectsMap = new Map<string, ObjectData[]>();
      for (const obj of assignedObjects) {
        const layerId = assignMap.get(obj.id)!;
        const list = layerObjectsMap.get(layerId) ?? [];
        list.push(obj);
        layerObjectsMap.set(layerId, list);
      }

      // 레이아웃 계산
      const LAYER_GAP_Y = 160;
      const NODE_GAP_X = 180;
      const CANVAS_PADDING = 60;
      const maxObjectsPerLayer = Math.max(
        ...newActiveLayers.map((l) => (layerObjectsMap.get(l.id) ?? []).length),
        1,
      );
      const canvasWidth = Math.max(maxObjectsPerLayer * NODE_GAP_X + CANVAS_PADDING * 2, 800);

      // Cytoscape 엘리먼트 생성
      const elements: ElementDefinition[] = [];

      // Layer 노드
      newActiveLayers.forEach((layer, layerIdx) => {
        const yPos = CANVAS_PADDING + layerIdx * LAYER_GAP_Y;
        const color = layer.color ?? LAYER_COLORS[layerIdx % LAYER_COLORS.length]!;

        elements.push({
          data: {
            id: `layer-${layer.id}`,
            label: layer.displayName ?? layer.name,
            nodeType: 'layer',
            layerId: layer.id, // visibility 토글에서 사용
            bgColor: color,
            borderColor: color,
            width: canvasWidth - CANVAS_PADDING * 2,
          },
          position: { x: canvasWidth / 2, y: yPos },
          locked: true,
          grabbable: false,
        });

        // Layer 내 Object 노드 (COMPOUND만 — 이미 필터됨)
        const layerObjects = layerObjectsMap.get(layer.id) ?? [];
        layerObjects.forEach((obj, objIdx) => {
          const totalWidth = layerObjects.length * NODE_GAP_X;
          const startX = (canvasWidth - totalWidth) / 2 + NODE_GAP_X / 2;

          // 태그 정보 — 태그 이름을 두 번째 줄로 표시
          const tags = nodeTags[obj.id] ?? [];
          const tagLine = tags.length > 0
            ? tags.map((t) => `#${t.name}`).join('  ')
            : '';
          const label = tagLine
            ? `${obj.displayName ?? obj.name}\n${tagLine}`
            : (obj.displayName ?? obj.name);

          elements.push({
            data: {
              id: obj.id,
              label,
              nodeType: 'object',
              objectType: obj.objectType,
              layerId: layer.id, // visibility 토글에서 레이어별 노드 숨김에 사용
              bgColor: NODE_COLORS[obj.objectType] ?? NODE_COLORS['default'],
              hasTags: tags.length > 0 ? '1' : '0', // Cytoscape 선택자용 string
            },
            position: {
              x: startX + objIdx * NODE_GAP_X,
              y: yPos + 56,
            },
          });
        });
      });

      // 엣지 — COMPOUND 오브젝트 간의 관계만
      const assignedIds = new Set(assignedObjects.map((o) => o.id));
      for (const edge of graphEdges) {
        if (assignedIds.has(edge.source) && assignedIds.has(edge.target)) {
          /*
           * read / consume 은 데이터 흐름이 objectId → subjectObjectId 방향.
           * Cytoscape source/target을 swap하여 화살표가 데이터 목적지를 향하게 함.
           * source-arrow에 origin dot(ellipse)을 추가해 출처를 표시.
           */
          const isReversed = ['read', 'consume'].includes(edge.relationType);
          elements.push({
            data: {
              id: `edge-${edge.id}`,
              source: isReversed ? edge.target : edge.source,
              target: isReversed ? edge.source : edge.target,
              relationType: edge.relationType,
              color: EDGE_COLORS[edge.relationType] ?? '#6b7280',
              isReversed: isReversed ? '1' : '0', // Cytoscape 선택자는 string 비교
            },
          });
        }
      }

      // Cytoscape 초기화/업데이트 (이전 인스턴스 정리 후 재생성)
      if (cyRef.current) {
        cyRef.current.destroy();
        cyRef.current = null; // destroy 후 null로 초기화해 이중 destroy 방지
      }

      if (containerRef.current) {
        cyRef.current = cytoscape({
          container: containerRef.current,
          elements,
          style: cytoscapeStyles,
          layout: { name: 'preset' },
          minZoom: 0.2,
          maxZoom: 2.5,
          wheelSensitivity: 0.3,
        });

        cyRef.current.fit(undefined, 40);
      }
    } catch (err) {
      console.error('[LayeredArchitectureView] 데이터 로드 실패:', err);
      setHasData(false);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]); // workspaceId 변경 시 loadData 재생성 → useEffect 재실행

  useEffect(() => {
    void loadData();
    return () => {
      cyRef.current?.destroy();
      cyRef.current = null; // 언마운트/재실행 시 null로 초기화
    };
  }, [loadData]);

  /* ─── 레이어 visibility 토글 ─── */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    // 전체 표시로 초기화
    cy.elements().style('display', 'element');

    // 숨길 레이어 노드 + 해당 레이어의 오브젝트 노드 숨김
    hiddenLayerIds.forEach((layerId) => {
      cy.getElementById(`layer-${layerId}`).style('display', 'none');
      cy.nodes(`[layerId = "${layerId}"]`).style('display', 'none');
    });

    // 한쪽이라도 숨겨진 노드에 연결된 엣지 숨김
    cy.edges().forEach((edge) => {
      if (
        edge.source().style('display') === 'none' ||
        edge.target().style('display') === 'none'
      ) {
        edge.style('display', 'none');
      }
    });
  }, [hiddenLayerIds]);

  /* ─── 검색 하이라이트 ─── */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    // 초기화
    cy.elements().removeClass('dimmed highlighted search-match');

    if (!searchQuery.trim()) return;

    const query = searchQuery.toLowerCase();
    const matched = cy.nodes().filter((n) => {
      const label = (n.data('label') as string || '').toLowerCase();
      return label.includes(query);
    });

    if (matched.length > 0) {
      cy.elements().addClass('dimmed');
      matched.addClass('search-match highlighted');
      matched.connectedEdges().addClass('highlighted');
      matched.neighborhood().addClass('highlighted');
    }
  }, [searchQuery]);

  /* ─── 엣지 타입 토글 ─── */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.edges().forEach((edge) => {
      const type = edge.data('relationType') as string;
      if (hiddenEdgeTypes.has(type)) {
        edge.style('display', 'none');
      } else {
        edge.style('display', 'element');
      }
    });
  }, [hiddenEdgeTypes]);

  const toggleEdgeType = (type: string) => {
    setHiddenEdgeTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  /* ─── 화살표 곡선 스타일 변경 ─── */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.edges().style('curve-style', curveStyle);
  }, [curveStyle]);

  /* ─── 줌 컨트롤 ─── */
  const zoomIn = () => cyRef.current?.zoom(cyRef.current.zoom() * 1.3);
  const zoomOut = () => cyRef.current?.zoom(cyRef.current.zoom() / 1.3);
  const fitView = () => cyRef.current?.fit(undefined, 40);
  const exportPng = () => {
    const cy = cyRef.current;
    if (!cy) return;
    const png = cy.png({ full: true, scale: 2, bg: '#050508' });
    const link = document.createElement('a');
    link.href = png;
    link.download = 'architecture-view.png';
    link.click();
  };

  /*
   * containerRef.current를 항상 유효하게 유지하기 위해
   * early return 패턴을 사용하지 않는다.
   *
   * 문제: early return으로 로딩 스피너를 반환하면 container div가 언마운트되어
   * containerRef.current가 null이 됨. 이 상태에서 fetch 완료 후 Cytoscape를
   * 초기화하려 하면 container가 없어 아무것도 렌더링되지 않는다.
   *
   * 해결: container div를 항상 DOM에 유지하고, 로딩/빈 상태는 absolute 오버레이로 표시.
   */
  return (
    <div className="relative h-full w-full">
      {/*
       * Cytoscape 캔버스 — 항상 마운트 상태 유지
       * loadData() 내 `if (containerRef.current)` 조건이 항상 true가 되어야 정상 초기화됨
       */}
      <div ref={containerRef} className="cytoscape-container" />

      {/* 로딩 오버레이 */}
      {loading && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/80">
          <Spinner size="lg" />
        </div>
      )}

      {/* 빈 상태 오버레이 */}
      {!loading && !hasData && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 text-muted-foreground">
          <p className="text-sm">레이어 또는 서비스 데이터가 없습니다.</p>
          <p className="text-xs">
            설정 → 레이어 관리에서 계층을 추가하거나 CLI로 서비스를 스캔하세요.
          </p>
        </div>
      )}

      {/* UI 컨트롤 (데이터가 있을 때만 표시) */}
      {!loading && hasData && (
        <>
          {/* 좌상단 — 검색 + 레이어 토글 + 엣지 토글 */}
          <div className="absolute left-4 top-4 z-20 flex flex-col gap-2">
            {/* 검색 */}
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="노드 검색..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-9 w-48 pl-8 text-xs glass-card"
              />
            </div>

            {/* 계층 레벨 visibility 토글 */}
            <div className="flex flex-wrap gap-1">
              {activeLayers.map((layer) => {
                const isHidden = hiddenLayerIds.has(layer.id);
                const color = layer.color ?? '#6b7280';
                return (
                  <button
                    key={layer.id}
                    onClick={() =>
                      setHiddenLayerIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(layer.id)) next.delete(layer.id);
                        else next.add(layer.id);
                        return next;
                      })
                    }
                    title={isHidden ? `${layer.displayName ?? layer.name} 표시` : `${layer.displayName ?? layer.name} 숨김`}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium transition-all glass-card',
                      isHidden ? 'opacity-35' : 'opacity-100',
                    )}
                  >
                    {isHidden ? (
                      <EyeOff className="h-3 w-3 shrink-0" />
                    ) : (
                      <Eye className="h-3 w-3 shrink-0" />
                    )}
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    {layer.displayName ?? layer.name}
                  </button>
                );
              })}
            </div>

            {/* 엣지 타입 토글 버튼 */}
            <div className="flex flex-wrap gap-1">
              {Object.entries(EDGE_COLORS).map(([type, color]) => (
                <button
                  key={type}
                  onClick={() => toggleEdgeType(type)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium transition-all',
                    'glass-card',
                    hiddenEdgeTypes.has(type) ? 'opacity-40' : 'opacity-100',
                  )}
                >
                  {hiddenEdgeTypes.has(type) ? (
                    <EyeOff className="h-3 w-3" />
                  ) : (
                    <Eye className="h-3 w-3" />
                  )}
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  {type}
                </button>
              ))}
            </div>
          </div>

          {/* 우상단 — 화살표 스타일 + 줌 컨트롤 */}
          <div className="absolute right-4 top-4 z-20 flex flex-col gap-1">
            {/* 화살표 곡선 스타일 토글 */}
            <div className="flex flex-col gap-0.5 mb-2 rounded-lg overflow-hidden border border-white/10">
              {CURVE_STYLES.map(({ value, icon: Icon, title }) => (
                <Button
                  key={value}
                  variant="ghost"
                  size="icon"
                  onClick={() => setCurveStyle(value)}
                  title={title}
                  className={cn(
                    'h-8 w-8 rounded-none',
                    curveStyle === value
                      ? 'bg-primary/20 text-primary'
                      : 'glass-card text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </Button>
              ))}
            </div>
            {/* 줌 컨트롤 */}
            <Button variant="ghost" size="icon" onClick={zoomIn} className="h-8 w-8 glass-card" title="확대">
              <ZoomIn className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={zoomOut} className="h-8 w-8 glass-card" title="축소">
              <ZoomOut className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={fitView} className="h-8 w-8 glass-card" title="전체 보기">
              <Maximize className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={exportPng} className="h-8 w-8 glass-card" title="PNG 내보내기">
              <Download className="h-4 w-4" />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
