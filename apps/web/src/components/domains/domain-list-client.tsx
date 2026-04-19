/**
 * 도메인 관리 메인 클라이언트
 * - 섹션 1: 워크스페이스의 승인된 도메인 카드 그리드 (각 카드 → /domains/[id])
 * - 섹션 2: 발견 트리거 + 후보 미리보기 (in-memory, 승인 시에만 영구화)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, Sparkles, RefreshCw } from 'lucide-react';
import { Badge, Button } from '@archi-navi/ui';
import { toast } from 'sonner';
import { useWorkspace } from '@/contexts/workspace-context';
import { getClientAiRequestHeaders } from '@/lib/client-ai-settings';
import { DomainDiscoverSection } from '@/components/domains/domain-discover-section';

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface DomainListItem {
  id: string;
  name: string;
  displayName: string | null;
  path: string;
}

export function DomainListClient() {
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const [domains, setDomains] = useState<DomainListItem[]>([]);
  const [loading, setLoading] = useState(false);

  const loadDomains = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/domains?workspaceId=${workspaceId}`, {
        headers: getClientAiRequestHeaders(),
      });
      const data = (await res.json()) as DomainListItem[] | ApiEnvelope<unknown>;
      // GET /api/domains 는 평문 배열을 반환 (envelope 없음)
      if (Array.isArray(data)) {
        setDomains(data);
      } else {
        toast.error(data.error?.message ?? '도메인 목록 조회 실패');
      }
    } catch (err) {
      console.error('[domain-list] loadDomains', err);
      toast.error('도메인 목록 조회 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    loadDomains();
  }, [loadDomains]);

  if (!workspaceId) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-muted-foreground">
        워크스페이스를 먼저 선택해주세요.
      </div>
    );
  }

  return (
    <div className="space-y-8 p-6">
      {/* 페이지 헤더 */}
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">도메인 관리</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            결정적 신호 + LLM 검토로 도메인 후보를 발견하고, 승인된 도메인의 의미 프로파일을 추출합니다.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadDomains} disabled={loading}>
          {loading ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          )}
          새로고침
        </Button>
      </header>

      {/* 섹션 1: 승인된 도메인 */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
          <Sparkles className="h-4 w-4 text-primary" />
          승인된 도메인
          <Badge variant="secondary">{domains.length}</Badge>
        </h2>

        {domains.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground">
            아직 승인된 도메인이 없습니다. 아래 [도메인 발견] 으로 후보를 만들고 승인해주세요.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {domains.map((d) => (
              <Link
                key={d.id}
                href={`/domains/${d.id}`}
                className="group rounded-lg border border-border bg-card p-4 transition hover:border-primary/40 hover:shadow-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate font-medium group-hover:text-primary">
                      {d.displayName ?? d.name}
                    </h3>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{d.path}</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* 섹션 2: 발견 트리거 + 후보 미리보기 */}
      <DomainDiscoverSection
        workspaceId={workspaceId}
        onApproved={loadDomains}
      />
    </div>
  );
}
