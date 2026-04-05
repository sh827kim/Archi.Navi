/**
 * Cytoscape 레이어드 아키텍처 뷰
 * - Layer 노드: 가로 밴드 (sortOrder에 따라 Y축 배치)
 * - Service 노드: Layer 내 배치
 * - Edge: 관계 타입별 색상
 * v1 architecture-graph.tsx 패턴 기반
 */
'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import cytoscape, { type Core, type StylesheetCSS, type ElementDefinition } from 'cytoscape';
import { useTheme } from 'next-themes';
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
import { subscribeToRollupEvents } from '@/lib/rollup-event-source';
import { EmptyStateGuide } from '@/components/shared/empty-state-guide';

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

interface RollupEdgeData {
  id: string;
  source: string;
  target: string;
  relationType: string;
}

function formatTagSummary(tags: TagData[]): string {
  if (tags.length === 0) return '';
  const visible = tags.slice(0, 2).map((t) => `#${t.name}`);
  const moreCount = tags.length - visible.length;
  return `${visible.join(' · ')}${moreCount > 0 ? ` +${moreCount}` : ''}`;
}

function sortTags(tags: TagData[]): TagData[] {
  return [...tags].sort((a, b) => a.name.localeCompare(b.name));
}

function pickReadableTextColor(bgColor: string | null | undefined): string {
  if (!bgColor) return '#ffffff';
  const hex = bgColor.trim();
  const normalized = hex.startsWith('#') ? hex.slice(1) : hex;
  const raw = normalized.length === 3
    ? normalized.split('').map((ch) => ch + ch).join('')
    : normalized;
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return '#ffffff';

  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  // W3C relative luminance approximation for UI contrast threshold.
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.62 ? '#0f172a' : '#ffffff';
}

function calcLayerTitleWidth(label: string): number {
  const LAYER_TITLE_MIN_WIDTH = 96;
  const LAYER_TITLE_MAX_WIDTH = 220;
  const APPROX_CHAR_WIDTH = 7;
  const SIDE_PADDING = 22;
  return Math.max(
    LAYER_TITLE_MIN_WIDTH,
    Math.min(LAYER_TITLE_MAX_WIDTH, (label.length * APPROX_CHAR_WIDTH) + SIDE_PADDING),
  );
}

type ThemeMode = 'light' | 'dark';

interface ArchitectureThemePalette {
  edgeColors: Record<string, string>;
  nodeColors: Record<string, string>;
  layerColors: string[];
  layerTitleColor: string;
  layerTitleOutline: string;
  layerTitleOutlineOpacity: number;
  tagBg: string;
  tagBorder: string;
  tagText: string;
}

function createArchitectureThemePalette(themeMode: ThemeMode): ArchitectureThemePalette {
  const vividEdgeColors = {
    call: '#818cf8',
    expose: '#c084fc',
    read: '#34d399',
    write: '#4ade80',
    produce: '#fbbf24',
    consume: '#fb923c',
    depend_on: '#94a3b8',
  };
  const vividNodeColors = {
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
  const vividLayerColors = ['#8b5cf6', '#3b82f6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444'];

  if (themeMode === 'light') {
    return {
      edgeColors: vividEdgeColors,
      nodeColors: vividNodeColors,
      layerColors: vividLayerColors,
      layerTitleColor: '#334155',
      layerTitleOutline: '#f8fafc',
      layerTitleOutlineOpacity: 0.9,
      tagBg: '#f4ede2',
      tagBorder: '#d8c8ad',
      tagText: '#475569',
    };
  }

  return {
    edgeColors: vividEdgeColors,
    nodeColors: vividNodeColors,
    layerColors: vividLayerColors,
    layerTitleColor: '#f8fafc',
    layerTitleOutline: '#020617',
    layerTitleOutlineOpacity: 0.45,
    tagBg: '#0f172a',
    tagBorder: '#334155',
    tagText: '#cbd5e1',
  };
}

/* ─── Cytoscape 스타일시트 ─── */
function createCytoscapeStyles(themePalette: ArchitectureThemePalette): StylesheetCSS[] {
  return [
    {
      selector: 'node[nodeType="layer"]',
      css: {
        'background-color': 'data(bgColor)' as unknown as string,
        'background-opacity': 0.13,
        'border-width': 2,
        'border-color': 'data(borderColor)' as unknown as string,
        'border-opacity': 0.55,
        shape: 'round-rectangle',
        padding: '18px',
        'padding-top': '34px',
        label: '',
        'z-compound-depth': 'bottom',
      },
    },
    {
      selector: 'node[nodeType="layer-title"]',
      css: {
        'background-opacity': 0,
        'border-width': 0,
        shape: 'round-rectangle',
        width: 'data(width)' as unknown as number,
        height: 18,
        label: 'data(label)',
        'text-valign': 'center',
        'text-halign': 'center',
        'font-size': 11,
        'font-weight': 'bold',
        color: themePalette.layerTitleColor,
        'text-opacity': 0.9,
        'text-outline-color': themePalette.layerTitleOutline,
        'text-outline-width': 2,
        'text-outline-opacity': themePalette.layerTitleOutlineOpacity,
        events: 'no',
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
        'font-size': 12,
        color: 'data(textColor)',
        'text-wrap': 'wrap',
        'text-max-width': '128px',
      },
    },
    {
      selector: 'node[nodeType="layer-anchor"]',
      css: {
        width: 1,
        height: 1,
        opacity: 0,
        'background-opacity': 0,
        'border-width': 0,
        label: '',
        events: 'no',
      },
    },
    {
      selector: 'node[nodeType="tag"]',
      css: {
        'background-color': themePalette.tagBg,
        'background-opacity': 0.55,
        'border-width': 1,
        'border-color': themePalette.tagBorder,
        'border-opacity': 0.7,
        shape: 'round-rectangle',
        width: 128,
        height: 20,
        label: 'data(label)',
        'text-valign': 'center',
        'text-halign': 'center',
        'font-size': 8,
        color: themePalette.tagText,
        'text-wrap': 'wrap',
        'text-max-width': '118px',
      },
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
}

/** 화살표 곡선 스타일 옵션 */
type CurveStyle = 'bezier' | 'taxi' | 'straight';

const CURVE_STYLES: { value: CurveStyle; icon: typeof Spline; title: string }[] = [
  { value: 'bezier', icon: Spline, title: '곡선 (Bezier)' },
  { value: 'taxi', icon: CornerDownRight, title: '직각 (Taxi)' },
  { value: 'straight', icon: Minus, title: '직선 (Straight)' },
];

export function LayeredArchitectureView() {
  const { workspaceId } = useWorkspace();
  const { resolvedTheme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const graphSignatureRef = useRef<string>('');
  const isLoadingRef = useRef(false);
  const curveStyleRef = useRef<CurveStyle>('bezier');
  const destroyTimerRef = useRef<number | null>(null);
  const pendingReloadRef = useRef<{
    showLoadingOverlay: boolean;
    preserveViewport: boolean;
  } | null>(null);
  const lastInitialLoadRef = useRef<{
    workspaceId: string | null;
    themeMode: ThemeMode | null;
    startedAt: number;
  }>({
    workspaceId: null,
    themeMode: null,
    startedAt: 0,
  });
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [hiddenEdgeTypes, setHiddenEdgeTypes] = useState<Set<string>>(new Set());
  const [showTagBadges, setShowTagBadges] = useState(true);
  const [exportBg, setExportBg] = useState<'dark' | 'white'>('dark');
  const [hasData, setHasData] = useState(false);
  const [curveStyle, setCurveStyle] = useState<CurveStyle>('bezier');
  // 레이어 목록 (뷰 내 visibility 토글용)
  const [activeLayers, setActiveLayers] = useState<LayerData[]>([]);
  const [hiddenLayerIds, setHiddenLayerIds] = useState<Set<string>>(new Set());
  const themeMode: ThemeMode = resolvedTheme === 'light' ? 'light' : 'dark';
  const themePalette = useMemo(() => createArchitectureThemePalette(themeMode), [themeMode]);
  const cytoscapeStyles = useMemo(() => createCytoscapeStyles(themePalette), [themePalette]);

  /* ─── 데이터 로드 (workspaceId 변경 시 자동 재실행) ─── */
  const loadData = useCallback(async (options?: {
    showLoadingOverlay?: boolean;
    preserveViewport?: boolean;
  }) => {
    const showLoadingOverlay = options?.showLoadingOverlay ?? cyRef.current === null;
    const preserveViewport = options?.preserveViewport ?? cyRef.current !== null;
    if (isLoadingRef.current) {
      pendingReloadRef.current = { showLoadingOverlay, preserveViewport };
      return;
    }
    isLoadingRef.current = true;

    if (showLoadingOverlay) {
      setLoading(true);
    }
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
      ] =
        await Promise.all([
          fetch(`/api/layers?${q}`),
          fetch(`/api/layers/assignments?${q}`),
          fetch(`/api/objects?${q}`),
          fetch(`/api/object-tags?${q}`), // Object별 태그 일괄 조회
          fetch(`/api/rollups?${q}&level=SERVICE_TO_SERVICE`),
          fetch(`/api/rollups?${q}&level=SERVICE_TO_DATABASE`),
          fetch(`/api/rollups?${q}&level=SERVICE_TO_BROKER`),
        ]);

      const layers = (await layersRes.json()) as LayerData[];
      const assignments = (await assignmentsRes.json()) as AssignmentData[];
      const allObjects = (await objectsRes.json()) as ObjectData[];
      const nodeTags = (await tagsRes.json()) as Record<string, TagData[]>;
      const s2s = (await s2sRes.json()) as { edges?: RollupEdgeData[] };
      const s2db = (await s2dbRes.json()) as { edges?: RollupEdgeData[] };
      const s2b = (await s2bRes.json()) as { edges?: RollupEdgeData[] };

      const rollupEdges = [
        ...(s2s.edges ?? []),
        ...(s2db.edges ?? []),
        ...(s2b.edges ?? []),
      ];
      const graphEdges = rollupEdges;

      if (layers.length === 0 && allObjects.length === 0) {
        graphSignatureRef.current = '';
        setHasData(false);
        if (cyRef.current) {
          cyRef.current.elements().remove();
        }
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
      const LAYER_GAP_Y = 190;
      const NODE_GAP_X = 180;
      const CANVAS_PADDING = 60;
      const LAYER_TITLE_LEFT_INSET = -44;
      const LAYER_TITLE_TOP_OFFSET = 36;
      const LAYER_ANCHOR_Y_OFFSET = 56;
      const OBJECT_NODE_Y_OFFSET = 76;
      const TAG_NODE_Y_OFFSET = 108;
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
        const color = layer.color ?? themePalette.layerColors[layerIdx % themePalette.layerColors.length]!;
        const layerLabel = layer.displayName ?? layer.name;
        const layerTitleWidth = calcLayerTitleWidth(layerLabel);

        elements.push({
          data: {
            id: `layer-${layer.id}`,
            searchText: layerLabel,
            nodeType: 'layer',
            layerId: layer.id, // visibility 토글에서 사용
            bgColor: color,
            borderColor: color,
          },
          locked: true,
          grabbable: false,
        });

        elements.push({
          data: {
            id: `layer-title-${layer.id}`,
            label: layerLabel,
            nodeType: 'layer-title',
            layerId: layer.id,
            width: layerTitleWidth,
          },
          position: {
            x: CANVAS_PADDING + LAYER_TITLE_LEFT_INSET + (layerTitleWidth / 2),
            y: yPos + LAYER_TITLE_TOP_OFFSET,
          },
          locked: true,
          grabbable: false,
        });

        // Compound parent(layer)가 영역처럼 보이도록 좌우 anchor를 넣어 폭을 확보한다.
        elements.push({
          data: {
            id: `layer-anchor-left-${layer.id}`,
            nodeType: 'layer-anchor',
            layerId: layer.id,
            parent: `layer-${layer.id}`,
          },
          position: { x: CANVAS_PADDING, y: yPos + LAYER_ANCHOR_Y_OFFSET },
          locked: true,
          grabbable: false,
        });
        elements.push({
          data: {
            id: `layer-anchor-right-${layer.id}`,
            nodeType: 'layer-anchor',
            layerId: layer.id,
            parent: `layer-${layer.id}`,
          },
          position: { x: canvasWidth - CANVAS_PADDING, y: yPos + LAYER_ANCHOR_Y_OFFSET },
          locked: true,
          grabbable: false,
        });

        // Layer 내 Object 노드 (COMPOUND만 — 이미 필터됨)
        const layerObjects = layerObjectsMap.get(layer.id) ?? [];
        layerObjects.forEach((obj, objIdx) => {
          const totalWidth = layerObjects.length * NODE_GAP_X;
          const startX = (canvasWidth - totalWidth) / 2 + NODE_GAP_X / 2;

          // 태그는 별도 보조 배지 노드로 표시한다.
          const tags = sortTags(nodeTags[obj.id] ?? []);
          const objectLabel = obj.displayName ?? obj.name;
          const tagSummary = formatTagSummary(tags);
          const primaryTagColor = tags[0]?.color ?? null;
          const objectBgColor = primaryTagColor
            ?? themePalette.nodeColors[obj.objectType]
            ?? themePalette.nodeColors.default;

          elements.push({
            data: {
              id: obj.id,
              label: objectLabel,
              searchText: `${objectLabel} ${tags.map((t) => t.name).join(' ')}`.trim(),
              nodeType: 'object',
              objectType: obj.objectType,
              layerId: layer.id, // visibility 토글에서 레이어별 노드 숨김에 사용
              parent: `layer-${layer.id}`,
              bgColor: objectBgColor,
              textColor: pickReadableTextColor(objectBgColor),
            },
            position: {
              x: startX + objIdx * NODE_GAP_X,
              y: yPos + OBJECT_NODE_Y_OFFSET,
            },
          });

          if (tagSummary) {
            elements.push({
              data: {
                id: `tag-${obj.id}`,
                label: tagSummary,
                nodeType: 'tag',
                layerId: layer.id,
                parentObjectId: obj.id,
                parent: `layer-${layer.id}`,
              },
              position: {
                x: startX + objIdx * NODE_GAP_X,
                y: yPos + TAG_NODE_Y_OFFSET,
              },
              locked: true,
              grabbable: false,
            });
          }
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
              color: themePalette.edgeColors[edge.relationType] ?? '#6b7280',
              isReversed: isReversed ? '1' : '0', // Cytoscape 선택자는 string 비교
            },
          });
        }
      }

      const graphSignature = JSON.stringify({
        themeMode,
        layers: newActiveLayers.map((layer) => ({
          id: layer.id,
          name: layer.name,
          displayName: layer.displayName,
          color: layer.color,
          sortOrder: layer.sortOrder,
        })),
        objects: assignedObjects.map((obj) => ({
          id: obj.id,
          name: obj.name,
          displayName: obj.displayName,
          objectType: obj.objectType,
          layerId: assignMap.get(obj.id) ?? null,
          tags: sortTags(nodeTags[obj.id] ?? []).map((tag) => ({
            id: tag.id,
            name: tag.name,
            color: tag.color,
          })),
        })),
        edges: graphEdges
          .filter((edge) => assignedIds.has(edge.source) && assignedIds.has(edge.target))
          .map((edge) => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            relationType: edge.relationType,
          })),
      });

      if (containerRef.current) {
        if (cyRef.current && graphSignatureRef.current === graphSignature) {
          cyRef.current.resize();
          return;
        }

        graphSignatureRef.current = graphSignature;

        if (!cyRef.current) {
          cyRef.current = cytoscape({
            container: containerRef.current,
            elements,
            style: cytoscapeStyles,
            layout: { name: 'preset' },
            minZoom: 0.2,
            maxZoom: 2.5,
          });

          cyRef.current.fit(undefined, 40);
          return;
        }

        const cy = cyRef.current;
        const previousZoom = cy.zoom();
        const previousPan = cy.pan();
        const styleApi = (cy as unknown as { style?: (styles: StylesheetCSS[]) => void }).style;

        cy.batch(() => {
          cy.elements().remove();
          cy.add(elements);
          styleApi?.call(cy, cytoscapeStyles);
          cy.edges().style('curve-style', curveStyleRef.current);
        });
        cy.resize();

        if (preserveViewport) {
          cy.zoom(previousZoom);
          cy.pan(previousPan);
        } else {
          cy.fit(undefined, 40);
        }
      }
    } catch (err) {
      console.error('[LayeredArchitectureView] 데이터 로드 실패:', err);
      setHasData(false);
    } finally {
      if (showLoadingOverlay) {
        setLoading(false);
      }
      isLoadingRef.current = false;
      const pendingReload = pendingReloadRef.current;
      if (pendingReload) {
        pendingReloadRef.current = null;
        void loadData(pendingReload);
      }
    }
  }, [workspaceId, themeMode, themePalette, cytoscapeStyles]); // workspaceId/테마 변경 시 재구성

  useEffect(() => {
    if (destroyTimerRef.current !== null) {
      window.clearTimeout(destroyTimerRef.current);
      destroyTimerRef.current = null;
    }

    const now = Date.now();
    const shouldSkipDuplicateInitialLoad =
      lastInitialLoadRef.current.workspaceId === workspaceId
      && lastInitialLoadRef.current.themeMode === themeMode
      && (now - lastInitialLoadRef.current.startedAt) < 1000;

    if (!shouldSkipDuplicateInitialLoad) {
      lastInitialLoadRef.current = { workspaceId, themeMode, startedAt: now };
      setHiddenLayerIds(new Set());
      graphSignatureRef.current = '';
      void loadData({ showLoadingOverlay: true, preserveViewport: false });
    }

    return () => {
      destroyTimerRef.current = window.setTimeout(() => {
        cyRef.current?.destroy();
        cyRef.current = null; // 언마운트/재실행 시 null로 초기화
        destroyTimerRef.current = null;
      }, 0);
    };
  }, [loadData, themeMode, workspaceId]);

  /* ─── SSE: rollup 변경 시 자동 갱신 ─── */
  useEffect(() => {
    if (!workspaceId) return;
    const sub = subscribeToRollupEvents({
      workspaceId,
      skipInitialChangeEvent: true,
      onRollupChange: () => void loadData({ showLoadingOverlay: false, preserveViewport: true }),
    });
    return () => sub.close();
  }, [workspaceId, loadData]);

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

    if (!showTagBadges) {
      cy.nodes('[nodeType = "tag"]').style('display', 'none');
    }

    // 한쪽이라도 숨겨진 노드에 연결된 엣지 숨김
    cy.edges().forEach((edge) => {
      const type = edge.data('relationType') as string;
      if (hiddenEdgeTypes.has(type)) {
        edge.style('display', 'none');
        return;
      }
      if (
        edge.source().style('display') === 'none' ||
        edge.target().style('display') === 'none'
      ) {
        edge.style('display', 'none');
      }
    });
  }, [hiddenLayerIds, showTagBadges, hiddenEdgeTypes]);

  /* ─── 검색 하이라이트 ─── */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    // 초기화
    cy.elements().removeClass('dimmed highlighted search-match');

    if (!searchQuery.trim()) return;

    const query = searchQuery.toLowerCase();
    const matched = cy.nodes().filter((n) => {
      const nodeType = n.data('nodeType') as string | undefined;
      if (nodeType === 'tag' || nodeType === 'layer-title') return false;
      const searchText = ((n.data('searchText') as string | undefined) ?? (n.data('label') as string | undefined) ?? '').toLowerCase();
      return searchText.includes(query);
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
    curveStyleRef.current = curveStyle;
    cy.edges().style('curve-style', curveStyle);
  }, [curveStyle]);

  /* ─── 줌 컨트롤 ─── */
  const zoomIn = () => cyRef.current?.zoom(cyRef.current.zoom() * 1.3);
  const zoomOut = () => cyRef.current?.zoom(cyRef.current.zoom() / 1.3);
  const fitView = () => cyRef.current?.fit(undefined, 40);
  const exportPng = () => {
    const cy = cyRef.current;
    if (!cy) return;
    const png = cy.png({ full: true, scale: 2, bg: exportBg === 'white' ? '#ffffff' : '#050508' });
    const link = document.createElement('a');
    link.href = png;
    link.download = `architecture-view-${exportBg}.png`;
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
    <div className="relative h-full min-h-0 w-full overflow-hidden">
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
        <div className="absolute inset-0 z-20 flex items-center justify-center p-6">
          <EmptyStateGuide
            eyebrow="Architecture View"
            title="아직 레이어드 아키텍처를 그릴 데이터가 없습니다"
            description="레이어가 없거나 서비스가 아직 등록되지 않았습니다. 먼저 Object를 정리하거나 설정 화면에서 레이어를 추가하세요."
            actions={[
              { href: '/services', label: 'Object 목록 열기' },
              { href: '/settings', label: '설정으로 이동', variant: 'outline' },
            ]}
            note="코드 스캔 이후에도 비어 있다면 레이어 할당 여부를 함께 확인하세요."
          />
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

            {/* 태그 표시 토글 */}
            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => setShowTagBadges((prev) => !prev)}
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium transition-all glass-card',
                  showTagBadges ? 'opacity-100' : 'opacity-40',
                )}
                title={showTagBadges ? '태그 숨기기' : '태그 표시'}
              >
                {showTagBadges ? (
                  <Eye className="h-3 w-3 shrink-0" />
                ) : (
                  <EyeOff className="h-3 w-3 shrink-0" />
                )}
                태그
              </button>
            </div>

            {/* 엣지 타입 토글 버튼 */}
            <div className="flex flex-wrap gap-1">
              {Object.entries(themePalette.edgeColors).map(([type, color]) => (
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
          <div className="absolute right-4 top-4 z-20 flex flex-col items-end gap-1">
            {/* 화살표 곡선 스타일 토글 */}
            <div className="flex flex-col gap-0.5 rounded-lg overflow-hidden border border-white/10">
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
            {/* PNG 배경 모드 */}
            <div className="flex flex-col rounded-lg overflow-hidden border border-white/10">
              <button
                type="button"
                onClick={() => setExportBg('dark')}
                className={cn(
                  'h-6 w-8 text-[8px] font-medium tracking-tight transition-colors',
                  exportBg === 'dark'
                    ? 'bg-primary/20 text-primary'
                    : 'glass-card text-muted-foreground hover:text-foreground',
                )}
                title="PNG 배경: 다크"
              >
                Dark
              </button>
              <button
                type="button"
                onClick={() => setExportBg('white')}
                className={cn(
                  'h-6 w-8 text-[8px] font-medium tracking-tight transition-colors border-t border-white/10',
                  exportBg === 'white'
                    ? 'bg-primary/20 text-primary'
                    : 'glass-card text-muted-foreground hover:text-foreground',
                )}
                title="PNG 배경: 화이트"
              >
                White
              </button>
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
