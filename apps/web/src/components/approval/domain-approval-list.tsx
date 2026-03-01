/**
 * 도메인 후보 승인 목록 컴포넌트
 * PENDING 상태의 domain_candidates를 조회하고 승인/거부 처리
 * 글래스 카드 스타일
 */
'use client';

import { useEffect, useState, useTransition } from 'react';
import { Check, X, Brain } from 'lucide-react';
import { toast } from 'sonner';
import { Button, Badge, Spinner, ConfirmDialog } from '@archi-navi/ui';

/** 도메인 후보 타입 */
interface DomainCandidate {
  id: string;
  objectId: string;
  objectName: string;
  primaryDomainId: string | null;
  primaryDomainName: string | null;
  purity: number;
  affinityMap: Record<string, number>;
  signals: unknown;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt: string;
}

/** affinity 상위 N개 항목 추출 (domainName 매핑 없이 domainId 표시) */
function getTopAffinities(
  affinityMap: Record<string, number>,
  limit = 3,
): { domainId: string; score: number }[] {
  return Object.entries(affinityMap)
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([domainId, score]) => ({ domainId, score }));
}

export function DomainApprovalList() {
  const [candidates, setCandidates] = useState<DomainCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [isPending, startTransition] = useTransition();
  const [rejectTarget, setRejectTarget] = useState<DomainCandidate | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const res = await fetch('/api/inference/domain-candidates?status=PENDING');
        if (!res.ok) throw new Error();
        const data = (await res.json()) as DomainCandidate[];
        setCandidates(data);
      } catch {
        setCandidates([]);
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  function handleAction(id: string, action: 'APPROVED' | 'REJECTED') {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/inference/domain-candidates/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: action }),
        });
        if (!res.ok) throw new Error(`서버 응답 오류: ${res.status}`);
        setCandidates((prev) => prev.filter((c) => c.id !== id));
        toast.success(action === 'APPROVED' ? '도메인 소속 승인됨' : '도메인 소속 거부됨');
        setRejectTarget(null);
      } catch {
        toast.error('처리 실패');
      }
    });
  }

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (candidates.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
        <Brain className="h-8 w-8 text-primary/60" />
        <p className="text-sm font-medium">승인 대기 중인 도메인 후보가 없습니다</p>
        <p className="text-xs">
          CLI에서 anavi infer 를 실행하면 새 도메인 후보가 생성됩니다
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2">
        {candidates.map((cand) => {
          const topAffinities = getTopAffinities(cand.affinityMap);
          return (
            <div
              key={cand.id}
              className="rounded-xl p-4 transition-all glass-card"
            >
              {/* 상단: 서비스명 + 주 도메인 + 순도 */}
              <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-medium text-foreground">{cand.objectName}</span>
                  {cand.primaryDomainName && (
                    <>
                      <span className="text-muted-foreground text-sm">→</span>
                      <Badge variant="outline">{cand.primaryDomainName}</Badge>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  {/* 순도 */}
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground">순도</div>
                    <div className="text-sm font-medium text-foreground">
                      {Math.round(cand.purity * 100)}%
                    </div>
                  </div>
                  {/* 액션 버튼 */}
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      onClick={() => handleAction(cand.id, 'APPROVED')}
                      disabled={isPending}
                      className="bg-green-600 hover:bg-green-700 text-white"
                    >
                      <Check className="h-3.5 w-3.5 mr-1" />
                      승인
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setRejectTarget(cand)}
                      disabled={isPending}
                      className="text-destructive hover:bg-destructive/10"
                    >
                      <X className="h-3.5 w-3.5 mr-1" />
                      거부
                    </Button>
                  </div>
                </div>
              </div>

              {/* 하단: Affinity 분포 미니 바 */}
              {topAffinities.length > 0 && (
                <div className="space-y-1">
                  {topAffinities.map(({ domainId, score }) => (
                    <div key={domainId} className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground w-32 truncate">{domainId}</span>
                      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-primary/70"
                          style={{ width: `${Math.round(score * 100)}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground w-8 text-right">
                        {Math.round(score * 100)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 거부 확인 다이얼로그 */}
      <ConfirmDialog
        open={!!rejectTarget}
        onOpenChange={(open) => { if (!open) setRejectTarget(null); }}
        title="도메인 소속 거부"
        description={`"${rejectTarget?.objectName}" 의 도메인 소속 추론 결과를 거부하시겠습니까?`}
        confirmLabel="거부"
        destructive
        onConfirm={() => {
          if (rejectTarget) handleAction(rejectTarget.id, 'REJECTED');
        }}
      />
    </>
  );
}
