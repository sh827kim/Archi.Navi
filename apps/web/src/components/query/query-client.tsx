/**
 * Query Engine 직접 호출 UI
 * - 쿼리 타입 선택 (IMPACT_ANALYSIS, PATH_DISCOVERY, USAGE_DISCOVERY, DOMAIN_SUMMARY)
 * - Object 검색/선택
 * - 결과를 노드/엣지/경로 테이블로 표시
 */
'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Search, Play, Loader2, ArrowRight, ArrowLeft,
  ChevronDown, Network, Route, Users, Layers,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  cn, Button, Badge, Input,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@archi-navi/ui';
import { useWorkspace } from '@/contexts/workspace-context';

/* ─── 타입 ─── */
interface ObjectOption {
  id: string;
  name: string;
  displayName: string | null;
  objectType: string;
}

interface QueryNode {
  id: string;
  type: string;
  name: string;
  displayName?: string;
  depth?: number;
}

interface QueryEdge {
  subjectId: string;
  objectId: string;
  relationType: string;
  level: string;
  edgeWeight: number;
  confidence: number;
}

interface QueryPath {
  pathId: string;
  nodeIds: string[];
  score: number;
}

interface QueryResult {
  queryType: string;
  result: {
    nodes: QueryNode[];
    edges: QueryEdge[];
    paths?: QueryPath[];
    summary?: Record<string, unknown>;
  };
}

/* ─── 쿼리 타입별 설정 ─── */
const QUERY_TYPE_CONFIG = {
  IMPACT_ANALYSIS: {
    label: '영향도 분석',
    description: '특정 Object 변경 시 영향 범위를 분석합니다',
    icon: Network,
    requiredParams: ['fromObjectId', 'direction'] as const,
  },
  PATH_DISCOVERY: {
    label: '경로 탐색',
    description: '두 Object 간 연결 경로를 탐색합니다',
    icon: Route,
    requiredParams: ['fromObjectId', 'toObjectId'] as const,
  },
  USAGE_DISCOVERY: {
    label: '사용 주체 추적',
    description: '특정 Object를 사용하는 주체를 추적합니다',
    icon: Users,
    requiredParams: ['targetObjectId'] as const,
  },
  DOMAIN_SUMMARY: {
    label: '도메인 요약',
    description: '도메인별 구조 요약 정보를 조회합니다',
    icon: Layers,
    requiredParams: ['domainId'] as const,
  },
} as const;

type QueryType = keyof typeof QUERY_TYPE_CONFIG;

const ROLLUP_LEVELS = [
  { value: 'SERVICE_TO_SERVICE', label: 'Service → Service' },
  { value: 'SERVICE_TO_DATABASE', label: 'Service → Database' },
  { value: 'SERVICE_TO_BROKER', label: 'Service → Broker' },
  { value: 'DOMAIN_TO_DOMAIN', label: 'Domain → Domain' },
];

const DIRECTIONS = [
  { value: 'DOWNSTREAM', label: '하류 (Downstream)' },
  { value: 'UPSTREAM', label: '상류 (Upstream)' },
  { value: 'BOTH', label: '양방향 (Both)' },
];

export function QueryClient() {
  const { workspaceId } = useWorkspace();

  /* 폼 상태 */
  const [queryType, setQueryType] = useState<QueryType>('IMPACT_ANALYSIS');
  const [level, setLevel] = useState('SERVICE_TO_SERVICE');
  const [direction, setDirection] = useState('DOWNSTREAM');
  const [maxHops, setMaxHops] = useState(3);
  const [fromObjectId, setFromObjectId] = useState('');
  const [toObjectId, setToObjectId] = useState('');
  const [targetObjectId, setTargetObjectId] = useState('');
  const [domainId, setDomainId] = useState('');

  /* Object 검색 */
  const [objects, setObjects] = useState<ObjectOption[]>([]);
  const [objectSearch, setObjectSearch] = useState('');

  /* 결과 */
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);

  /* Object 목록 로드 */
  useEffect(() => {
    if (!workspaceId) return;
    fetch(`/api/objects?workspaceId=${workspaceId}`)
      .then((r) => r.json())
      .then((data: ObjectOption[]) => setObjects(data))
      .catch(() => { /* 무시 */ });
  }, [workspaceId]);

  /* 검색 필터된 Object 목록 */
  const filteredObjects = objectSearch
    ? objects.filter((o) =>
      o.name.toLowerCase().includes(objectSearch.toLowerCase()) ||
      (o.displayName?.toLowerCase().includes(objectSearch.toLowerCase()) ?? false)
    ).slice(0, 20)
    : objects.slice(0, 20);

  /* 쿼리 실행 */
  const executeQuery = useCallback(async () => {
    if (!workspaceId) return;

    // 파라미터 구성
    const params: Record<string, string | number> = {};
    if (queryType === 'IMPACT_ANALYSIS') {
      if (!fromObjectId) { toast.error('시작 Object를 선택하세요'); return; }
      params.fromObjectId = fromObjectId;
      params.direction = direction;
      params.maxHops = maxHops;
    } else if (queryType === 'PATH_DISCOVERY') {
      if (!fromObjectId || !toObjectId) { toast.error('시작/도착 Object를 모두 선택하세요'); return; }
      params.fromObjectId = fromObjectId;
      params.toObjectId = toObjectId;
      params.maxHops = maxHops;
    } else if (queryType === 'USAGE_DISCOVERY') {
      if (!targetObjectId) { toast.error('대상 Object를 선택하세요'); return; }
      params.targetObjectId = targetObjectId;
    } else if (queryType === 'DOMAIN_SUMMARY') {
      if (!domainId) { toast.error('도메인 Object를 선택하세요'); return; }
      params.domainId = domainId;
    }

    setLoading(true);
    setResult(null);
    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          queryType,
          scope: {
            level,
            visibility: 'VISIBLE_ONLY',
          },
          params,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? '쿼리 실패');
      }
      const data = (await res.json()) as QueryResult;
      setResult(data);
      toast.success(`노드 ${data.result.nodes.length}개, 엣지 ${data.result.edges.length}개 조회됨`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '쿼리 실행 실패');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, queryType, level, direction, maxHops, fromObjectId, toObjectId, targetObjectId, domainId]);

  /* Object 선택기 컴포넌트 */
  const ObjectPicker = ({ value, onChange, label }: {
    value: string;
    onChange: (id: string) => void;
    label: string;
  }) => {
    const selected = objects.find((o) => o.id === value);
    return (
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{label}</label>
        {selected && (
          <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-1.5 text-sm">
            <Badge variant="outline" className="text-[10px]">{selected.objectType}</Badge>
            <span className="font-medium">{selected.displayName ?? selected.name}</span>
            <button
              onClick={() => onChange('')}
              className="ml-auto text-muted-foreground hover:text-foreground"
            >×</button>
          </div>
        )}
        {!selected && (
          <div className="space-y-1">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Object 이름 검색..."
                className="pl-8 h-9 text-sm"
                value={objectSearch}
                onChange={(e) => setObjectSearch(e.target.value)}
              />
            </div>
            <div className="max-h-32 overflow-y-auto rounded-lg border border-border bg-background">
              {filteredObjects.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">Object가 없습니다</p>
              ) : (
                filteredObjects.map((obj) => (
                  <button
                    key={obj.id}
                    onClick={() => { onChange(obj.id); setObjectSearch(''); }}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-muted/50 transition-colors text-left"
                  >
                    <Badge variant="outline" className="text-[10px] shrink-0">{obj.objectType}</Badge>
                    <span className="truncate">{obj.displayName ?? obj.name}</span>
                    <span className="text-[10px] text-muted-foreground truncate ml-auto">{obj.name}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  const config = QUERY_TYPE_CONFIG[queryType];
  const TypeIcon = config.icon;

  return (
    <div className="space-y-6 p-6">
      {/* 헤더 */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">쿼리 엔진</h1>
        <p className="text-sm text-muted-foreground mt-1">
          결정론적 쿼리 엔진으로 영향도, 경로, 사용 주체를 직접 조회합니다
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 좌측: 쿼리 폼 */}
        <div className="lg:col-span-1 space-y-4">
          <div className="rounded-xl p-5 space-y-4 glass-card">
            {/* 쿼리 타입 선택 */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">쿼리 타입</label>
              <div className="grid grid-cols-2 gap-2">
                {(Object.entries(QUERY_TYPE_CONFIG) as [QueryType, typeof config][]).map(([type, cfg]) => {
                  const Icon = cfg.icon;
                  return (
                    <button
                      key={type}
                      onClick={() => setQueryType(type)}
                      className={cn(
                        'flex flex-col items-center gap-1.5 rounded-lg border p-3 text-xs transition-all',
                        queryType === type
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border hover:border-primary/30 text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {cfg.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">{config.description}</p>
            </div>

            {/* Rollup 레벨 */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Rollup 레벨</label>
              <Select value={level} onValueChange={setLevel}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLLUP_LEVELS.map((l) => (
                    <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* 쿼리 타입별 파라미터 */}
            {(queryType === 'IMPACT_ANALYSIS' || queryType === 'PATH_DISCOVERY') && (
              <ObjectPicker
                value={fromObjectId}
                onChange={setFromObjectId}
                label="시작 Object"
              />
            )}

            {queryType === 'PATH_DISCOVERY' && (
              <ObjectPicker
                value={toObjectId}
                onChange={setToObjectId}
                label="도착 Object"
              />
            )}

            {queryType === 'USAGE_DISCOVERY' && (
              <ObjectPicker
                value={targetObjectId}
                onChange={setTargetObjectId}
                label="대상 Object"
              />
            )}

            {queryType === 'DOMAIN_SUMMARY' && (
              <ObjectPicker
                value={domainId}
                onChange={setDomainId}
                label="도메인 Object"
              />
            )}

            {queryType === 'IMPACT_ANALYSIS' && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">방향</label>
                <Select value={direction} onValueChange={setDirection}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DIRECTIONS.map((d) => (
                      <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {(queryType === 'IMPACT_ANALYSIS' || queryType === 'PATH_DISCOVERY') && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">최대 홉 수</label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={maxHops}
                  onChange={(e) => setMaxHops(Number(e.target.value))}
                  className="h-9 text-sm"
                />
              </div>
            )}

            {/* 실행 버튼 */}
            <Button
              className="w-full"
              onClick={() => void executeQuery()}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Play className="h-4 w-4 mr-2" />
              )}
              쿼리 실행
            </Button>
          </div>
        </div>

        {/* 우측: 결과 */}
        <div className="lg:col-span-2 space-y-4">
          {!result && !loading && (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
              <TypeIcon className="h-12 w-12 opacity-30" />
              <p className="text-sm">쿼리를 실행하면 결과가 여기에 표시됩니다</p>
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          )}

          {result && (
            <div className="space-y-4">
              {/* 결과 요약 */}
              <div className="flex items-center gap-3 flex-wrap">
                <Badge className="bg-primary/15 text-primary border-primary/30">
                  {QUERY_TYPE_CONFIG[result.queryType as QueryType]?.label ?? result.queryType}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  노드 {result.result.nodes.length}개 · 엣지 {result.result.edges.length}개
                  {result.result.paths && ` · 경로 ${result.result.paths.length}개`}
                </span>
              </div>

              {/* 노드 목록 */}
              <div className="rounded-xl glass-card overflow-hidden">
                <div className="px-4 py-3 border-b border-border/50">
                  <h3 className="text-sm font-semibold">노드 ({result.result.nodes.length})</h3>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {result.result.nodes.length === 0 ? (
                    <p className="px-4 py-6 text-sm text-muted-foreground text-center">결과 없음</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-background/80 backdrop-blur">
                        <tr className="text-xs text-muted-foreground border-b border-border/30">
                          <th className="text-left px-4 py-2">이름</th>
                          <th className="text-left px-4 py-2">타입</th>
                          <th className="text-left px-4 py-2">Depth</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.result.nodes.map((node) => (
                          <tr key={node.id} className="border-b border-border/20 hover:bg-muted/30">
                            <td className="px-4 py-2">
                              <span className="font-medium">{node.displayName ?? node.name}</span>
                              {node.displayName && (
                                <span className="text-xs text-muted-foreground ml-1.5">({node.name})</span>
                              )}
                            </td>
                            <td className="px-4 py-2">
                              <Badge variant="outline" className="text-[10px]">{node.type}</Badge>
                            </td>
                            <td className="px-4 py-2 text-muted-foreground">{node.depth ?? '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              {/* 엣지 목록 */}
              <div className="rounded-xl glass-card overflow-hidden">
                <div className="px-4 py-3 border-b border-border/50">
                  <h3 className="text-sm font-semibold">엣지 ({result.result.edges.length})</h3>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {result.result.edges.length === 0 ? (
                    <p className="px-4 py-6 text-sm text-muted-foreground text-center">결과 없음</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-background/80 backdrop-blur">
                        <tr className="text-xs text-muted-foreground border-b border-border/30">
                          <th className="text-left px-4 py-2">Source</th>
                          <th className="text-left px-4 py-2"></th>
                          <th className="text-left px-4 py-2">Target</th>
                          <th className="text-left px-4 py-2">타입</th>
                          <th className="text-left px-4 py-2">신뢰도</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.result.edges.map((edge, i) => {
                          const srcNode = result.result.nodes.find((n) => n.id === edge.subjectId);
                          const tgtNode = result.result.nodes.find((n) => n.id === edge.objectId);
                          return (
                            <tr key={i} className="border-b border-border/20 hover:bg-muted/30">
                              <td className="px-4 py-2 font-medium truncate max-w-[140px]">
                                {srcNode?.displayName ?? srcNode?.name ?? edge.subjectId.slice(0, 8)}
                              </td>
                              <td className="px-2 py-2 text-muted-foreground">
                                <ArrowRight className="h-3.5 w-3.5" />
                              </td>
                              <td className="px-4 py-2 font-medium truncate max-w-[140px]">
                                {tgtNode?.displayName ?? tgtNode?.name ?? edge.objectId.slice(0, 8)}
                              </td>
                              <td className="px-4 py-2">
                                <Badge variant="outline" className="text-[10px]">{edge.relationType}</Badge>
                              </td>
                              <td className="px-4 py-2 text-muted-foreground">
                                {(edge.confidence * 100).toFixed(0)}%
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              {/* 경로 목록 (PATH_DISCOVERY인 경우) */}
              {result.result.paths && result.result.paths.length > 0 && (
                <div className="rounded-xl glass-card overflow-hidden">
                  <div className="px-4 py-3 border-b border-border/50">
                    <h3 className="text-sm font-semibold">경로 ({result.result.paths.length})</h3>
                  </div>
                  <div className="p-4 space-y-3">
                    {result.result.paths.map((path) => (
                      <div key={path.pathId} className="rounded-lg border border-border/50 p-3 space-y-2">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Route className="h-3.5 w-3.5" />
                          <span>점수: {path.score.toFixed(2)}</span>
                          <span>· 홉: {path.nodeIds.length - 1}</span>
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap text-sm">
                          {path.nodeIds.map((nid, idx) => {
                            const node = result.result.nodes.find((n) => n.id === nid);
                            return (
                              <span key={nid} className="flex items-center gap-1.5">
                                {idx > 0 && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
                                <span className="font-medium">{node?.displayName ?? node?.name ?? nid.slice(0, 8)}</span>
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 요약 (DOMAIN_SUMMARY인 경우) */}
              {result.result.summary && Object.keys(result.result.summary).length > 0 && (
                <div className="rounded-xl glass-card overflow-hidden">
                  <div className="px-4 py-3 border-b border-border/50">
                    <h3 className="text-sm font-semibold">요약</h3>
                  </div>
                  <pre className="p-4 text-xs overflow-x-auto text-muted-foreground">
                    {JSON.stringify(result.result.summary, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
