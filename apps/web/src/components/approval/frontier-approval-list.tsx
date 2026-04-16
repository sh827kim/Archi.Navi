'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, Spinner } from '@archi-navi/ui';
import { useWorkspace } from '@/contexts/workspace-context';
import { EmptyStateGuide } from '@/components/shared/empty-state-guide';

type FrontierPatchType =
  | 'alias_binding'
  | 'provider_service_selection'
  | 'endpoint_disambiguation'
  | 'method_path_hint'
  | 'route_transform_patch';

interface FrontierListItem {
  proofStateId: string;
  intentId: string | null;
  intentType: string | null;
  sourceServiceId: string | null;
  sourceServiceName: string | null;
  sourceFunctionId: string | null;
  sourceFunctionName: string | null;
  providerServiceId: string | null;
  providerServiceName: string | null;
  status: string | null;
  frontierReason: string;
  frontierClass: string;
  retryStrategy: string;
  priority: number;
  detail: Record<string, unknown>;
  methodResolved: string | null;
  externalPathResolved: string | null;
  internalPathResolved: string | null;
  confidence: number;
}

interface FrontierDetail extends FrontierListItem {
  patchableActions: FrontierPatchType[];
  candidateServices: Array<{ id: string; name: string }>;
  candidateEndpoints: Array<{ id: string; name: string; parentId: string | null }>;
  suggestedServices: Array<{ id: string; name: string }>;
  recentProofSteps: Array<{
    id: string;
    stepOrder: number;
    stepType: string;
    status: string;
    message: string | null;
  }>;
}

function normalizeReasonToPatchType(reason: string): FrontierPatchType | null {
  if (reason === 'CONFIG_BINDING_MISSING' || reason === 'HOST_ALIAS_UNRESOLVED') return 'alias_binding';
  if (reason === 'PATH_ONLY_TARGET_UNRESOLVED') return 'alias_binding';
  if (reason === 'PROVIDER_SERVICE_AMBIGUOUS') return 'provider_service_selection';
  if (reason === 'ENDPOINT_MATCH_AMBIGUOUS') return 'endpoint_disambiguation';
  if (reason === 'METHOD_UNKNOWN' || reason === 'PROVIDER_ENDPOINT_NOT_FOUND' || reason === 'PATH_TEMPLATE_UNKNOWN') {
    return 'method_path_hint';
  }
  if (reason === 'ROUTE_FAMILY_DERIVATION_EMPTY' || reason === 'ROUTE_TO_ENDPOINT_COMPOSITION_FAILED') {
    return 'route_transform_patch';
  }
  return null;
}

function renderReasonBadge(reason: string) {
  switch (reason) {
    case 'CONFIG_BINDING_MISSING':
    case 'HOST_ALIAS_UNRESOLVED':
      return <Badge variant="outline">Alias</Badge>;
    case 'PROVIDER_SERVICE_AMBIGUOUS':
      return <Badge variant="outline">Provider</Badge>;
    case 'ENDPOINT_MATCH_AMBIGUOUS':
      return <Badge variant="outline">Endpoint</Badge>;
    case 'METHOD_UNKNOWN':
    case 'PROVIDER_ENDPOINT_NOT_FOUND':
    case 'PATH_TEMPLATE_UNKNOWN':
      return <Badge variant="outline">Method/Path</Badge>;
    case 'ROUTE_FAMILY_DERIVATION_EMPTY':
    case 'ROUTE_TO_ENDPOINT_COMPOSITION_FAILED':
      return <Badge variant="outline">Route</Badge>;
    default:
      return <Badge variant="outline">Read Only</Badge>;
  }
}

export function FrontierApprovalList() {
  const { workspaceId } = useWorkspace();
  const [items, setItems] = useState<FrontierListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [reasonFilter, setReasonFilter] = useState<string>('all');
  const [sourceServiceFilter, setSourceServiceFilter] = useState<string>('all');
  const [selectedProofStateId, setSelectedProofStateId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FrontierDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [submittingPatch, setSubmittingPatch] = useState(false);

  const [aliasKey, setAliasKey] = useState('');
  const [aliasValue, setAliasValue] = useState('');
  const [resolvedServiceId, setResolvedServiceId] = useState('');
  const [selectedServiceId, setSelectedServiceId] = useState('');
  const [endpointId, setEndpointId] = useState('');
  const [methodHint, setMethodHint] = useState('');
  const [externalPathHint, setExternalPathHint] = useState('');
  const [targetServiceHint, setTargetServiceHint] = useState('');
  const [targetHostAlias, setTargetHostAlias] = useState('');
  const [selectedPatchType, setSelectedPatchType] = useState<FrontierPatchType | ''>('');

  const loadFrontiers = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ workspaceId });
      if (reasonFilter !== 'all') query.set('reason', reasonFilter);
      if (sourceServiceFilter !== 'all') query.set('sourceServiceId', sourceServiceFilter);
      const res = await fetch(`/api/inference/frontiers?${query.toString()}`);
      if (!res.ok) throw new Error('frontier 목록을 불러오지 못했습니다.');
      const payload = (await res.json()) as FrontierListItem[];
      setItems(payload);
    } catch (error) {
      setItems([]);
      toast.error(error instanceof Error ? error.message : 'frontier 목록 조회 실패');
    } finally {
      setLoading(false);
    }
  }, [reasonFilter, sourceServiceFilter, workspaceId]);

  const loadDetail = useCallback(async (proofStateId: string) => {
    setDetailLoading(true);
    try {
      const res = await fetch(
        `/api/inference/frontiers/${encodeURIComponent(proofStateId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      if (!res.ok) throw new Error('frontier 상세를 불러오지 못했습니다.');
      const payload = (await res.json()) as FrontierDetail;
      setDetail(payload);
      setAliasKey('');
      setAliasValue('');
      setResolvedServiceId('');
      setSelectedServiceId('');
      setEndpointId('');
      setMethodHint('');
      setExternalPathHint('');
      setTargetServiceHint('');
      setTargetHostAlias('');
      setSelectedPatchType('');
    } catch (error) {
      setDetail(null);
      toast.error(error instanceof Error ? error.message : 'frontier 상세 조회 실패');
    } finally {
      setDetailLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadFrontiers();
  }, [loadFrontiers]);

  useEffect(() => {
    if (!selectedProofStateId) return;
    void loadDetail(selectedProofStateId);
  }, [loadDetail, selectedProofStateId]);

  const sourceServices = useMemo(
    () => [...new Map(items
      .filter((item) => item.sourceServiceId && item.sourceServiceName)
      .map((item) => [item.sourceServiceId!, item.sourceServiceName!])).entries()],
    [items],
  );

  const patchType = useMemo(() => {
    if (!detail) return null;
    if (selectedPatchType && detail.patchableActions.includes(selectedPatchType)) return selectedPatchType;
    const preferred = normalizeReasonToPatchType(detail.frontierReason);
    if (preferred && detail.patchableActions.includes(preferred)) return preferred;
    return detail.patchableActions[0] ?? null;
  }, [detail, selectedPatchType]);
  const canPatch = Boolean(detail && patchType);

  async function submitPatch() {
    if (!detail || !patchType) return;
    setSubmittingPatch(true);
    try {
      const proofStateId = detail.proofStateId;
      let payload: Record<string, unknown> = {};
      if (patchType === 'alias_binding') {
        payload = {
          aliasKey: aliasKey.trim(),
          aliasValue: aliasValue.trim(),
          ownerServiceId: detail.sourceServiceId,
          resolvedServiceId: resolvedServiceId.trim(),
        };
      } else if (patchType === 'provider_service_selection') {
        payload = { selectedServiceId: selectedServiceId.trim() };
      } else if (patchType === 'endpoint_disambiguation') {
        payload = { endpointId: endpointId.trim() };
      } else if (patchType === 'method_path_hint') {
        payload = {
          method: methodHint.trim().toUpperCase(),
          externalPath: externalPathHint.trim(),
        };
      } else if (patchType === 'route_transform_patch') {
        payload = {
          ownerServiceId: detail.sourceServiceId,
          gatewayKind: typeof detail.detail['gatewayKind'] === 'string' ? detail.detail['gatewayKind'] : '',
          matchPath: typeof detail.detail['externalRoutePattern'] === 'string'
            ? detail.detail['externalRoutePattern']
            : (detail.externalPathResolved ?? ''),
          targetServiceHint: targetServiceHint.trim(),
          targetHostAlias: targetHostAlias.trim(),
        };
      }

      const res = await fetch(`/api/inference/frontiers/${detail.proofStateId}/patch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          patchType,
          payload,
        }),
      });
      const body = (await res.json()) as {
        error?: string;
        validationStatus?: string;
        proofStatus?: string;
      };
      if (!res.ok) throw new Error(body.error ?? 'patch 적용 실패');

      if (body.validationStatus === 'REJECTED') {
        toast.warning('Patch가 거절되었습니다. 입력값을 확인하세요.');
      } else if (body.proofStatus === 'CLOSED_ATOMIC') {
        toast.success('Frontier를 승격했습니다. candidate로 이동했습니다.');
      } else {
        toast.warning('Patch를 적용했지만 아직 frontier 상태입니다.');
      }

      const promotedToCandidate = body.proofStatus === 'CLOSED_ATOMIC';
      if (promotedToCandidate) {
        setSelectedProofStateId(null);
        setDetail(null);
      }

      await loadFrontiers();
      if (!promotedToCandidate) {
        await loadDetail(proofStateId);
      }
      window.dispatchEvent(new CustomEvent('archi-navi:refresh-approval-candidates'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'patch 적용 실패');
    } finally {
      setSubmittingPatch(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="space-y-4 py-10">
        <EmptyStateGuide
          eyebrow="Frontiers"
          title="검토할 Frontier가 없습니다"
          description="추론 실행 후 unresolved proof가 있으면 이 탭에서 보정 및 재평가를 진행할 수 있습니다."
          actions={[
            { href: '/inference-runs', label: '추론 이력 보기' },
            { href: '/services', label: 'Object 목록 열기', variant: 'outline' },
          ]}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="frontier-reason-filter"
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={reasonFilter}
          onChange={(event) => setReasonFilter(event.target.value)}
        >
          <option value="all">모든 reason</option>
          {[...new Set(items.map((item) => item.frontierReason))].sort().map((reason) => (
            <option key={reason} value={reason}>{reason}</option>
          ))}
        </select>
        <select
          aria-label="frontier-source-filter"
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={sourceServiceFilter}
          onChange={(event) => setSourceServiceFilter(event.target.value)}
        >
          <option value="all">모든 source service</option>
          {sourceServices.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
        <Button variant="outline" onClick={() => void loadFrontiers()}>새로고침</Button>
      </div>

      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.proofStateId} data-testid="frontier-card" className="rounded-xl border border-border/70 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-1">
                <div className="text-sm font-semibold">{item.sourceServiceName ?? item.sourceServiceId ?? 'unknown service'}</div>
                <div className="text-xs text-muted-foreground">{item.intentType ?? 'unknown intent'} · {item.frontierReason}</div>
              </div>
              <div className="flex items-center gap-2">
                {renderReasonBadge(item.frontierReason)}
                <Badge variant="outline">priority {item.priority}</Badge>
                <Button size="sm" onClick={() => setSelectedProofStateId(item.proofStateId)}>보정</Button>
              </div>
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              provider {item.providerServiceName ?? '-'} · method {item.methodResolved ?? '-'} · path {item.externalPathResolved ?? item.internalPathResolved ?? '-'}
            </div>
          </div>
        ))}
      </div>

      <Sheet open={Boolean(selectedProofStateId)} onOpenChange={(open) => { if (!open) setSelectedProofStateId(null); }}>
        <SheetContent className="sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Frontier 보정</SheetTitle>
            <SheetDescription>
              frontier proof를 patch로 재평가하여 candidate 승격 여부를 확인합니다.
            </SheetDescription>
          </SheetHeader>

          {detailLoading || !detail ? (
            <div className="py-10 flex justify-center"><Spinner /></div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border border-border/70 p-3 text-sm">
                <div className="font-medium">{detail.frontierReason}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  source {detail.sourceServiceName ?? '-'} · provider {detail.providerServiceName ?? '-'} · status {detail.status}
                </div>
                <pre className="mt-2 overflow-auto rounded-md bg-muted p-2 text-[11px]">{JSON.stringify(detail.detail, null, 2)}</pre>
              </div>

              {canPatch ? (
                <div className="space-y-3 rounded-lg border border-border/70 p-3">
                  {detail.patchableActions.length > 1 && (
                    <label className="block text-xs">
                      patch type
                      <select
                        className="mt-1 w-full rounded border border-input px-2 py-1"
                        value={patchType ?? ''}
                        onChange={(event) => setSelectedPatchType(event.target.value as FrontierPatchType)}
                      >
                        {detail.patchableActions.map((action) => (
                          <option key={action} value={action}>{action}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {patchType === 'alias_binding' && (
                    <>
                      <label className="block text-xs">
                        aliasKey
                        <input className="mt-1 w-full rounded border border-input px-2 py-1" value={aliasKey} onChange={(event) => setAliasKey(event.target.value)} />
                      </label>
                      <label className="block text-xs">
                        aliasValue
                        <input className="mt-1 w-full rounded border border-input px-2 py-1" value={aliasValue} onChange={(event) => setAliasValue(event.target.value)} />
                      </label>
                      <label className="block text-xs">
                        resolvedService
                        <select className="mt-1 w-full rounded border border-input px-2 py-1" value={resolvedServiceId} onChange={(event) => setResolvedServiceId(event.target.value)}>
                          <option value="">선택하세요</option>
                          {detail.suggestedServices.map((service) => (
                            <option key={service.id} value={service.id}>{service.name}</option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}

                  {patchType === 'provider_service_selection' && (
                    <label className="block text-xs">
                      provider service
                      <select className="mt-1 w-full rounded border border-input px-2 py-1" value={selectedServiceId} onChange={(event) => setSelectedServiceId(event.target.value)}>
                        <option value="">선택하세요</option>
                        {detail.candidateServices.map((service) => (
                          <option key={service.id} value={service.id}>{service.name}</option>
                        ))}
                      </select>
                    </label>
                  )}

                  {patchType === 'endpoint_disambiguation' && (
                    <label className="block text-xs">
                      endpoint
                      <select className="mt-1 w-full rounded border border-input px-2 py-1" value={endpointId} onChange={(event) => setEndpointId(event.target.value)}>
                        <option value="">선택하세요</option>
                        {detail.candidateEndpoints.map((endpoint) => (
                          <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>
                        ))}
                      </select>
                    </label>
                  )}

                  {patchType === 'method_path_hint' && (
                    <>
                      <label className="block text-xs">
                        method
                        <input
                          className="mt-1 w-full rounded border border-input px-2 py-1"
                          placeholder="GET"
                          value={methodHint}
                          onChange={(event) => setMethodHint(event.target.value)}
                        />
                      </label>
                      <label className="block text-xs">
                        externalPath
                        <input
                          className="mt-1 w-full rounded border border-input px-2 py-1"
                          placeholder="/api/orders/{id}"
                          value={externalPathHint}
                          onChange={(event) => setExternalPathHint(event.target.value)}
                        />
                      </label>
                    </>
                  )}

                  {patchType === 'route_transform_patch' && (
                    <>
                      <label className="block text-xs">
                        targetServiceHint
                        <input
                          className="mt-1 w-full rounded border border-input px-2 py-1"
                          placeholder="orders-service"
                          value={targetServiceHint}
                          onChange={(event) => setTargetServiceHint(event.target.value)}
                        />
                      </label>
                      <label className="block text-xs">
                        targetHostAlias
                        <input
                          className="mt-1 w-full rounded border border-input px-2 py-1"
                          placeholder="orders.internal"
                          value={targetHostAlias}
                          onChange={(event) => setTargetHostAlias(event.target.value)}
                        />
                      </label>
                    </>
                  )}
                </div>
              ) : (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
                  현재 frontier reason은 1차 MVP patch form에서 지원하지 않습니다.
                </div>
              )}

              <div className="rounded-lg border border-border/70 p-3">
                <div className="text-sm font-medium">Recent proof steps</div>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {detail.recentProofSteps.slice(0, 8).map((step) => (
                    <li key={step.id}>#{step.stepOrder} {step.stepType} · {step.status} {step.message ? `· ${step.message}` : ''}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <SheetFooter>
            <Button variant="outline" onClick={() => setSelectedProofStateId(null)}>닫기</Button>
            <Button disabled={!canPatch || submittingPatch} onClick={() => void submitPatch()}>
              {submittingPatch ? '적용 중...' : 'Patch 적용'}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
