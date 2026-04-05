'use client';

import Link from 'next/link';
import { startTransition, useEffect, useState } from 'react';
import { Activity, ArrowRight, CheckCircle2, GitGraph, LayoutGrid, SearchCode, Server } from 'lucide-react';
import { Button, cn, Spinner } from '@archi-navi/ui';
import { useWorkspace } from '@/contexts/workspace-context';
import { EmptyStateGuide } from '@/components/shared/empty-state-guide';

interface DashboardSummary {
  counts: {
    objects: number;
    services: number;
    domains: number;
    pendingRelations: number;
    pendingDomains: number;
  };
  recentRuns: Array<{
    id: string;
    status: string;
    triggerType: string;
    requestedModes: string[];
    createdAt: string;
    finishedAt: string | null;
    errorMessage: string | null;
    sourceSummary: Record<string, number>;
  }>;
}

const SUMMARY_CARDS = [
  {
    key: 'objects',
    label: '총 Object',
    accent: 'from-primary/14 via-primary/4 to-transparent',
  },
  {
    key: 'services',
    label: '서비스',
    accent: 'from-secondary/14 via-secondary/4 to-transparent',
  },
  {
    key: 'domains',
    label: '도메인',
    accent: 'from-emerald-500/14 via-emerald-500/4 to-transparent',
  },
  {
    key: 'pending',
    label: '승인 대기',
    accent: 'from-amber-500/14 via-amber-500/4 to-transparent',
  },
] as const;

const QUICK_ACTIONS = [
  { key: 'run-inference', href: '/approval', label: '추론 실행', description: '승인 대기 화면에서 정적 분석 또는 Smart 추론을 바로 실행합니다.', icon: Activity },
  { key: 'scan-code', href: '/settings', label: '코드 스캔', description: '설정 화면의 코드 스캔 탭으로 이동해 소스를 다시 등록합니다.', icon: Server },
  { key: 'review-approval', href: '/approval', label: '승인 이동', description: '관계 및 도메인 후보를 검토하고 승인합니다.', icon: CheckCircle2 },
  { key: 'view-architecture', href: '/architecture', label: '아키텍처 보기', description: '레이어와 서비스 구조를 확인합니다.', icon: LayoutGrid },
  { key: 'view-mapping', href: '/mapping-graph', label: 'Object Mapping', description: 'Roll-up 그래프에서 관계를 추적합니다.', icon: GitGraph },
  { key: 'query-engine', href: '/query', label: '쿼리 엔진', description: '영향도와 경로를 직접 질의합니다.', icon: SearchCode },
] as const;

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatRunSummary(run: DashboardSummary['recentRuns'][number]): string {
  const sourceCount = Object.values(run.sourceSummary ?? {}).reduce((sum, count) => sum + count, 0);
  const modes = run.requestedModes.length > 0 ? run.requestedModes.join(', ') : '기본 모드';
  return `${modes}${sourceCount > 0 ? ` · source ${sourceCount}개` : ''}`;
}

export function DashboardHomeClient() {
  const { workspaceId, workspaceName } = useWorkspace();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const response = await fetch(`/api/dashboard/summary?workspaceId=${workspaceId}`, {
          cache: 'no-store',
        });
        const payload = (await response.json()) as DashboardSummary | { error?: string };
        if (!response.ok) {
          throw new Error('error' in payload && payload.error ? payload.error : '요약 정보를 불러오지 못했습니다.');
        }

        if (!cancelled) {
          startTransition(() => {
            setSummary(payload as DashboardSummary);
            setLoading(false);
          });
        }
      } catch (fetchError) {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : '요약 정보를 불러오지 못했습니다.');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  if (loading) {
    return (
      <div className="flex h-full min-h-[420px] items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error || !summary) {
    return (
      <div className="p-6">
        <EmptyStateGuide
          eyebrow="Dashboard Home"
          title="운영 요약을 불러오지 못했습니다"
          description={error ?? '잠시 후 다시 시도해 주세요.'}
          actions={[
            { href: '/services', label: 'Object 목록으로 이동' },
            { href: '/inference-runs', label: '추론 이력 보기', variant: 'outline' },
          ]}
        />
      </div>
    );
  }

  const pendingTotal = summary.counts.pendingRelations + summary.counts.pendingDomains;
  const summaryValues = {
    objects: summary.counts.objects,
    services: summary.counts.services,
    domains: summary.counts.domains,
    pending: pendingTotal,
  };

  return (
    <div className="min-h-full p-6">
      <section className="relative overflow-hidden rounded-[28px] border border-border/70 bg-card/80 px-6 py-7 shadow-sm">
        <div
          data-testid="dashboard-hero-surface"
          className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(45,212,191,0.14),transparent_42%),radial-gradient(circle_at_top_right,rgba(217,119,87,0.14),transparent_38%)]"
        />
        <div className="relative flex flex-col gap-8">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl space-y-2">
              <p className="text-xs font-medium uppercase tracking-[0.22em] text-primary">Dashboard Home</p>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                  {workspaceName ?? '선택된 워크스페이스'} 운영 요약
                </h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  빈 그래프부터 시작하지 않고, 현재 규모와 승인 대기량, 최근 추론 흐름을 먼저 확인합니다.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <Link href="/approval">승인 대기 확인</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/inference-runs">최근 실행 보기</Link>
              </Button>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {SUMMARY_CARDS.map((card) => (
              <div
                key={card.key}
                data-testid={`dashboard-summary-card-${card.key}`}
                className={cn(
                  'rounded-2xl border border-border/60 bg-background/82 px-4 py-4 shadow-sm',
                  'bg-gradient-to-br',
                  card.accent,
                )}
              >
                <p className="text-sm text-muted-foreground">{card.label}</p>
                <p className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
                  {summaryValues[card.key]}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.2fr_1fr]">
        <section className="rounded-3xl border border-border/70 bg-card/70 p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-foreground">최근 추론 실행</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                최근 5건의 실행 결과와 모드 조합을 빠르게 확인합니다.
              </p>
            </div>
            <Button asChild variant="ghost">
              <Link href="/inference-runs">전체 보기</Link>
            </Button>
          </div>

          {summary.recentRuns.length === 0 ? (
            <div className="mt-5 rounded-2xl border border-dashed border-border/70 px-4 py-6">
              <p className="text-sm font-medium text-foreground">아직 추론 실행 이력이 없습니다</p>
              <p className="mt-1 text-sm text-muted-foreground">
                승인 대기 화면에서 정적 분석 또는 Smart 추론을 시작할 수 있습니다.
              </p>
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {summary.recentRuns.map((run) => (
                <div
                  key={run.id}
                  className="rounded-2xl border border-border/60 bg-background/70 px-4 py-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-foreground">{run.status}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatRunSummary(run)}
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatTimestamp(run.finishedAt ?? run.createdAt)}
                    </p>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="rounded-full bg-muted px-2 py-1">{run.triggerType}</span>
                    {run.errorMessage ? (
                      <span className="rounded-full bg-destructive/10 px-2 py-1 text-destructive">
                        {run.errorMessage}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-3xl border border-border/70 bg-card/70 p-5 shadow-sm">
          <div>
            <h2 className="text-base font-semibold text-foreground">빠른 액션</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              현재 워크스페이스에서 바로 다음 작업으로 이동합니다.
            </p>
          </div>
          <div className="mt-5 grid gap-3">
            {QUICK_ACTIONS.map((action) => {
              const Icon = action.icon;
              return (
                <Link
                  key={action.key}
                  href={action.href}
                  className="group flex items-center justify-between gap-4 rounded-2xl border border-border/60 bg-background/70 px-4 py-3 transition-colors hover:border-primary/35 hover:bg-background"
                >
                  <div className="flex items-start gap-3">
                    <div className="rounded-xl bg-primary/10 p-2 text-primary">
                      <Icon className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">{action.label}</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {action.description}
                      </p>
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </Link>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
