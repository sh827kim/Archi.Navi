/**
 * 도메인 발견 섹션 — Phase 1 트리거 + 후보 미리보기 카드
 *
 * UX 패턴:
 *  - 우측 [도메인 발견] 버튼 → POST /api/domains/discover
 *  - 응답 후보를 카드로 미리보기 (in-memory, 새로고침 시 사라짐)
 *  - 각 카드: 인라인 이름 편집, coherent 칩 (녹색/빨강), 강한 신호 칩 3개
 *           멤버 5개 미리보기 + "+N more" 토글, [승인] [거부]
 *  - 상단 일괄 액션: [coherent 만 모두 승인] / [전체 거부] / [재발견]
 *  - 승인 시 POST /api/domains/approve → 부모(loadDomains) 콜백으로 목록 갱신
 *
 * primary/secondary 분리:
 *  - 승인 payload 의 primaryMembers 는 후보 자기 자신을 primary 로 가지는 멤버
 *  - 후보 객체 내 모든 멤버는 오케스트레이터에서 primary/secondary 가 정해진 상태로 옴 (affinity ≥ 0.5 만 secondary)
 *  - 단, 본 컴포넌트는 후보 단위로 동작하므로 primary 만 한 후보의 멤버로 취급. secondary 보존은 향후 개선.
 */
'use client';

import { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, Loader2, Search, XCircle } from 'lucide-react';
import { Badge, Button, Input } from '@archi-navi/ui';
import { toast } from 'sonner';
import { getClientAiRequestHeaders } from '@/lib/client-ai-settings';

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface CandidateMember {
  objectId: string;
  pathPrefixMatch: 0 | 1;
  routePrefixMatch: 0 | 1;
  topicPrefixMatch: 0 | 1;
  nameTokenJaccard: number;
  affinity: number;
  relationCohesion: number;
}

interface CandidateReview {
  coherent: boolean;
  suggestedName: string;
  responsibilityHint: string;
  mergeWithCandidateId: string | null;
}

interface DiscoveredCandidate {
  id: string;
  autoName: string;
  signals: {
    topPathPrefix: string | null;
    topRoutePrefix: string | null;
    topTopicPrefix: string | null;
  };
  members: CandidateMember[];
  review: CandidateReview | null;
}

interface DiscoverResponseData {
  candidates: DiscoveredCandidate[];
  llmReviewed: boolean;
}

interface Props {
  workspaceId: string;
  onApproved: () => void;
}

interface CardState {
  /** 사용자가 인라인 편집한 최종 이름 */
  name: string;
  /** "+N more" 토글 상태 */
  expanded: boolean;
  /** 승인/거부 진행 중 여부 */
  busy: boolean;
}

const PREVIEW_MEMBER_COUNT = 5;

export function DomainDiscoverSection({ workspaceId, onApproved }: Props) {
  const [discovering, setDiscovering] = useState(false);
  const [candidates, setCandidates] = useState<DiscoveredCandidate[]>([]);
  const [llmReviewed, setLlmReviewed] = useState(false);
  const [cardStates, setCardStates] = useState<Record<string, CardState>>({});
  const [bulkBusy, setBulkBusy] = useState(false);

  function initCardState(c: DiscoveredCandidate): CardState {
    return {
      name: c.review?.suggestedName ?? c.autoName,
      expanded: false,
      busy: false,
    };
  }

  function updateCard(id: string, patch: Partial<CardState>) {
    setCardStates((prev) => {
      const current = prev[id];
      if (!current) return prev;
      return { ...prev, [id]: { ...current, ...patch } };
    });
  }

  async function handleDiscover() {
    setDiscovering(true);
    try {
      const res = await fetch('/api/domains/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getClientAiRequestHeaders() },
        body: JSON.stringify({ workspaceId }),
      });
      const json = (await res.json()) as ApiEnvelope<DiscoverResponseData>;
      if (!json.success || !json.data) {
        toast.error(json.error?.message ?? '도메인 발견 실패');
        return;
      }
      setCandidates(json.data.candidates);
      setLlmReviewed(json.data.llmReviewed);
      const states: Record<string, CardState> = {};
      for (const c of json.data.candidates) {
        states[c.id] = initCardState(c);
      }
      setCardStates(states);
      toast.success(
        `${json.data.candidates.length}개 후보를 찾았습니다.${json.data.llmReviewed ? ' (LLM 검토 포함)' : ''}`,
      );
    } catch (err) {
      console.error('[discover] error', err);
      toast.error('도메인 발견 중 오류가 발생했습니다.');
    } finally {
      setDiscovering(false);
    }
  }

  async function approveCandidate(c: DiscoveredCandidate): Promise<boolean> {
    const state = cardStates[c.id];
    if (!state) return false;
    const name = state.name.trim();
    if (!name) {
      toast.error('도메인 이름을 입력해주세요.');
      return false;
    }
    updateCard(c.id, { busy: true });
    try {
      const res = await fetch('/api/domains/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          name,
          primaryMembers: c.members.map((m) => ({
            objectId: m.objectId,
            affinity: m.affinity,
            confidence: m.relationCohesion,
          })),
          secondaryMembers: [],
        }),
      });
      const json = (await res.json()) as ApiEnvelope<{ domainId: string; memberCount: number }>;
      if (!json.success || !json.data) {
        toast.error(json.error?.message ?? '승인 실패');
        return false;
      }
      toast.success(`"${name}" 도메인 승인 (멤버 ${json.data.memberCount}개)`);
      // 미리보기에서 제거
      setCandidates((prev) => prev.filter((x) => x.id !== c.id));
      setCardStates((prev) => {
        const { [c.id]: _, ...rest } = prev;
        return rest;
      });
      return true;
    } catch (err) {
      console.error('[approve] error', err);
      toast.error('승인 중 오류가 발생했습니다.');
      return false;
    } finally {
      updateCard(c.id, { busy: false });
    }
  }

  function rejectCandidate(c: DiscoveredCandidate) {
    setCandidates((prev) => prev.filter((x) => x.id !== c.id));
    setCardStates((prev) => {
      const { [c.id]: _, ...rest } = prev;
      return rest;
    });
  }

  async function approveAllCoherent() {
    const coherent = candidates.filter((c) => c.review?.coherent === true);
    if (coherent.length === 0) {
      toast.info('coherent 인 후보가 없습니다.');
      return;
    }
    setBulkBusy(true);
    let approvedCount = 0;
    for (const c of coherent) {
      const ok = await approveCandidate(c);
      if (ok) {
        approvedCount += 1;
      }
    }
    setBulkBusy(false);
    if (approvedCount > 0) {
      onApproved();
    }
  }

  function rejectAll() {
    setCandidates([]);
    setCardStates({});
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Search className="h-4 w-4 text-primary" />
          도메인 발견
          {candidates.length > 0 ? <Badge variant="secondary">{candidates.length}</Badge> : null}
        </h2>
        <div className="flex items-center gap-2">
          {candidates.length > 0 ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={approveAllCoherent}
                disabled={bulkBusy || discovering}
              >
                coherent 모두 승인
              </Button>
              <Button size="sm" variant="ghost" onClick={rejectAll} disabled={bulkBusy || discovering}>
                전체 거부
              </Button>
            </>
          ) : null}
          <Button size="sm" onClick={handleDiscover} disabled={discovering || bulkBusy}>
            {discovering ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="mr-1.5 h-3.5 w-3.5" />
            )}
            {candidates.length > 0 ? '재발견' : '도메인 발견'}
          </Button>
        </div>
      </div>

      {candidates.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground">
          {discovering
            ? '결정적 신호 분석 중...'
            : '아직 발견된 후보가 없습니다. [도메인 발견] 을 눌러 결정적 클러스터링을 실행하세요. (LLM 키가 있으면 검토 단계가 자동 추가됩니다.)'}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {llmReviewed
              ? 'LLM 검토를 포함했습니다. coherent: 녹색 = 일관, 빨강 = 검토 필요.'
              : 'LLM 키 미설정 — 결정적 신호 기반 후보만 표시됩니다.'}
          </p>
          {candidates.map((c) => {
            const state = cardStates[c.id];
            if (!state) return null;
            const previewMembers = state.expanded
              ? c.members
              : c.members.slice(0, PREVIEW_MEMBER_COUNT);
            const hiddenCount = Math.max(0, c.members.length - PREVIEW_MEMBER_COUNT);

            return (
              <article
                key={c.id}
                className="rounded-lg border border-border bg-card p-4 shadow-sm"
              >
                {/* 카드 헤더 */}
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={state.name}
                    onChange={(e) => updateCard(c.id, { name: e.target.value })}
                    className="h-8 max-w-[260px] text-sm font-medium"
                    aria-label={`${c.id} 도메인 이름`}
                  />
                  {c.review ? (
                    c.review.coherent ? (
                      <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                        coherent
                      </Badge>
                    ) : (
                      <Badge className="bg-rose-500/15 text-rose-700 dark:text-rose-400">
                        검토 필요
                      </Badge>
                    )
                  ) : (
                    <Badge variant="outline" className="text-xs">
                      LLM 미검토
                    </Badge>
                  )}
                  {c.signals.topPathPrefix ? (
                    <Badge variant="outline" className="text-xs">
                      path: /{c.signals.topPathPrefix}
                    </Badge>
                  ) : null}
                  {c.signals.topRoutePrefix ? (
                    <Badge variant="outline" className="text-xs">
                      route: {c.signals.topRoutePrefix}
                    </Badge>
                  ) : null}
                  {c.signals.topTopicPrefix ? (
                    <Badge variant="outline" className="text-xs">
                      topic: {c.signals.topTopicPrefix}
                    </Badge>
                  ) : null}
                  <Badge variant="secondary" className="ml-auto text-xs">
                    멤버 {c.members.length}
                  </Badge>
                </div>

                {/* 본문 — LLM 책임 가설 + 멤버 미리보기 */}
                {c.review?.responsibilityHint ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {c.review.responsibilityHint}
                  </p>
                ) : null}

                <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                  {previewMembers.map((m) => (
                    <li key={m.objectId} className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono">{m.objectId}</span>
                      <span className="shrink-0">
                        affinity {m.affinity.toFixed(2)} · cohesion {m.relationCohesion.toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>
                {hiddenCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => updateCard(c.id, { expanded: !state.expanded })}
                    className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    {state.expanded ? (
                      <>
                        <ChevronUp className="h-3 w-3" /> 접기
                      </>
                    ) : (
                      <>
                        <ChevronDown className="h-3 w-3" /> +{hiddenCount} more
                      </>
                    )}
                  </button>
                ) : null}

                {/* 푸터 — 액션 */}
                <div className="mt-4 flex items-center justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => rejectCandidate(c)}
                    disabled={state.busy || bulkBusy}
                  >
                    <XCircle className="mr-1.5 h-3.5 w-3.5" />
                    거부
                  </Button>
                  <Button
                    size="sm"
                    onClick={async () => {
                      const ok = await approveCandidate(c);
                      if (ok) onApproved();
                    }}
                    disabled={state.busy || bulkBusy}
                  >
                    {state.busy ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    승인
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
