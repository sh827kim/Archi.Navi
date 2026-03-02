'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Object3D } from 'three';
import SpriteText from 'three-spritetext';

export interface RollupGraph3DNode {
  id: string;
  label: string;
  objectType: string;
  color: string;
  radius: number;
  isHub: boolean;
  inDegree: number;
  outDegree: number;
  isCompound: boolean;
}

export interface RollupGraph3DLink {
  id: string;
  source: string;
  target: string;
  semanticSource: string;
  semanticTarget: string;
  relationType: string;
  color: string;
  isContains: boolean;
}

interface RollupGraph3DProps {
  nodes: RollupGraph3DNode[];
  links: RollupGraph3DLink[];
  onNodeClick?: (node: RollupGraph3DNode, event: MouseEvent) => void;
  onBackgroundClick?: () => void;
}

type GraphNodeWithPos = RollupGraph3DNode & {
  x?: number;
  y?: number;
  z?: number;
  outNeighbors?: GraphNodeWithPos[];
  outLinks?: GraphLinkWithRefs[];
};

type GraphLinkWithRefs = Omit<RollupGraph3DLink, 'source' | 'target'> & {
  source: string | GraphNodeWithPos;
  target: string | GraphNodeWithPos;
};

type LinkPosition = {
  start: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
};

type ForceGraphInstance = {
  graphData: (data: { nodes: GraphNodeWithPos[]; links: GraphLinkWithRefs[] }) => ForceGraphInstance;
  width: (width: number) => ForceGraphInstance;
  height: (height: number) => ForceGraphInstance;
  backgroundColor: (value: string) => ForceGraphInstance;
  nodeRelSize: (value: number) => ForceGraphInstance;
  nodeVal: (fn: (node: GraphNodeWithPos) => number) => ForceGraphInstance;
  nodeColor: (fn: (node: GraphNodeWithPos) => string) => ForceGraphInstance;
  nodeLabel: (fn: (node: GraphNodeWithPos) => string) => ForceGraphInstance;
  nodeThreeObjectExtend: (extend: boolean) => ForceGraphInstance;
  nodeThreeObject: (fn: (node: GraphNodeWithPos) => Object3D) => ForceGraphInstance;
  linkColor: (fn: (link: GraphLinkWithRefs) => string) => ForceGraphInstance;
  linkWidth: (fn: (link: GraphLinkWithRefs) => number) => ForceGraphInstance;
  linkOpacity: (value: number) => ForceGraphInstance;
  linkDirectionalArrowLength: (fn: (link: GraphLinkWithRefs) => number) => ForceGraphInstance;
  linkDirectionalArrowRelPos: (value: number) => ForceGraphInstance;
  linkDirectionalParticles: (fn: (link: GraphLinkWithRefs) => number) => ForceGraphInstance;
  linkDirectionalParticleWidth: (value: number) => ForceGraphInstance;
  linkThreeObjectExtend: (extend: boolean) => ForceGraphInstance;
  linkThreeObject: (fn: (link: GraphLinkWithRefs) => Object3D | null) => ForceGraphInstance;
  linkPositionUpdate: (fn: (obj: Object3D, pos: LinkPosition) => void) => ForceGraphInstance;
  onNodeClick: (fn: (node: GraphNodeWithPos, event: MouseEvent) => void) => ForceGraphInstance;
  onBackgroundClick: (fn: () => void) => ForceGraphInstance;
  onNodeHover: (fn: (node: GraphNodeWithPos | null) => void) => ForceGraphInstance;
  onLinkHover: (fn: (link: GraphLinkWithRefs | null) => void) => ForceGraphInstance;
  zoomToFit: (ms: number, px: number) => ForceGraphInstance;
  cameraPosition: (
    position: { x: number; y: number; z: number },
    lookAt?: { x?: number; y?: number; z?: number },
    ms?: number,
  ) => ForceGraphInstance;
  _destructor?: () => void;
};

type ForceGraphFactory = (options?: { extraRenderers?: unknown[] }) => (el: HTMLElement) => ForceGraphInstance;
type CSS2DRendererCtor = new () => unknown;
type CSS2DObjectCtor = new (el: HTMLElement) => Object3D;
type GraphSnapshot = {
  nodesById: Map<string, GraphNodeWithPos>;
  links: GraphLinkWithRefs[];
};

function cloneGraphData(
  nodes: RollupGraph3DNode[],
  links: RollupGraph3DLink[],
): { nodes: GraphNodeWithPos[]; links: GraphLinkWithRefs[] } {
  const clonedNodes: GraphNodeWithPos[] = nodes.map((node) => ({
    ...node,
    outNeighbors: [],
    outLinks: [],
  }));
  const nodeMap = new Map(clonedNodes.map((node) => [node.id, node]));
  const clonedLinks: GraphLinkWithRefs[] = links.map((link) => ({ ...link }));

  // 하이라이트를 방향성 있게 하기 위해 source -> target(outbound)만 연결한다.
  clonedLinks.forEach((link) => {
    const sourceNode = nodeMap.get(String(link.source));
    const targetNode = nodeMap.get(String(link.target));
    if (!sourceNode || !targetNode) return;

    sourceNode.outNeighbors?.push(targetNode);
    sourceNode.outLinks?.push(link);
  });

  return {
    nodes: clonedNodes,
    links: clonedLinks,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function focusNode(instance: ForceGraphInstance, node: GraphNodeWithPos) {
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  const z = node.z ?? 0;
  const distance = Math.max(120, node.radius * 8);
  const norm = Math.hypot(x, y, z) || 1;
  const scale = 1 + distance / norm;

  instance.cameraPosition(
    { x: x * scale, y: y * scale, z: z * scale },
    { x, y, z },
    3000,
  );
}

function isHexColor(value: string): boolean {
  return /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(value);
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '');
  const expanded = normalized.length === 3
    ? normalized.split('').map((ch) => ch + ch).join('')
    : normalized;
  const num = Number.parseInt(expanded, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function dimColor(color: string, alpha: number): string {
  if (isHexColor(color)) return hexToRgba(color, alpha);
  return `rgba(148, 163, 184, ${alpha})`;
}

function getLinkNodeId(endpoint: string | GraphNodeWithPos): string {
  if (typeof endpoint === 'string') return endpoint;
  return endpoint.id;
}

function getSemanticSourceId(link: GraphLinkWithRefs): string {
  return link.semanticSource;
}

function getSemanticTargetId(link: GraphLinkWithRefs): string {
  return link.semanticTarget;
}

export function RollupGraph3D({
  nodes,
  links,
  onNodeClick,
  onBackgroundClick,
}: RollupGraph3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<ForceGraphInstance | null>(null);
  const onNodeClickRef = useRef<typeof onNodeClick>(onNodeClick);
  const onBackgroundClickRef = useRef<typeof onBackgroundClick>(onBackgroundClick);
  const nodesRef = useRef(nodes);
  const linksRef = useRef(links);
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  const hasData = useMemo(() => nodes.length > 0, [nodes.length]);
  const highlightNodeIdsRef = useRef<Set<string>>(new Set()); // hover-highlight
  const highlightLinkIdsRef = useRef<Set<string>>(new Set()); // hover-highlight
  const pinnedNodeIdsRef = useRef<Set<string>>(new Set()); // click-highlight
  const pinnedLinkIdsRef = useRef<Set<string>>(new Set()); // click-highlight
  const pinnedRootNodeIdRef = useRef<string | null>(null);
  const hoverNodeIdRef = useRef<string | null>(null);
  const refreshHighlightRef = useRef<(() => void) | null>(null);
  const applyPinnedHighlightByRootIdRef = useRef<((rootId: string | null) => void) | null>(null);
  const graphSnapshotRef = useRef<GraphSnapshot>({
    nodesById: new Map<string, GraphNodeWithPos>(),
    links: [],
  });

  useEffect(() => {
    onNodeClickRef.current = onNodeClick;
  }, [onNodeClick]);

  useEffect(() => {
    onBackgroundClickRef.current = onBackgroundClick;
  }, [onBackgroundClick]);

  useEffect(() => {
    nodesRef.current = nodes;
    linksRef.current = links;
  }, [nodes, links]);

  useEffect(() => {
    let cancelled = false;
    const hostEl = containerRef.current;

    const init = async () => {
      if (!hostEl || instanceRef.current) return;
      try {
        setInitError(null);
        const [fgModule, css2dModule] = await Promise.all([
          import('3d-force-graph'),
          import('three/examples/jsm/renderers/CSS2DRenderer'),
        ]);
        if (cancelled) return;

        const CSS2DRenderer = css2dModule.CSS2DRenderer as CSS2DRendererCtor;
        const CSS2DObject = css2dModule.CSS2DObject as CSS2DObjectCtor;

        const isNodeHighlighted = (nodeId: string) =>
          highlightNodeIdsRef.current.has(nodeId) || pinnedNodeIdsRef.current.has(nodeId);
        const isLinkHighlighted = (linkId: string) =>
          highlightLinkIdsRef.current.has(linkId) || pinnedLinkIdsRef.current.has(linkId);
        const hasAnyNodeHighlight = () =>
          highlightNodeIdsRef.current.size > 0 || pinnedNodeIdsRef.current.size > 0;
        const hasAnyLinkHighlight = () =>
          highlightLinkIdsRef.current.size > 0 || pinnedLinkIdsRef.current.size > 0;

        const nodeColorAccessor = (node: GraphNodeWithPos) => {
          const isPinnedRoot = node.id === pinnedRootNodeIdRef.current;
          if (!hasAnyNodeHighlight()) return node.color;
          if (isPinnedRoot) {
            return '#f43f5e';
          }
          if (isNodeHighlighted(node.id)) {
            return node.id === hoverNodeIdRef.current ? '#f97316' : node.color;
          }
          return dimColor(node.color, 0.18);
        };

        const nodeLabelAccessor = (node: GraphNodeWithPos) => {
          const active = hasAnyNodeHighlight() && !isNodeHighlighted(node.id);
          const isPinnedRoot = node.id === pinnedRootNodeIdRef.current;
          const nodeEl = document.createElement('div');
          nodeEl.textContent = node.label;
          nodeEl.style.fontSize = node.isCompound ? '12px' : '11px';
          nodeEl.style.fontWeight = node.isCompound ? '700' : '500';
          nodeEl.style.lineHeight = '1.1';
          nodeEl.style.padding = '2px 6px';
          nodeEl.style.borderRadius = '6px';
          nodeEl.style.userSelect = 'none';
          nodeEl.style.whiteSpace = 'nowrap';
          nodeEl.style.pointerEvents = 'none';
          nodeEl.style.transform = 'translate(-50%, -50%)';
          nodeEl.style.color = active ? 'rgba(228, 228, 231, 0.35)' : '#f8fafc';
          nodeEl.style.background = isPinnedRoot
            ? 'rgba(244, 63, 94, 0.25)'
            : active
              ? 'rgba(24, 24, 27, 0.32)'
              : 'rgba(15, 15, 17, 0.72)';
          nodeEl.style.border = isPinnedRoot
            ? '1px solid rgba(251, 113, 133, 0.95)'
            : active
              ? '1px solid rgba(63, 63, 70, 0.35)'
              : '1px solid rgba(82, 82, 91, 0.6)';
          return new CSS2DObject(nodeEl);
        };

        const linkColorAccessor = (link: GraphLinkWithRefs) => {
          if (!hasAnyLinkHighlight()) return link.color;
          if (isLinkHighlighted(link.id)) return '#fde047';
          return dimColor(link.color, 0.14);
        };

        const linkWidthAccessor = (link: GraphLinkWithRefs) => {
          if (isLinkHighlighted(link.id)) return 3.4;
          return link.isContains ? 0.5 : 1.2;
        };

        const linkParticlesAccessor = (link: GraphLinkWithRefs) => {
          if (isLinkHighlighted(link.id)) return link.isContains ? 5 : 3;
          // 기본 상태에서는 흐름 파티클을 노출하지 않는다.
          return 0;
        };

        const linkLabelAccessor = (link: GraphLinkWithRefs) => {
          if (!link.relationType) return null;
          const sprite = new SpriteText(link.relationType);
          const active = hasAnyLinkHighlight() && !isLinkHighlighted(link.id);
          sprite.color = active ? 'rgba(161, 161, 170, 0.45)' : '#d4d4d8';
          sprite.textHeight = isLinkHighlighted(link.id) ? 2.6 : 2.1;
          sprite.backgroundColor = 'rgba(15, 15, 17, 0.72)';
          sprite.padding = 1;
          return sprite;
        };

        const ForceGraph3DFactory = fgModule.default as unknown as ForceGraphFactory;
        const instance = ForceGraph3DFactory({
          extraRenderers: [new CSS2DRenderer()],
        })(hostEl)
          .backgroundColor('#0f0f11')
          .nodeRelSize(4)
          .nodeVal((node) => Math.max(2, node.radius * 0.35))
          .nodeColor(nodeColorAccessor)
          .nodeLabel((node) => {
            const hubSuffix = node.isHub ? ` [HUB in:${node.inDegree} out:${node.outDegree}]` : '';
            return `${node.label} (${node.objectType})${hubSuffix}`;
          })
          .nodeThreeObjectExtend(true)
          .nodeThreeObject(nodeLabelAccessor)
          .linkColor(linkColorAccessor)
          .linkWidth(linkWidthAccessor)
          .linkOpacity(0.55)
          // contains도 방향이 보이도록 화살표를 렌더링한다.
          .linkDirectionalArrowLength((link) => (link.isContains ? 3 : 3.5))
          .linkDirectionalArrowRelPos(1)
          .linkDirectionalParticles(linkParticlesAccessor)
          .linkDirectionalParticleWidth(2.8)
          .linkThreeObjectExtend(true)
          .linkThreeObject(linkLabelAccessor)
          .linkPositionUpdate((sprite, { start, end }) => {
            const middlePos = {
              x: start.x + (end.x - start.x) / 2,
              y: start.y + (end.y - start.y) / 2,
              z: start.z + (end.z - start.z) / 2,
            };
            Object.assign(sprite.position, middlePos);
          });

        const updateHighlight = () => {
          instance
            .nodeColor(nodeColorAccessor)
            .nodeThreeObject(nodeLabelAccessor)
            .linkColor(linkColorAccessor)
            .linkWidth(linkWidthAccessor)
            .linkDirectionalParticles(linkParticlesAccessor)
            .linkThreeObject(linkLabelAccessor);
        };

        const collectReferenceContext = (rootId: string): { nodes: Set<string>; links: Set<string> } => {
          const { nodesById, links: snapshotLinks } = graphSnapshotRef.current;
          const resultNodes = new Set<string>([rootId]);
          const resultLinks = new Set<string>();
          const rootNode = nodesById.get(rootId);
          if (!rootNode) return { nodes: resultNodes, links: resultLinks };

          const parentCompoundByAtomic = new Map<string, string>();
          const containsLinkByAtomic = new Map<string, string>();
          snapshotLinks.forEach((link) => {
            if (!link.isContains) return;
            const parentId = getSemanticSourceId(link);
            const atomicId = getSemanticTargetId(link);
            parentCompoundByAtomic.set(atomicId, parentId);
            containsLinkByAtomic.set(atomicId, link.id);
          });

          const targetAtomicIds = new Set<string>();
          if (rootNode.isCompound) {
            snapshotLinks.forEach((link) => {
              if (!link.isContains) return;
              if (getSemanticSourceId(link) !== rootId) return;
              const atomicId = getSemanticTargetId(link);
              targetAtomicIds.add(atomicId);
              resultNodes.add(atomicId);
              resultLinks.add(link.id);
            });
          } else {
            targetAtomicIds.add(rootId);
            const parentId = parentCompoundByAtomic.get(rootId);
            if (parentId) {
              resultNodes.add(parentId);
              const containsId = containsLinkByAtomic.get(rootId);
              if (containsId) resultLinks.add(containsId);
            }
          }

          snapshotLinks.forEach((link) => {
            if (link.isContains) return;

            const sourceId = getSemanticSourceId(link);
            const targetId = getSemanticTargetId(link);
            const touchesFocusedAtomic =
              targetAtomicIds.has(sourceId) || targetAtomicIds.has(targetId);
            const touchesRoot = sourceId === rootId || targetId === rootId;
            if (!touchesFocusedAtomic && !touchesRoot) return;

            // 대상의 inbound/outbound 관계를 모두 하이라이트한다.
            resultLinks.add(link.id);

            resultNodes.add(sourceId);
            const sourceNode = nodesById.get(sourceId);
            if (sourceNode && !sourceNode.isCompound) {
              const sourceParentId = parentCompoundByAtomic.get(sourceId);
              if (sourceParentId) {
                resultNodes.add(sourceParentId);
                const sourceContainsId = containsLinkByAtomic.get(sourceId);
                if (sourceContainsId) resultLinks.add(sourceContainsId);
              }
            }

            resultNodes.add(targetId);
            const targetNode = nodesById.get(targetId);
            if (targetNode && !targetNode.isCompound) {
              const targetParentId = parentCompoundByAtomic.get(targetId);
              if (targetParentId) {
                resultNodes.add(targetParentId);
                const targetContainsId = containsLinkByAtomic.get(targetId);
                if (targetContainsId) resultLinks.add(targetContainsId);
              }
            }
          });

          return { nodes: resultNodes, links: resultLinks };
        };

        const applyPinnedHighlightByRootId = (rootId: string | null) => {
          pinnedNodeIdsRef.current.clear();
          pinnedLinkIdsRef.current.clear();
          if (!rootId) return;
          const context = collectReferenceContext(rootId);
          context.nodes.forEach((id) => pinnedNodeIdsRef.current.add(id));
          context.links.forEach((id) => pinnedLinkIdsRef.current.add(id));
        };
        applyPinnedHighlightByRootIdRef.current = applyPinnedHighlightByRootId;
        refreshHighlightRef.current = updateHighlight;

        instance
          .onNodeClick((node, event) => {
            focusNode(instance, node);
            pinnedRootNodeIdRef.current = node.id;
            applyPinnedHighlightByRootId(pinnedRootNodeIdRef.current);
            updateHighlight();
            onNodeClickRef.current?.(node, event);
          })
          .onBackgroundClick(() => {
            highlightNodeIdsRef.current.clear();
            highlightLinkIdsRef.current.clear();
            pinnedNodeIdsRef.current.clear();
            pinnedLinkIdsRef.current.clear();
            pinnedRootNodeIdRef.current = null;
            hoverNodeIdRef.current = null;
            updateHighlight();
            onBackgroundClickRef.current?.();
          })
          .onNodeHover((node) => {
            const prevHoverNodeId = hoverNodeIdRef.current;
            if ((!node && highlightNodeIdsRef.current.size === 0) || (node && prevHoverNodeId === node.id)) {
              return;
            }

            highlightNodeIdsRef.current.clear();
            highlightLinkIdsRef.current.clear();
            hoverNodeIdRef.current = node?.id ?? null;

            if (node) {
              const context = collectReferenceContext(node.id);
              context.nodes.forEach((id) => highlightNodeIdsRef.current.add(id));
              context.links.forEach((id) => highlightLinkIdsRef.current.add(id));
            }
            updateHighlight();
          })
          .onLinkHover((link) => {
            highlightNodeIdsRef.current.clear();
            highlightLinkIdsRef.current.clear();
            hoverNodeIdRef.current = null;

            if (link) {
              highlightLinkIdsRef.current.add(link.id);
              highlightNodeIdsRef.current.add(getLinkNodeId(link.source));
              highlightNodeIdsRef.current.add(getLinkNodeId(link.target));
            }
            updateHighlight();
          });

        const resize = () => {
          const rect = hostEl.getBoundingClientRect();
          if (!rect) return;
          instance.width(Math.max(1, Math.floor(rect.width))).height(Math.max(1, Math.floor(rect.height)));
        };

        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(hostEl);

        instanceRef.current = instance;

        const initialData = cloneGraphData(nodesRef.current, linksRef.current);
        graphSnapshotRef.current = {
          nodesById: new Map(initialData.nodes.map((node) => [node.id, node])),
          links: initialData.links,
        };
        instance.graphData(initialData);
        setReady(true);
        if (initialData.nodes.length > 0) {
          setTimeout(() => {
            if (!cancelled && instanceRef.current === instance) {
              instance.zoomToFit(500, 80);
            }
          }, 120);
        }
        setTimeout(() => {
          if (!cancelled && hostEl.querySelector('canvas') == null) {
            setInitError('3D renderer unavailable in this environment');
          }
        }, 250);

        const cleanup = () => {
          observer.disconnect();
          try {
            instance._destructor?.();
          } catch (error) {
            console.error('[RollupGraph3D] cleanup 실패:', error);
          }
          hostEl.innerHTML = '';
        };

        (hostEl as unknown as { __cleanup3d?: () => void }).__cleanup3d = cleanup;
      } catch (error) {
        console.error('[RollupGraph3D] 초기화 실패:', error);
        setInitError(`3D renderer unavailable: ${toErrorMessage(error)}`);
        setReady(false);
      }
    };

    void init();

    return () => {
      cancelled = true;
      const cleanup = (hostEl as unknown as { __cleanup3d?: () => void } | null)?.__cleanup3d;
      cleanup?.();
      if (hostEl) delete (hostEl as unknown as { __cleanup3d?: () => void }).__cleanup3d;
      refreshHighlightRef.current = null;
      applyPinnedHighlightByRootIdRef.current = null;
      instanceRef.current = null;
      setReady(false);
      setInitError(null);
    };
  }, []);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;

    try {
      highlightNodeIdsRef.current.clear();
      highlightLinkIdsRef.current.clear();
      pinnedNodeIdsRef.current.clear();
      pinnedLinkIdsRef.current.clear();
      hoverNodeIdRef.current = null;

      const nextData = cloneGraphData(nodes, links);
      graphSnapshotRef.current = {
        nodesById: new Map(nextData.nodes.map((node) => [node.id, node])),
        links: nextData.links,
      };
      instance.graphData(nextData);
      applyPinnedHighlightByRootIdRef.current?.(pinnedRootNodeIdRef.current);
      refreshHighlightRef.current?.();
      if (nextData.nodes.length > 0) {
        setTimeout(() => {
          if (instanceRef.current === instance) {
            instance.zoomToFit(450, 80);
          }
        }, 80);
      }
    } catch (error) {
      console.error('[RollupGraph3D] graphData 업데이트 실패:', error);
      setInitError(`3D renderer unavailable: ${toErrorMessage(error)}`);
      setReady(false);
    }
  }, [nodes, links]);

  return (
    <div data-testid="mapping-graph-3d" className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" />
      {!ready && !initError && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-zinc-400">
          3D renderer loading...
        </div>
      )}
      {initError && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-amber-300">
          {initError}
        </div>
      )}
      {ready && !hasData && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-zinc-500">
          표시할 그래프가 없습니다.
        </div>
      )}
    </div>
  );
}
