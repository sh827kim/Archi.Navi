'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { toast } from 'sonner';
import { Badge, Button, Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, Spinner } from '@archi-navi/ui';
import { useWorkspace } from '@/contexts/workspace-context';
import { EmptyStateGuide } from '@/components/shared/empty-state-guide';
import { getClientAiRequestHeaders } from '@/lib/client-ai-settings';

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
  gatewayKind?: string | null;
  externalRoutePattern?: string | null;
  methodResolved: string | null;
  externalPathResolved: string | null;
  internalPathResolved: string | null;
  confidence: number;
  latestPatch?: {
    id: string;
    patchType: string;
    validationStatus: string;
    sourceKind: string;
    createdAt: string;
  } | null;
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

type FrontierApplyMode = 'apply' | 'defer';

interface TypeDisplayMeta {
  label: string;
  description: string;
}

const FRONTIER_REASON_META: Record<string, TypeDisplayMeta> = {
  CONFIG_BINDING_MISSING: {
    label: '설정 바인딩 누락',
    description: '설정 키나 환경 변수는 보였지만 어느 서비스 별칭인지 확정하지 못한 상태입니다.',
  },
  HOST_ALIAS_UNRESOLVED: {
    label: '호스트 별칭 미해결',
    description: '호스트나 base URL alias가 실제 서비스로 연결되지 않은 상태입니다.',
  },
  PATH_ONLY_TARGET_UNRESOLVED: {
    label: '경로 기반 대상 미해결',
    description: '경로 힌트만 있고 호출 대상 서비스를 확정할 alias나 provider 단서가 부족한 상태입니다.',
  },
  PROVIDER_SERVICE_AMBIGUOUS: {
    label: '제공 서비스 모호',
    description: '후보 서비스가 여러 개라 호출 대상 서비스를 하나로 확정해야 합니다.',
  },
  ENDPOINT_MATCH_AMBIGUOUS: {
    label: '엔드포인트 모호',
    description: '같은 서비스 안에서 연결 가능한 엔드포인트 후보가 여러 개인 상태입니다.',
  },
  METHOD_UNKNOWN: {
    label: '메서드 미확정',
    description: 'HTTP method 힌트가 부족해 엔드포인트 매칭을 완료하지 못한 상태입니다.',
  },
  PROVIDER_ENDPOINT_NOT_FOUND: {
    label: '제공 엔드포인트 없음',
    description: '대상 서비스는 추정했지만 대응되는 endpoint 객체를 찾지 못한 상태입니다.',
  },
  PATH_TEMPLATE_UNKNOWN: {
    label: '경로 템플릿 미확정',
    description: '외부 경로와 내부 endpoint path template을 안정적으로 맞추지 못한 상태입니다.',
  },
  ROUTE_FAMILY_DERIVATION_EMPTY: {
    label: '라우트 파생 실패',
    description: '게이트웨이 라우트에서 대상 서비스나 내부 경로를 파생하지 못한 상태입니다.',
  },
  ROUTE_TO_ENDPOINT_COMPOSITION_FAILED: {
    label: '라우트-엔드포인트 조합 실패',
    description: '게이트웨이 라우트와 서비스 endpoint를 합성해 proof를 닫지 못한 상태입니다.',
  },
  PATH_REWRITE_CONFLICT: {
    label: '경로 재작성 충돌',
    description: '게이트웨이 경로 재작성 규칙이 충돌해 내부 endpoint 경로를 확정하지 못한 상태입니다.',
  },
  PROVIDER_ENDPOINT_INDEX_EMPTY: {
    label: '제공 엔드포인트 색인 없음',
    description: '대상 서비스의 endpoint 색인이 비어 있어 매칭을 진행하지 못한 상태입니다.',
  },
  DB_ACTION_UNKNOWN: {
    label: 'DB 동작 미확정',
    description: 'DB 접근 intent가 읽기/쓰기 중 어떤 동작인지 확정하지 못한 상태입니다.',
  },
  DB_SCHEMA_AMBIGUOUS: {
    label: 'DB 스키마 모호',
    description: '같은 테이블명이 여러 스키마에 있어 대상 DB 테이블을 하나로 확정해야 합니다.',
  },
  DB_TABLE_UNRESOLVED: {
    label: 'DB 테이블 미해결',
    description: 'DB 테이블 힌트와 일치하는 대상 테이블을 찾지 못한 상태입니다.',
  },
  TABLE_MATCH_AMBIGUOUS: {
    label: '테이블 매칭 모호',
    description: 'DB 테이블 후보가 여러 개라 실제 접근 대상을 하나로 확정해야 합니다.',
  },
  MESSAGE_TARGET_UNRESOLVED: {
    label: '메시지 대상 미해결',
    description: '메시지 topic/queue 힌트가 부족하거나 대상 채널을 찾지 못한 상태입니다.',
  },
  TOPIC_MATCH_AMBIGUOUS: {
    label: '토픽 매칭 모호',
    description: '메시지 topic/queue 후보가 여러 개라 실제 채널을 하나로 확정해야 합니다.',
  },
  SMART_CONTRADICTION_CHALLENGED: {
    label: 'Smart 모순 재검토',
    description: 'Smart 재검토가 닫힌 proof의 근거를 다시 확인하도록 frontier로 되돌린 상태입니다.',
  },
  LOW_CONFIDENCE_CLOSED_ATOMIC: {
    label: '낮은 신뢰도 닫힘',
    description: '닫힌 proof의 신뢰도가 낮아 Smart 재검토 대상이 된 상태입니다.',
  },
};

const INTENT_TYPE_META: Record<string, TypeDisplayMeta> = {
  http_call: {
    label: 'HTTP 호출',
    description: '서비스 코드에서 다른 서비스의 HTTP endpoint를 호출하는 의도입니다.',
  },
  HTTP_CLIENT: {
    label: 'HTTP 호출',
    description: '서비스 코드에서 다른 서비스의 HTTP endpoint를 호출하는 의도입니다.',
  },
  http_gateway_route: {
    label: '게이트웨이 라우트',
    description: '게이트웨이 route 설정이 내부 서비스 endpoint로 이어지는 의도입니다.',
  },
  db_access: {
    label: 'DB 접근',
    description: '서비스 코드가 DB table이나 schema에 접근하는 의도입니다.',
  },
  message_publish: {
    label: '메시지 발행',
    description: '서비스가 queue/topic으로 메시지를 발행하는 의도입니다.',
  },
  message_consume: {
    label: '메시지 소비',
    description: '서비스가 queue/topic 메시지를 소비하는 의도입니다.',
  },
};

const FRONTIER_CLASS_META: Record<string, TypeDisplayMeta> = {
  ALIAS: {
    label: '별칭 해소',
    description: '설정 키, host alias, service discovery 이름을 실제 서비스와 연결해야 하는 frontier입니다.',
  },
  ROUTE: {
    label: '라우트 해소',
    description: '게이트웨이 route가 내부 서비스 endpoint로 이어지는 경로 변환을 보정해야 하는 frontier입니다.',
  },
  PATH: {
    label: '경로 해소',
    description: 'path template 또는 route scope를 확정해야 하는 frontier입니다.',
  },
  METHOD: {
    label: '메서드 해소',
    description: 'HTTP method 힌트를 확정해야 하는 frontier입니다.',
  },
  METHOD_PATH: {
    label: '메서드/경로 해소',
    description: 'HTTP method와 path 힌트를 함께 보정해야 하는 frontier입니다.',
  },
  TARGET: {
    label: '대상 해소',
    description: '호출 대상, 엔드포인트, alias처럼 proof의 대상 식별을 보정해야 하는 frontier입니다.',
  },
  SUMMARY: {
    label: '요약 보강',
    description: '함수 요약이나 신호 추출 결과를 보강해야 proof를 닫을 수 있는 frontier입니다.',
  },
  CONTRADICTION: {
    label: '모순 검토',
    description: '닫힌 proof의 근거가 약하거나 상충되어 다시 frontier로 열어야 하는지 검토하는 유형입니다.',
  },
  UNSUPPORTED: {
    label: '미지원 유형',
    description: '현재 UI에서 직접 보정할 수 없는 frontier 유형입니다.',
  },
};

const PATCH_TYPE_META: Record<string, TypeDisplayMeta> = {
  alias_binding: {
    label: '별칭 연결',
    description: '설정 키, base URL, host alias를 실제 서비스에 연결합니다.',
  },
  provider_service_selection: {
    label: '제공 서비스 선택',
    description: '여러 후보 중 실제 호출 대상 서비스를 선택합니다.',
  },
  endpoint_disambiguation: {
    label: '엔드포인트 선택',
    description: '여러 endpoint 후보 중 실제 호출 endpoint를 선택합니다.',
  },
  method_path_hint: {
    label: '메서드/경로 보정',
    description: '부족한 HTTP method 또는 path 힌트를 보정합니다.',
  },
  route_transform_patch: {
    label: '라우트 변환',
    description: '게이트웨이 route가 내부 서비스 endpoint로 이어지는 변환 정보를 보정합니다.',
  },
  function_summary_patch: {
    label: '함수 요약 보강',
    description: '함수 요약의 outbound HTTP/DB/message 신호를 보강해 proof 해소에 사용합니다.',
  },
  contradiction_challenge: {
    label: '모순 재검토',
    description: '닫힌 proof가 약하거나 상충될 때 다시 frontier로 열도록 요청합니다.',
  },
  reject_patch: {
    label: '재분류 반려',
    description: '제안된 patch를 적용하지 않고 반려한 기록입니다.',
  },
};

const VALIDATION_STATUS_META: Record<string, TypeDisplayMeta> = {
  PENDING: {
    label: '보류',
    description: 'patch를 저장했지만 아직 proof 재평가에 적용하지 않은 상태입니다.',
  },
  ACCEPTED: {
    label: '재분류 적용',
    description: 'patch 검증을 통과해 frontier proof 재평가에 적용된 상태입니다.',
  },
  REJECTED: {
    label: '재분류 거절',
    description: 'patch 검증을 통과하지 못해 proof에 적용되지 않은 상태입니다.',
  },
};

function getMeta(meta: Record<string, TypeDisplayMeta>, code: string | null | undefined, fallbackLabel = '알 수 없음'): TypeDisplayMeta {
  if (!code) return { label: fallbackLabel, description: '타입 정보가 없습니다.' };
  return meta[code] ?? {
    label: code,
    description: '아직 한글 설명이 등록되지 않은 타입입니다.',
  };
}

function TypeLabel({ meta }: { meta: TypeDisplayMeta }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span>{meta.label}</span>
      <Info
        aria-label={`${meta.label} 설명`}
        className="h-3.5 w-3.5 text-muted-foreground"
        title={meta.description}
      />
    </span>
  );
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
  return <Badge variant="outline"><TypeLabel meta={getMeta(FRONTIER_REASON_META, reason)} /></Badge>;
}

function renderLatestPatchBadge(latestPatch: FrontierListItem['latestPatch']) {
  if (!latestPatch) return null;
  const statusMeta = getMeta(VALIDATION_STATUS_META, latestPatch.validationStatus);
  const patchMeta = getMeta(PATCH_TYPE_META, latestPatch.patchType, 'patch');
  return <Badge variant="outline">{patchMeta.label} · <TypeLabel meta={statusMeta} /></Badge>;
}

function formatReclassificationCounts(counts: Record<string, number> | undefined, fallbackCount: number): string {
  const entries = Object.entries(counts ?? {}).filter(([, count]) => count > 0);
  if (entries.length === 0) return fallbackCount > 0 ? `재분류 ${fallbackCount}` : '재분류 0';
  const typedCount = entries.reduce((sum, [, count]) => sum + count, 0);
  const untypedCount = Math.max(fallbackCount - typedCount, 0);
  const typedSummary = entries
    .map(([patchType, count]) => `${getMeta(PATCH_TYPE_META, patchType, '재분류').label} ${count}`)
    .join(', ');
  return `재분류: ${[
    typedSummary,
    ...(untypedCount > 0 ? [`유형 미확인 ${untypedCount}`] : []),
  ].join(', ')}`;
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
  const [reviewingSmartIds, setReviewingSmartIds] = useState<string[]>([]);
  const [reviewingSmartBulk, setReviewingSmartBulk] = useState(false);
  const [selectedSmartProofStateIds, setSelectedSmartProofStateIds] = useState<string[]>([]);

  const loadFrontiers = useCallback(async () => {
    if (!workspaceId) {
      setItems([]);
      setLoading(false);
      return;
    }
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
    if (!workspaceId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
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
    const selectableIds = new Set(
      items
        .filter((item) => item.frontierReason === 'PROVIDER_SERVICE_AMBIGUOUS')
        .map((item) => item.proofStateId),
    );
    setSelectedSmartProofStateIds((prev) => prev.filter((id) => selectableIds.has(id)));
  }, [items]);

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

  async function submitPatch(applyMode: FrontierApplyMode) {
    if (!detail || !patchType || !workspaceId) return;
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
        const matchPath = detail.externalRoutePattern
          ?? (typeof detail.detail['externalRoutePattern'] === 'string'
            ? detail.detail['externalRoutePattern']
            : detail.externalPathResolved);
        payload = {
          ownerServiceId: detail.sourceServiceId,
          gatewayKind: detail.gatewayKind ?? '',
          matchPath: matchPath ?? '',
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
          applyMode,
        }),
      });
      const body = (await res.json()) as {
        error?: string;
        validationStatus?: string;
        proofStatus?: string;
      };
      if (!res.ok) throw new Error(body.error ?? 'patch 적용 실패');

      if (body.validationStatus === 'PENDING') {
        toast.success('Patch를 보류로 저장했습니다. 수동 검토 대기 상태입니다.');
      } else if (body.validationStatus === 'REJECTED') {
        toast.warning('Patch가 거절되었습니다. 입력값을 확인하세요.');
      } else if (body.proofStatus === 'CLOSED_ATOMIC') {
        toast.success('Frontier를 승격했습니다. candidate로 이동했습니다.');
      } else {
        toast.warning('Patch를 적용했지만 아직 frontier 상태입니다.');
      }

      const promotedToCandidate = body.validationStatus !== 'PENDING' && body.proofStatus === 'CLOSED_ATOMIC';
      if (promotedToCandidate) {
        setSelectedProofStateId(null);
        setDetail(null);
      }

      await loadFrontiers();
      if (!promotedToCandidate) {
        await loadDetail(proofStateId);
      }
      if (body.validationStatus !== 'PENDING') {
        window.dispatchEvent(new CustomEvent('archi-navi:refresh-approval-candidates'));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'patch 적용 실패');
    } finally {
      setSubmittingPatch(false);
    }
  }

  async function runSmartReview(proofStateIds: string[]) {
    if (!workspaceId) return;
    const targetIds = [...new Set(proofStateIds)];
    if (targetIds.length === 0) return;
    const isBulk = targetIds.length > 1;
    if (isBulk) {
      setReviewingSmartBulk(true);
    } else {
      setReviewingSmartIds((prev) => [...new Set([...prev, ...targetIds])]);
    }

    try {
      const aiHeaders = getClientAiRequestHeaders();
      const res = await fetch('/api/inference/frontiers/smart-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...aiHeaders },
        body: JSON.stringify({
          workspaceId,
          ...(targetIds.length === 1 ? { proofStateId: targetIds[0] } : { proofStateIds: targetIds }),
          smartProof: {
            categories: {
              ambiguityResolution: true,
            },
          },
        }),
      });
      const payload = (await res.json()) as {
        success?: boolean;
        error?: { message?: string };
        summary?: {
          acceptedCount?: number;
          reclassifiedCount?: number;
          promotedCount?: number;
          pendingCount?: number;
          skippedCount?: number;
          reclassificationCounts?: Record<string, number>;
        };
        remainingProofStateIds?: string[];
      };
      if (!res.ok || payload.success !== true) {
        throw new Error(payload.error?.message ?? 'Smart 재검토 실행 실패');
      }

      const reclassified = payload.summary?.reclassifiedCount ?? payload.summary?.acceptedCount ?? 0;
      const promoted = payload.summary?.promotedCount ?? 0;
      const pending = payload.summary?.pendingCount ?? 0;
      const skipped = payload.summary?.skippedCount ?? 0;
      const reclassificationSummary = formatReclassificationCounts(
        payload.summary?.reclassificationCounts,
        reclassified,
      );
      toast.success(`Smart 재검토 완료 (${reclassificationSummary}, 후보 승격 ${promoted}, 보류 ${pending}, 건너뜀 ${skipped})`);

      await loadFrontiers();
      if (selectedProofStateId && targetIds.includes(selectedProofStateId)) {
        const stillFrontier = payload.remainingProofStateIds?.includes(selectedProofStateId) ?? false;
        if (stillFrontier) {
          await loadDetail(selectedProofStateId);
        } else {
          setSelectedProofStateId(null);
          setDetail(null);
        }
      }
      setSelectedSmartProofStateIds((prev) => prev.filter((id) => payload.remainingProofStateIds?.includes(id)));
      window.dispatchEvent(new CustomEvent('archi-navi:refresh-approval-candidates'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Smart 재검토 실행 실패');
    } finally {
      if (isBulk) {
        setReviewingSmartBulk(false);
      } else {
        setReviewingSmartIds((prev) => prev.filter((id) => !targetIds.includes(id)));
      }
    }
  }

  const smartReviewTargetItems = useMemo(
    () => items.filter((item) => item.frontierReason === 'PROVIDER_SERVICE_AMBIGUOUS'),
    [items],
  );
  const allSmartSelected = smartReviewTargetItems.length > 0
    && smartReviewTargetItems.every((item) => selectedSmartProofStateIds.includes(item.proofStateId));
  const isSelectedSmartReviewInFlight = selectedSmartProofStateIds
    .some((proofStateId) => reviewingSmartIds.includes(proofStateId));
  const canRunBulkSmartReview = selectedSmartProofStateIds.length > 0
    && !reviewingSmartBulk
    && !isSelectedSmartReviewInFlight;

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
          <option value="all">모든 유형</option>
          {[...new Set(items.map((item) => item.frontierReason))].sort().map((reason) => (
            <option key={reason} value={reason}>{getMeta(FRONTIER_REASON_META, reason).label}</option>
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
        {smartReviewTargetItems.length > 0 && (
          <>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={allSmartSelected}
                onChange={(event) => {
                  if (event.target.checked) {
                    setSelectedSmartProofStateIds(smartReviewTargetItems.map((item) => item.proofStateId));
                  } else {
                    setSelectedSmartProofStateIds([]);
                  }
                }}
              />
              Smart 대상 전체 선택
            </label>
            <Button
              variant="outline"
              disabled={!canRunBulkSmartReview}
              onClick={() => void runSmartReview(selectedSmartProofStateIds)}
            >
              {reviewingSmartBulk ? '선택 항목 재검토 중...' : `선택 항목 Smart 재검토 (${selectedSmartProofStateIds.length})`}
            </Button>
          </>
        )}
      </div>

      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.proofStateId} data-testid="frontier-card" className="rounded-xl border border-border/70 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-1">
                <div className="text-sm font-semibold">{item.sourceServiceName ?? item.sourceServiceId ?? 'unknown service'}</div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <TypeLabel meta={getMeta(INTENT_TYPE_META, item.intentType, '알 수 없는 의도')} />
                  <span>·</span>
                  <TypeLabel meta={getMeta(FRONTIER_CLASS_META, item.frontierClass, '알 수 없는 frontier')} />
                </div>
              </div>
              <div className="flex items-center gap-2">
                {renderReasonBadge(item.frontierReason)}
                {renderLatestPatchBadge(item.latestPatch ?? null)}
                <Badge variant="outline">priority {item.priority}</Badge>
                {item.frontierReason === 'PROVIDER_SERVICE_AMBIGUOUS' && (
                  <>
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={selectedSmartProofStateIds.includes(item.proofStateId)}
                        onChange={(event) => {
                          if (event.target.checked) {
                            setSelectedSmartProofStateIds((prev) => [...new Set([...prev, item.proofStateId])]);
                          } else {
                            setSelectedSmartProofStateIds((prev) => prev.filter((id) => id !== item.proofStateId));
                          }
                        }}
                      />
                      선택
                    </label>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={reviewingSmartBulk || reviewingSmartIds.includes(item.proofStateId)}
                      onClick={() => void runSmartReview([item.proofStateId])}
                    >
                      {reviewingSmartIds.includes(item.proofStateId) ? '재검토 중...' : 'Smart 재검토'}
                    </Button>
                  </>
                )}
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
                <div className="font-medium"><TypeLabel meta={getMeta(FRONTIER_REASON_META, detail.frontierReason)} /></div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>source {detail.sourceServiceName ?? '-'}</span>
                  <span>·</span>
                  <span>provider {detail.providerServiceName ?? '-'}</span>
                  <span>·</span>
                  <TypeLabel meta={getMeta(INTENT_TYPE_META, detail.intentType, '알 수 없는 의도')} />
                  <span>·</span>
                  <TypeLabel meta={getMeta(FRONTIER_CLASS_META, detail.frontierClass, '알 수 없는 frontier')} />
                </div>
                <pre className="mt-2 overflow-auto rounded-md bg-muted p-2 text-[11px]">{JSON.stringify(detail.detail, null, 2)}</pre>
              </div>

              {canPatch ? (
                <div className="space-y-3 rounded-lg border border-border/70 p-3">
                  {detail.patchableActions.length > 1 && (
                    <label className="block text-xs">
                      재분류 타입
                      <select
                        className="mt-1 w-full rounded border border-input px-2 py-1"
                        value={patchType ?? ''}
                        onChange={(event) => setSelectedPatchType(event.target.value as FrontierPatchType)}
                      >
                        {detail.patchableActions.map((action) => (
                          <option key={action} value={action}>{getMeta(PATCH_TYPE_META, action).label}</option>
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
            <Button variant="outline" disabled={!canPatch || submittingPatch} onClick={() => void submitPatch('defer')}>
              {submittingPatch ? '저장 중...' : '보류 저장'}
            </Button>
            {detail?.frontierReason === 'PROVIDER_SERVICE_AMBIGUOUS' && (
              <Button
                variant="outline"
                disabled={reviewingSmartBulk || reviewingSmartIds.includes(detail.proofStateId)}
                onClick={() => void runSmartReview([detail.proofStateId])}
              >
                {reviewingSmartIds.includes(detail.proofStateId) ? '재검토 중...' : 'Smart 재검토'}
              </Button>
            )}
            <Button disabled={!canPatch || submittingPatch} onClick={() => void submitPatch('apply')}>
              {submittingPatch ? '적용 중...' : 'Patch 적용'}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
