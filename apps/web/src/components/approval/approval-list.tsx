/**
 * 승인 대기 목록 컴포넌트
 * PENDING 상태의 relation_candidates를 조회하고 승인/거부 처리
 * 글래스 카드 스타일
 */
'use client';

import { useEffect, useState, useTransition, useCallback } from 'react';
import { Check, X, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button, Badge, Spinner, ConfirmDialog } from '@archi-navi/ui';
import { useWorkspace } from '@/contexts/workspace-context';

/** 후보 관계 타입 */
interface RelationCandidate {
  id: string;
  subjectName: string;
  relationType: string;
  objectName: string;
  confidence: number;
  source: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
}

const CODE_ENGINE_LS_KEY = 'archi-navi:inference:code-engine';

function resolveCodeEngine(): 'hybrid' | 'ast' | 'regex' {
  if (typeof window === 'undefined') return 'hybrid';
  const saved = localStorage.getItem(CODE_ENGINE_LS_KEY);
  if (saved === 'regex') return 'regex';
  if (saved === 'ast' || saved === 'auto') return 'ast';
  return 'hybrid';
}

export function ApprovalList() {
  const { workspaceId } = useWorkspace();
  const [candidates, setCandidates] = useState<RelationCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningInference, setRunningInference] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [rejectTarget, setRejectTarget] = useState<RelationCandidate | null>(null);

  const loadCandidates = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/inference/candidates?workspaceId=${workspaceId}&status=PENDING`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as RelationCandidate[];
      setCandidates(data);
    } catch {
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadCandidates();
  }, [loadCandidates]);

  const runInference = async () => {
    setRunningInference(true);
    try {
      const res = await fetch('/api/inference/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          modes: ['config', 'code', 'db'],
          useServiceMetadataPaths: true,
          codeEngine: resolveCodeEngine(),
        }),
      });
      const payload = (await res.json()) as {
        error?: string;
        summary?: { relationCandidatesCreated?: number };
        results?: {
          config?: { processedFileCount?: number };
          code?: { signalCount?: number };
        };
        warnings?: string[];
      };
      if (!res.ok) throw new Error(payload.error ?? '추론 실행 실패');

      const created = payload.summary?.relationCandidatesCreated ?? 0;
      if (created > 0) {
        toast.success(`추론 실행 완료 — 관계 후보 ${created}개 생성`);
      } else {
        const codeSignals = payload.results?.code?.signalCount ?? 0;
        const processedConfigFiles = payload.results?.config?.processedFileCount ?? 0;
        const primaryWarning = payload.warnings?.[0];

        if (primaryWarning) {
          toast.warning(`후보 0개 — ${primaryWarning}`);
        } else if (codeSignals > 0) {
          toast.warning(
            `후보 0개 — 코드 시그널 ${codeSignals}개 추출됨 (관계 후보 생성은 config/db 결과 기준)`,
          );
        } else if (processedConfigFiles === 0) {
          toast.warning('후보 0개 — 처리된 설정 파일이 없습니다. repoRoot/scanPath를 확인하세요.');
        } else {
          toast.warning('추론 실행 완료 — 신규 관계 후보가 생성되지 않았습니다.');
        }
      }
      await loadCandidates();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '추론 실행 실패');
    } finally {
      setRunningInference(false);
    }
  };

  function handleAction(id: string, action: 'APPROVED' | 'REJECTED') {
    startTransition(async () => {
      try {
        await fetch(`/api/inference/candidates/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: action }),
        });
        setCandidates((prev) => prev.filter((c) => c.id !== id));
        toast.success(action === 'APPROVED' ? '관계 승인됨' : '관계 거부됨');
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
        <Check className="h-8 w-8 text-green-500" />
        <p className="text-sm font-medium">승인 대기 중인 관계가 없습니다</p>
        <p className="text-xs">
          먼저 코드 스캔으로 서비스 경로를 등록한 뒤, 아래 추론 실행으로 후보를 생성하세요
        </p>
        <Button
          onClick={() => void runInference()}
          disabled={runningInference}
          className="mt-2"
        >
          <Sparkles className="h-3.5 w-3.5 mr-1.5" />
          {runningInference ? '추론 실행 중...' : '추론 실행'}
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button
          variant="outline"
          onClick={() => void runInference()}
          disabled={runningInference}
        >
          <Sparkles className="h-3.5 w-3.5 mr-1.5" />
          {runningInference ? '추론 실행 중...' : '추론 실행'}
        </Button>
      </div>

      <div className="space-y-2">
        {candidates.map((cand) => (
          <div
            key={cand.id}
            className="flex items-center justify-between rounded-xl p-4 transition-all glass-card"
          >
            {/* 관계 정보 */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-medium text-foreground">{cand.subjectName}</span>
              <Badge variant="outline">{cand.relationType}</Badge>
              <span className="font-medium text-foreground">{cand.objectName}</span>
            </div>

            {/* 메타 + 액션 */}
            <div className="flex items-center gap-4">
              <div className="text-right">
                <div className="text-xs text-muted-foreground">신뢰도</div>
                <div className="text-sm font-medium text-foreground">
                  {Math.round(cand.confidence * 100)}%
                </div>
              </div>

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
        ))}
      </div>

      {/* 거부 확인 다이얼로그 */}
      <ConfirmDialog
        open={!!rejectTarget}
        onOpenChange={(open) => { if (!open) setRejectTarget(null); }}
        title="관계 거부"
        description={`"${rejectTarget?.subjectName} → ${rejectTarget?.objectName}" 관계를 거부하시겠습니까?`}
        confirmLabel="거부"
        destructive
        onConfirm={() => {
          if (rejectTarget) handleAction(rejectTarget.id, 'REJECTED');
        }}
      />
    </>
  );
}
