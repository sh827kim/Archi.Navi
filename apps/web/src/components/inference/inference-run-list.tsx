/**
 * 추론 실행 이력 목록 컴포넌트
 * inference_runs 조회 + cancel/retry 액션
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  CheckCircle, XCircle, Clock, Loader2, Ban,
  RotateCcw, RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button, Badge, Spinner } from '@archi-navi/ui';
import {
  listDashboardInferenceRuns,
  mutateDashboardInferenceRun,
  type DashboardInferenceRunItem,
} from '@/actions/inference-runs';
import { useWorkspace } from '@/contexts/workspace-context';

/** 상태별 아이콘/색상 */
function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'SUCCEEDED':
      return (
        <Badge className="bg-green-600/15 text-green-600 border-green-600/30 gap-1">
          <CheckCircle className="h-3 w-3" />
          성공
        </Badge>
      );
    case 'FAILED':
      return (
        <Badge className="bg-red-600/15 text-red-600 border-red-600/30 gap-1">
          <XCircle className="h-3 w-3" />
          실패
        </Badge>
      );
    case 'RUNNING':
      return (
        <Badge className="bg-blue-600/15 text-blue-600 border-blue-600/30 gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          실행 중
        </Badge>
      );
    case 'QUEUED':
      return (
        <Badge className="bg-yellow-600/15 text-yellow-600 border-yellow-600/30 gap-1">
          <Clock className="h-3 w-3" />
          대기
        </Badge>
      );
    case 'CANCELED':
      return (
        <Badge className="bg-gray-600/15 text-gray-500 border-gray-500/30 gap-1">
          <Ban className="h-3 w-3" />
          취소
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

/** 소요 시간 포맷 */
function formatDuration(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return '-';
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** 날짜 포맷 */
function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `오늘 ${time}`;
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' }) + ` ${time}`;
}

/** 소스 요약 */
function SourceSummary({ summary }: { summary: Record<string, number> }) {
  const entries = Object.entries(summary);
  if (entries.length === 0) return <span className="text-muted-foreground">-</span>;
  return (
    <span className="text-xs text-muted-foreground">
      {entries.map(([type, count]) => `${type} ${count}`).join(', ')}
    </span>
  );
}

/** stats에서 후보 수 추출 */
function extractCandidateCount(stats: Record<string, unknown>): number {
  const summary = stats['summary'] as Record<string, unknown> | undefined;
  if (summary && typeof summary['relationCandidatesCreated'] === 'number') {
    return summary['relationCandidatesCreated'];
  }
  return 0;
}

export function InferenceRunList() {
  const { workspaceId } = useWorkspace();
  const [runs, setRuns] = useState<DashboardInferenceRunItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionRunId, setActionRunId] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    try {
      const items = await listDashboardInferenceRuns({ workspaceId, limit: 30 });
      setRuns(items);
    } catch {
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const handleAction = async (runId: string, action: 'cancel' | 'retry') => {
    setActionRunId(runId);
    try {
      const data = await mutateDashboardInferenceRun({
        workspaceId,
        runId,
        action,
      }) as {
        canceled?: boolean;
        retried?: boolean;
        reason?: string;
        status?: string;
      };

      if (action === 'cancel') {
        if (data.canceled) {
          toast.success('실행이 취소되었습니다.');
        } else {
          toast.warning(`취소 불가 — 현재 상태: ${data.status ?? 'unknown'}`);
        }
      } else {
        if (data.retried) {
          toast.success('재시도가 예약되었습니다.');
        } else {
          toast.warning(data.reason ?? '재시도 불가');
        }
      }
      await loadRuns();
    } catch {
      toast.error(`${action === 'cancel' ? '취소' : '재시도'} 처리 실패`);
    } finally {
      setActionRunId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
        <Clock className="h-8 w-8" />
        <p className="text-sm font-medium">추론 실행 이력이 없습니다</p>
        <p className="text-xs">승인 대기 페이지에서 추론을 실행하면 여기에 표시됩니다</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* 새로고침 버튼 */}
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={() => void loadRuns()}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          새로고침
        </Button>
      </div>

      {/* 실행 목록 */}
      {runs.map((run) => {
        const candidateCount = extractCandidateCount(run.stats);
        const isActionable = run.status === 'RUNNING' || run.status === 'QUEUED' || run.status === 'FAILED';
        const isActing = actionRunId === run.id;

        return (
          <div
            key={run.id}
            className="rounded-xl p-4 transition-all glass-card space-y-2"
          >
            {/* 상단: 상태 + 모드 + 시간 */}
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 flex-wrap">
                <StatusBadge status={run.status} />
                <div className="flex gap-1">
                  {run.requestedModes.map((mode) => (
                    <Badge key={mode} variant="outline" className="text-xs">
                      {mode}
                    </Badge>
                  ))}
                </div>
                {run.requestedCodeEngine && (
                  <span className="text-xs text-muted-foreground">
                    엔진: {run.requestedCodeEngine}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <div className="text-right text-xs text-muted-foreground">
                  <div>{formatDate(run.createdAt)}</div>
                  <div>{formatDuration(run.startedAt, run.finishedAt)}</div>
                </div>

                {/* 액션 버튼 */}
                {isActionable && (
                  <div className="flex gap-1">
                    {(run.status === 'RUNNING' || run.status === 'QUEUED') && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isActing}
                        onClick={() => void handleAction(run.id, 'cancel')}
                        className="text-destructive hover:bg-destructive/10"
                      >
                        <Ban className="h-3.5 w-3.5 mr-1" />
                        취소
                      </Button>
                    )}
                    {run.status === 'FAILED' && run.attemptCount < run.maxAttempts && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isActing}
                        onClick={() => void handleAction(run.id, 'retry')}
                      >
                        <RotateCcw className="h-3.5 w-3.5 mr-1" />
                        재시도
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* 하단: 결과 요약 */}
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <SourceSummary summary={run.sourceSummary as Record<string, number>} />
              {run.status === 'SUCCEEDED' && candidateCount > 0 && (
                <span className="text-green-600">후보 {candidateCount}개 생성</span>
              )}
              {run.attemptCount > 1 && (
                <span>시도 {run.attemptCount}/{run.maxAttempts}</span>
              )}
              {run.triggerType !== 'MANUAL' && (
                <Badge variant="outline" className="text-xs">{run.triggerType}</Badge>
              )}
            </div>

            {/* 에러 메시지 */}
            {run.errorMessage && (
              <div className="text-xs text-red-500 bg-red-500/5 rounded-lg px-3 py-2 mt-1">
                {run.errorMessage}
              </div>
            )}

            {/* 경고 */}
            {run.warnings.length > 0 && (
              <div className="text-xs text-yellow-600 bg-yellow-500/5 rounded-lg px-3 py-2 mt-1">
                {run.warnings.slice(0, 2).map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
                {run.warnings.length > 2 && (
                  <div className="text-muted-foreground">+{run.warnings.length - 2}건 추가 경고</div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
