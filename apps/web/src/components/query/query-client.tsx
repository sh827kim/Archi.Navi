/**
 * Query Engine 직접 호출 UI
 * - 쿼리 타입 선택 (IMPACT_ANALYSIS, PATH_DISCOVERY, USAGE_DISCOVERY, DOMAIN_SUMMARY)
 * - Object 검색/선택
 * - 결과를 사람 친화적 요약 + 상세 목록으로 표시
 */
'use client';

import { useState, useEffect, useCallback, type ReactNode } from 'react';
import {
  Search, Play, Loader2, ArrowRight, Route, Users, Layers, Network,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  cn, Button, Badge, Input,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@archi-navi/ui';
import { useWorkspace } from '@/contexts/workspace-context';

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
  queryType: QueryType;
  result: {
    nodes: QueryNode[];
    edges: QueryEdge[];
    paths?: QueryPath[];
    summary?: Record<string, unknown>;
  };
}

const QUERY_TYPE_CONFIG = {
  IMPACT_ANALYSIS: {
    label: '영향도 분석',
    description: '특정 Object 변경 시 영향 범위를 분석합니다',
    icon: Network,
  },
  PATH_DISCOVERY: {
    label: '경로 탐색',
    description: '두 Object 간 연결 경로를 탐색합니다',
    icon: Route,
  },
  USAGE_DISCOVERY: {
    label: '사용 주체 추적',
    description: '특정 Object를 사용하는 주체를 추적합니다',
    icon: Users,
  },
  DOMAIN_SUMMARY: {
    label: '도메인 요약',
    description: '도메인별 구조 요약 정보를 조회합니다',
    icon: Layers,
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

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase();
}

function getObjectLabel(object: ObjectOption | QueryNode | null | undefined): string {
  if (!object) return '-';
  return object.displayName ?? object.name;
}

function getObjectMetaLabel(object: ObjectOption | QueryNode | null | undefined): string | null {
  if (!object || !object.displayName) return null;
  return object.name;
}

function getNodeById(nodes: QueryNode[], id: string): QueryNode | undefined {
  return nodes.find((node) => node.id === id);
}

function readNumber(summary: Record<string, unknown>, key: string): number | null {
  const value = summary[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(summary: Record<string, unknown>, key: string): string | null {
  const value = summary[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readRecord(summary: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = summary[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function formatPercent(value: number | null): string {
  if (value === null) return '-';
  return `${Math.round(value * 100)}%`;
}

function formatScore(value: number | null): string {
  if (value === null) return '-';
  return value.toFixed(2);
}

function SummaryMetric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/60 px-4 py-3">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold text-foreground">{value}</p>
    </div>
  );
}

function ObjectPicker({
  label,
  value,
  onChange,
  objects,
  searchValue,
  onSearchChange,
  objectTypeFilter,
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  objects: ObjectOption[];
  searchValue: string;
  onSearchChange: (value: string) => void;
  objectTypeFilter?: string;
}) {
  const selected = objects.find((object) => object.id === value) ?? null;
  const filteredObjects = objects
    .filter((object) => !objectTypeFilter || object.objectType === objectTypeFilter)
    .filter((object) => {
      const keyword = normalizeSearch(searchValue);
      if (!keyword) return true;
      return (
        object.name.toLowerCase().includes(keyword) ||
        (object.displayName?.toLowerCase().includes(keyword) ?? false)
      );
    })
    .slice(0, 20);

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {selected ? (
        <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-1.5 text-sm">
          <Badge variant="outline" className="text-[10px]">{selected.objectType}</Badge>
          <span className="font-medium">{getObjectLabel(selected)}</span>
          {getObjectMetaLabel(selected) && (
            <span className="text-xs text-muted-foreground">({getObjectMetaLabel(selected)})</span>
          )}
          <button
            type="button"
            onClick={() => onChange('')}
            className="ml-auto text-muted-foreground hover:text-foreground"
            aria-label={`${label} 선택 해제`}
          >
            ×
          </button>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Object 이름 검색..."
              className="h-9 pl-8 text-sm"
              value={searchValue}
              onChange={(event) => onSearchChange(event.target.value)}
            />
          </div>
          <div className="max-h-32 overflow-y-auto rounded-lg border border-border bg-background">
            {filteredObjects.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">검색 결과가 없습니다</p>
            ) : (
              filteredObjects.map((object) => (
                <button
                  key={object.id}
                  type="button"
                  onClick={() => {
                    onChange(object.id);
                    onSearchChange('');
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-muted/50"
                >
                  <Badge variant="outline" className="shrink-0 text-[10px]">{object.objectType}</Badge>
                  <span className="truncate">{getObjectLabel(object)}</span>
                  <span className="ml-auto truncate text-[10px] text-muted-foreground">{object.name}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function QueryInsight({
  result,
  fromObject,
  toObject,
  targetObject,
  domainObject,
}: {
  result: QueryResult;
  fromObject: ObjectOption | null;
  toObject: ObjectOption | null;
  targetObject: ObjectOption | null;
  domainObject: ObjectOption | null;
}) {
  const summary = result.result.summary ?? {};
  const nodeCount = result.result.nodes.length;
  const edgeCount = result.result.edges.length;
  const pathCount = result.result.paths?.length ?? 0;

  if (result.queryType === 'IMPACT_ANALYSIS') {
    return (
      <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
        <p className="text-sm font-semibold">
          {getObjectLabel(fromObject)} 기준 영향 범위를 {nodeCount}개 노드, {edgeCount}개 관계로 찾았습니다.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          직접 확인할 대상은 엣지 목록 상단부터 보면 됩니다. 깊이 정보가 있으면 가까운 영향부터 순서대로 검토하세요.
        </p>
      </div>
    );
  }

  if (result.queryType === 'PATH_DISCOVERY') {
    return (
      <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
        <p className="text-sm font-semibold">
          {getObjectLabel(fromObject)}에서 {getObjectLabel(toObject)}까지 {pathCount}개의 후보 경로를 찾았습니다.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          점수가 높은 경로가 우선 노출됩니다. 가장 짧은 경로와 점수가 높은 경로가 다를 수 있으니 둘 다 확인하세요.
        </p>
      </div>
    );
  }

  if (result.queryType === 'USAGE_DISCOVERY') {
    return (
      <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
        <p className="text-sm font-semibold">
          {getObjectLabel(targetObject)}를 사용하는 주체를 {Math.max(nodeCount - 1, 0)}개 찾았습니다.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          대상 Object 자신도 목록에 함께 포함될 수 있습니다. 엣지 목록에서 실제 사용 방향을 확인하세요.
        </p>
      </div>
    );
  }

  const domainType = readString(summary, 'type');
  if (domainType === 'DOMAIN_LIST') {
    const domainCount = readNumber(summary, 'domainCount') ?? nodeCount;
    return (
      <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
        <p className="text-sm font-semibold">현재 워크스페이스의 도메인 {domainCount}개를 찾았습니다.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          특정 도메인을 선택하면 멤버 서비스, purity, 외부 의존까지 상세하게 볼 수 있습니다.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
      <p className="text-sm font-semibold">{getObjectLabel(domainObject)} 도메인 구조를 집계했습니다.</p>
      <p className="mt-1 text-sm text-muted-foreground">
        상위 멤버, 외부 의존, 관계 밀도를 먼저 보고 경계가 선명한 도메인인지 판단할 수 있습니다.
      </p>
    </div>
  );
}

function DomainSummaryPanel({ summary }: { summary: Record<string, unknown> }) {
  const type = readString(summary, 'type');

  if (type === 'DOMAIN_LIST') {
    const domains = Array.isArray(summary['domains']) ? summary['domains'] : [];
    return (
      <div className="rounded-xl border border-border/60 bg-background/70 p-4">
        <h3 className="text-sm font-semibold">도메인 목록</h3>
        <div className="mt-3 space-y-2">
          {domains.length === 0 ? (
            <p className="text-sm text-muted-foreground">등록된 도메인이 없습니다.</p>
          ) : (
            domains.map((domain, index) => {
              const record = domain && typeof domain === 'object' ? domain as Record<string, unknown> : {};
              const label = typeof record['displayName'] === 'string'
                ? record['displayName']
                : typeof record['name'] === 'string'
                  ? record['name']
                  : `도메인 ${index + 1}`;
              const name = typeof record['name'] === 'string' ? record['name'] : null;
              return (
                <div key={String(record['id'] ?? index)} className="rounded-lg border border-border/50 px-3 py-2">
                  <p className="text-sm font-medium">{label}</p>
                  {name && label !== name && (
                    <p className="text-xs text-muted-foreground">{name}</p>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }

  const membersByType = readRecord(summary, 'membersByType') ?? {};
  const topMembers = Array.isArray(summary['topMembers']) ? summary['topMembers'] : [];
  const externalDependencies = Array.isArray(summary['externalDependencies'])
    ? summary['externalDependencies']
    : [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryMetric label="멤버 수" value={readNumber(summary, 'memberCount') ?? 0} />
        <SummaryMetric label="평균 purity" value={formatPercent(readNumber(summary, 'avgPurity'))} />
        <SummaryMetric label="평균 affinity" value={formatScore(readNumber(summary, 'avgAffinity'))} />
        <SummaryMetric label="관계 밀도" value={formatPercent(readNumber(summary, 'relationDensity'))} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border/60 bg-background/70 p-4">
          <h3 className="text-sm font-semibold">멤버 타입 분포</h3>
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.keys(membersByType).length === 0 ? (
              <p className="text-sm text-muted-foreground">집계된 멤버가 없습니다.</p>
            ) : (
              Object.entries(membersByType).map(([type, count]) => (
                <Badge key={type} variant="outline">{type} {String(count)}</Badge>
              ))
            )}
          </div>
        </div>

        <div className="rounded-xl border border-border/60 bg-background/70 p-4">
          <h3 className="text-sm font-semibold">상위 멤버</h3>
          <div className="mt-3 space-y-2">
            {topMembers.length === 0 ? (
              <p className="text-sm text-muted-foreground">상위 멤버 정보가 없습니다.</p>
            ) : (
              topMembers.map((member, index) => {
                const record = member && typeof member === 'object' ? member as Record<string, unknown> : {};
                return (
                  <div key={String(record['id'] ?? index)} className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2">
                    <div>
                      <p className="text-sm font-medium">{String(record['name'] ?? '-')}</p>
                      <p className="text-xs text-muted-foreground">{String(record['objectType'] ?? '-')}</p>
                    </div>
                    <span className="text-sm text-muted-foreground">
                      affinity {formatScore(typeof record['affinity'] === 'number' ? record['affinity'] : null)}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border/60 bg-background/70 p-4">
        <h3 className="text-sm font-semibold">외부 의존 도메인</h3>
        <div className="mt-3 space-y-2">
          {externalDependencies.length === 0 ? (
            <p className="text-sm text-muted-foreground">외부 의존 도메인이 없습니다.</p>
          ) : (
            externalDependencies.map((dependency, index) => {
              const record = dependency && typeof dependency === 'object'
                ? dependency as Record<string, unknown>
                : {};
              return (
                <div key={String(record['domainId'] ?? index)} className="rounded-lg border border-border/50 px-3 py-2">
                  <p className="text-sm font-medium">{String(record['domainId'] ?? '-')}</p>
                  <p className="text-xs text-muted-foreground">
                    {String(record['relationType'] ?? 'depend_on')}
                    {' · '}
                    weight {String(record['edgeWeight'] ?? '-')}
                    {' · '}
                    confidence {formatPercent(typeof record['confidence'] === 'number' ? record['confidence'] : null)}
                  </p>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

export function QueryClient() {
  const { workspaceId } = useWorkspace();
  const [queryType, setQueryType] = useState<QueryType>('IMPACT_ANALYSIS');
  const [level, setLevel] = useState('SERVICE_TO_SERVICE');
  const [direction, setDirection] = useState('DOWNSTREAM');
  const [maxDepth, setMaxDepth] = useState(3);
  const [fromObjectId, setFromObjectId] = useState('');
  const [toObjectId, setToObjectId] = useState('');
  const [usageObjectId, setUsageObjectId] = useState('');
  const [domainId, setDomainId] = useState('');
  const [searchByField, setSearchByField] = useState<Record<string, string>>({
    from: '',
    to: '',
    usage: '',
    domain: '',
  });
  const [objects, setObjects] = useState<ObjectOption[]>([]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    fetch(`/api/objects?workspaceId=${workspaceId}`)
      .then(async (response) => await response.json())
      .then((data: ObjectOption[]) => setObjects(data))
      .catch(() => {
        setObjects([]);
      });
  }, [workspaceId]);

  const setSearchValue = useCallback((field: string, value: string) => {
    setSearchByField((current) => ({ ...current, [field]: value }));
  }, []);

  const executeQuery = useCallback(async () => {
    if (!workspaceId) return;

    const params: Record<string, string | number> = {};
    if (queryType === 'IMPACT_ANALYSIS') {
      if (!fromObjectId) {
        toast.error('시작 Object를 선택하세요');
        return;
      }
      params.targetObjectId = fromObjectId;
      params.direction = direction;
      params.maxDepth = maxDepth;
    } else if (queryType === 'PATH_DISCOVERY') {
      if (!fromObjectId || !toObjectId) {
        toast.error('시작/도착 Object를 모두 선택하세요');
        return;
      }
      params.fromObjectId = fromObjectId;
      params.toObjectId = toObjectId;
      params.maxHops = maxDepth;
    } else if (queryType === 'USAGE_DISCOVERY') {
      if (!usageObjectId) {
        toast.error('대상 Object를 선택하세요');
        return;
      }
      params.objectId = usageObjectId;
    } else {
      if (!domainId) {
        toast.error('도메인 Object를 선택하세요');
        return;
      }
      params.domainId = domainId;
    }

    setLoading(true);
    setResult(null);
    try {
      const response = await fetch('/api/query', {
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

      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(error.error ?? '쿼리 실행 실패');
      }

      const data = await response.json() as QueryResult;
      setResult(data);
      toast.success(`노드 ${data.result.nodes.length}개, 엣지 ${data.result.edges.length}개 조회됨`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '쿼리 실행 실패');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, queryType, level, direction, maxDepth, fromObjectId, toObjectId, usageObjectId, domainId]);

  const config = QUERY_TYPE_CONFIG[queryType];
  const TypeIcon = config.icon;
  const fromObject = objects.find((object) => object.id === fromObjectId) ?? null;
  const toObject = objects.find((object) => object.id === toObjectId) ?? null;
  const usageObject = objects.find((object) => object.id === usageObjectId) ?? null;
  const domainObject = objects.find((object) => object.id === domainId) ?? null;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">쿼리 엔진</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          영향도, 경로, 사용 주체, 도메인 구조를 사람이 읽기 쉬운 형태로 바로 확인합니다.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-1">
          <div className="glass-card space-y-4 rounded-xl p-5">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">쿼리 타입</label>
              <div className="grid grid-cols-2 gap-2">
                {(Object.entries(QUERY_TYPE_CONFIG) as [QueryType, typeof config][]).map(([type, item]) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setQueryType(type)}
                      className={cn(
                        'flex flex-col items-center gap-1.5 rounded-lg border p-3 text-xs transition-all',
                        queryType === type
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:border-primary/30 hover:text-foreground',
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {item.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">{config.description}</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Rollup 레벨</label>
              <Select value={level} onValueChange={setLevel}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLLUP_LEVELS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {(queryType === 'IMPACT_ANALYSIS' || queryType === 'PATH_DISCOVERY') && (
              <ObjectPicker
                label="시작 Object"
                value={fromObjectId}
                onChange={setFromObjectId}
                objects={objects}
                searchValue={searchByField.from}
                onSearchChange={(value) => setSearchValue('from', value)}
              />
            )}

            {queryType === 'PATH_DISCOVERY' && (
              <ObjectPicker
                label="도착 Object"
                value={toObjectId}
                onChange={setToObjectId}
                objects={objects}
                searchValue={searchByField.to}
                onSearchChange={(value) => setSearchValue('to', value)}
              />
            )}

            {queryType === 'USAGE_DISCOVERY' && (
              <ObjectPicker
                label="대상 Object"
                value={usageObjectId}
                onChange={setUsageObjectId}
                objects={objects}
                searchValue={searchByField.usage}
                onSearchChange={(value) => setSearchValue('usage', value)}
              />
            )}

            {queryType === 'DOMAIN_SUMMARY' && (
              <ObjectPicker
                label="도메인 Object"
                value={domainId}
                onChange={setDomainId}
                objects={objects}
                searchValue={searchByField.domain}
                onSearchChange={(value) => setSearchValue('domain', value)}
                objectTypeFilter="domain"
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
                    {DIRECTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
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
                  value={maxDepth}
                  onChange={(event) => setMaxDepth(Number(event.target.value))}
                  className="h-9 text-sm"
                />
              </div>
            )}

            <Button className="w-full" onClick={() => void executeQuery()} disabled={loading}>
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              쿼리 실행
            </Button>
          </div>
        </div>

        <div className="space-y-4 lg:col-span-2">
          {!result && !loading && (
            <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted-foreground">
              <TypeIcon className="h-12 w-12 opacity-30" />
              <p className="text-sm">쿼리를 실행하면 결과 요약과 상세 근거가 여기에 표시됩니다</p>
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          )}

          {result && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <Badge className="border-primary/30 bg-primary/15 text-primary">
                  {QUERY_TYPE_CONFIG[result.queryType].label}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  노드 {result.result.nodes.length}개 · 엣지 {result.result.edges.length}개
                  {result.result.paths && ` · 경로 ${result.result.paths.length}개`}
                </span>
              </div>

              <QueryInsight
                result={result}
                fromObject={fromObject}
                toObject={toObject}
                targetObject={usageObject}
                domainObject={domainObject}
              />

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <SummaryMetric label="노드" value={result.result.nodes.length} />
                <SummaryMetric label="엣지" value={result.result.edges.length} />
                <SummaryMetric label="경로" value={result.result.paths?.length ?? 0} />
                <SummaryMetric
                  label="평균 신뢰도"
                  value={formatPercent(
                    result.result.edges.length > 0
                      ? result.result.edges.reduce((sum, edge) => sum + edge.confidence, 0) / result.result.edges.length
                      : null,
                  )}
                />
              </div>

              {result.result.summary && Object.keys(result.result.summary).length > 0 && result.queryType === 'DOMAIN_SUMMARY' && (
                <DomainSummaryPanel summary={result.result.summary} />
              )}

              {result.result.paths && result.result.paths.length > 0 && (
                <div className="rounded-xl border border-border/60 bg-background/70 p-4">
                  <h3 className="text-sm font-semibold">경로 후보</h3>
                  <div className="mt-3 space-y-3">
                    {result.result.paths.map((path) => (
                      <div key={path.pathId} className="rounded-lg border border-border/50 p-3">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Route className="h-3.5 w-3.5" />
                          <span>점수 {path.score.toFixed(2)}</span>
                          <span>· 홉 {Math.max(path.nodeIds.length - 1, 0)}</span>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
                          {path.nodeIds.map((nodeId, index) => {
                            const node = getNodeById(result.result.nodes, nodeId);
                            return (
                              <span key={`${path.pathId}-${nodeId}`} className="flex items-center gap-1.5">
                                {index > 0 && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
                                <span className="font-medium">{getObjectLabel(node)}</span>
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-border/60 bg-background/70 overflow-hidden">
                <div className="border-b border-border/50 px-4 py-3">
                  <h3 className="text-sm font-semibold">노드 ({result.result.nodes.length})</h3>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {result.result.nodes.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-muted-foreground">결과 없음</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-background/90 backdrop-blur">
                        <tr className="border-b border-border/30 text-xs text-muted-foreground">
                          <th className="px-4 py-2 text-left">이름</th>
                          <th className="px-4 py-2 text-left">타입</th>
                          <th className="px-4 py-2 text-left">Depth</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.result.nodes.map((node) => (
                          <tr key={node.id} className="border-b border-border/20 hover:bg-muted/30">
                            <td className="px-4 py-2">
                              <span className="font-medium">{getObjectLabel(node)}</span>
                              {getObjectMetaLabel(node) && (
                                <span className="ml-1.5 text-xs text-muted-foreground">({getObjectMetaLabel(node)})</span>
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

              <div className="rounded-xl border border-border/60 bg-background/70 overflow-hidden">
                <div className="border-b border-border/50 px-4 py-3">
                  <h3 className="text-sm font-semibold">관계 ({result.result.edges.length})</h3>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {result.result.edges.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-muted-foreground">결과 없음</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-background/90 backdrop-blur">
                        <tr className="border-b border-border/30 text-xs text-muted-foreground">
                          <th className="px-4 py-2 text-left">Source</th>
                          <th className="px-2 py-2 text-left"></th>
                          <th className="px-4 py-2 text-left">Target</th>
                          <th className="px-4 py-2 text-left">타입</th>
                          <th className="px-4 py-2 text-left">신뢰도</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.result.edges.map((edge, index) => {
                          const source = getNodeById(result.result.nodes, edge.subjectId);
                          const target = getNodeById(result.result.nodes, edge.objectId);
                          return (
                            <tr key={`${edge.subjectId}-${edge.objectId}-${index}`} className="border-b border-border/20 hover:bg-muted/30">
                              <td className="max-w-[160px] truncate px-4 py-2 font-medium">
                                {getObjectLabel(source)}
                              </td>
                              <td className="px-2 py-2 text-muted-foreground">
                                <ArrowRight className="h-3.5 w-3.5" />
                              </td>
                              <td className="max-w-[160px] truncate px-4 py-2 font-medium">
                                {getObjectLabel(target)}
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
