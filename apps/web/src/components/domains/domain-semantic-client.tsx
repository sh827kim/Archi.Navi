/**
 * 도메인 의미 프로파일 상세 클라이언트
 * - 저장된 프로파일 조회 → 없으면 안내
 * - "의미 추출 실행" 버튼으로 LLM 추출 트리거 (비용 발생 안내 포함)
 * - "JSON 내보내기" 버튼으로 export 라우트 호출
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Download, Loader2, Sparkles, RefreshCw, ArrowLeft } from 'lucide-react';
import { Badge, Button } from '@archi-navi/ui';
import { toast } from 'sonner';
import type {
  DomainSemanticAction,
  DomainSemanticCollaborator,
  DomainSemanticEvent,
  DomainSemanticEvidence,
  DomainSemanticInvariant,
  DomainSemanticProfile,
  DomainSemanticScenario,
  DomainSemanticState,
} from '@archi-navi/shared';
import { useWorkspace } from '@/contexts/workspace-context';
import { getClientAiRequestHeaders } from '@/lib/client-ai-settings';

interface Props {
  domainId: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** 도메인을 구현하는 서비스 정보 */
interface ImplementingService {
  serviceObjectId: string;
  serviceName: string;
  childInDomain: number;
  childTotal: number;
  confidence: number;
}

export function DomainSemanticClient({ domainId }: Props) {
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const [profile, setProfile] = useState<DomainSemanticProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 구현 서비스 목록 */
  const [implServices, setImplServices] = useState<ImplementingService[]>([]);

  const loadProfile = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/domains/${domainId}/semantic?workspaceId=${workspaceId}`);
      const json = (await res.json()) as ApiEnvelope<DomainSemanticProfile>;
      if (res.ok && json.success && json.data) {
        setProfile(json.data);
      } else if (res.status === 404) {
        setProfile(null);
      } else {
        setError(json.error?.message ?? '프로파일 조회 실패');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [domainId, workspaceId]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  /** 구현 서비스 목록 로드 */
  const loadImplServices = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const res = await fetch(
        `/api/domains/${domainId}/implementing-services?workspaceId=${workspaceId}`,
      );
      const json = (await res.json()) as ApiEnvelope<{ implementingServices: ImplementingService[] }>;
      if (res.ok && json.success && json.data) {
        setImplServices(json.data.implementingServices);
      }
    } catch (e) {
      console.error('[domain-semantic] loadImplServices', e);
    }
  }, [domainId, workspaceId]);

  useEffect(() => {
    void loadImplServices();
  }, [loadImplServices]);

  const handleExtract = useCallback(async () => {
    if (!workspaceId) {
      toast.error('워크스페이스가 선택되지 않았습니다');
      return;
    }
    if (!confirm('LLM 호출이 발생합니다. 계속할까요?\n(입력 토큰은 도메인 규모에 비례합니다)')) return;

    setExtracting(true);
    try {
      const res = await fetch(`/api/domains/${domainId}/extract-semantic`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getClientAiRequestHeaders(),
        },
        body: JSON.stringify({ workspaceId }),
      });
      const json = (await res.json()) as ApiEnvelope<{ profile: DomainSemanticProfile; persisted: boolean }>;
      if (!res.ok || !json.success || !json.data) {
        throw new Error(json.error?.message ?? '의미 추출 실패');
      }
      setProfile(json.data.profile);
      toast.success('도메인 의미 프로파일이 생성되었습니다');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setExtracting(false);
    }
  }, [domainId, workspaceId]);

  const handleExport = useCallback(() => {
    if (!workspaceId) return;
    window.open(
      `/api/domains/${domainId}/semantic/export?workspaceId=${workspaceId}&format=json`,
      '_blank',
    );
  }, [domainId, workspaceId]);

  if (!workspaceId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        워크스페이스를 선택해주세요.
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/domains" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
            <ArrowLeft className="h-4 w-4" />
            목록으로
          </Link>
          <h1 className="text-2xl font-semibold">
            {profile ? profile.domainName : '도메인 의미 프로파일'}
          </h1>
          {profile && (
            <Badge variant={profile.status === 'APPROVED' ? 'default' : 'secondary'}>
              {profile.status}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={loadProfile}
            disabled={loading || extracting}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            새로고침
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={!profile || loading || extracting}
          >
            <Download className="h-4 w-4 mr-2" />
            JSON 내보내기
          </Button>
          <Button size="sm" onClick={handleExtract} disabled={extracting}>
            {extracting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4 mr-2" />
            )}
            의미 추출 실행
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded border border-destructive/30 bg-destructive/5 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && !profile && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          불러오는 중…
        </div>
      )}

      {!loading && !profile && !error && (
        <div className="rounded border border-dashed border-border p-8 text-center space-y-2">
          <p className="text-sm text-muted-foreground">
            아직 의미 프로파일이 생성되지 않았습니다.
          </p>
          <p className="text-xs text-muted-foreground">
            "의미 추출 실행" 을 눌러 LLM 합성을 시작하세요.
          </p>
        </div>
      )}

      {/* 구현 서비스 섹션 — 의미 프로파일 섹션들보다 앞에 배치 */}
      <section className="rounded-lg border border-border bg-card p-4">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">구현 서비스</h2>
          <Badge variant="secondary" className="text-xs">
            {implServices.length}개 서비스
          </Badge>
        </header>
        {implServices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            아직 이 도메인을 구현하는 서비스가 연결되지 않았습니다.
          </p>
        ) : (
          <ul className="space-y-2">
            {implServices.map((s) => {
              const pct = Math.round(s.confidence * 100);
              return (
                <li
                  key={s.serviceObjectId}
                  className="flex items-center justify-between gap-3 rounded border border-border/60 px-3 py-2"
                >
                  <span className="truncate text-sm font-medium">{s.serviceName}</span>
                  <div className="flex items-center gap-2">
                    {/* confidence 시각화 바 */}
                    <div className="h-1.5 w-24 overflow-hidden rounded bg-muted">
                      <div
                        className="h-full bg-primary"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="w-20 shrink-0 text-right font-mono text-xs text-muted-foreground">
                      {s.childInDomain}/{s.childTotal} ({pct}%)
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-3 text-[10px] text-muted-foreground">
          * 비율은 코드 단위 (function, api_endpoint) 기준입니다.
        </p>
      </section>

      {profile && <ProfileSections profile={profile} />}
    </div>
  );
}

function ProfileSections({ profile }: { profile: DomainSemanticProfile }) {
  const evidenceMap = new Map(profile.evidence.map((e) => [e.id, e]));

  return (
    <div className="space-y-6">
      <Section title="책임 (Why)">
        <p className="text-sm leading-relaxed whitespace-pre-wrap">
          {profile.responsibility || <em className="text-muted-foreground">(미작성)</em>}
        </p>
        <div className="text-xs text-muted-foreground mt-2">
          생성: {new Date(profile.generatedAt).toLocaleString('ko-KR')} · 모델: {profile.llmModel}
        </div>
      </Section>

      <Section title={`상태 (${profile.state.length})`}>
        <StateList items={profile.state} evidenceMap={evidenceMap} />
      </Section>

      <Section title={`액션 (${profile.actions.length})`}>
        <ActionList items={profile.actions} evidenceMap={evidenceMap} />
      </Section>

      <Section title={`규칙/이벤트 (${profile.invariants.length} + ${profile.events.length})`}>
        <InvariantList items={profile.invariants} evidenceMap={evidenceMap} />
        <div className="h-2" />
        <EventList items={profile.events} evidenceMap={evidenceMap} />
      </Section>

      <Section title={`협력 (${profile.collaborators.length})`}>
        <CollaboratorList items={profile.collaborators} evidenceMap={evidenceMap} />
      </Section>

      <Section title={`시나리오 (${profile.scenarios.length})`}>
        <ScenarioList items={profile.scenarios} evidenceMap={evidenceMap} />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-border p-4 space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
      <div>{children}</div>
    </section>
  );
}

function EvidencePills({
  ids,
  evidenceMap,
}: {
  ids: string[];
  evidenceMap: Map<string, DomainSemanticEvidence>;
}) {
  if (ids.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {ids.map((id) => {
        const ev = evidenceMap.get(id);
        if (!ev) return null;
        const range = ev.startLine != null ? `:${ev.startLine}${ev.endLine != null ? `-${ev.endLine}` : ''}` : '';
        return (
          <Badge key={id} variant="outline" className="text-[10px] font-mono">
            {ev.filePath}{range}
          </Badge>
        );
      })}
    </div>
  );
}

function StateList({
  items,
  evidenceMap,
}: {
  items: DomainSemanticState[];
  evidenceMap: Map<string, DomainSemanticEvidence>;
}) {
  if (items.length === 0) return <EmptyHint />;
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="text-sm">
          <span className="font-medium">{item.name}</span>
          <span className="text-muted-foreground"> : {item.type}</span>
          <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
          <EvidencePills ids={item.evidenceIds} evidenceMap={evidenceMap} />
        </li>
      ))}
    </ul>
  );
}

function ActionList({
  items,
  evidenceMap,
}: {
  items: DomainSemanticAction[];
  evidenceMap: Map<string, DomainSemanticEvidence>;
}) {
  if (items.length === 0) return <EmptyHint />;
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="text-sm">
          <div className="flex items-center gap-2">
            <span className="font-medium">{item.name}</span>
            <Badge variant="secondary" className="text-[10px]">{item.trigger}</Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
          {item.params.length > 0 && (
            <p className="text-xs text-muted-foreground font-mono">
              ({item.params.map((p) => `${p.name}: ${p.type}`).join(', ')})
            </p>
          )}
          <EvidencePills ids={item.evidenceIds} evidenceMap={evidenceMap} />
        </li>
      ))}
    </ul>
  );
}

function InvariantList({
  items,
  evidenceMap,
}: {
  items: DomainSemanticInvariant[];
  evidenceMap: Map<string, DomainSemanticEvidence>;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="text-sm">
          <p>{item.description}</p>
          {item.failureMode && (
            <p className="text-xs text-muted-foreground">위반 시: {item.failureMode}</p>
          )}
          <EvidencePills ids={item.evidenceIds} evidenceMap={evidenceMap} />
        </li>
      ))}
    </ul>
  );
}

function EventList({
  items,
  evidenceMap,
}: {
  items: DomainSemanticEvent[];
  evidenceMap: Map<string, DomainSemanticEvidence>;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="text-sm">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-[10px]">{item.direction}</Badge>
            <span className="font-mono text-xs">{item.channel}</span>
            <span className="font-medium">{item.name}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
          <EvidencePills ids={item.evidenceIds} evidenceMap={evidenceMap} />
        </li>
      ))}
    </ul>
  );
}

function CollaboratorList({
  items,
  evidenceMap,
}: {
  items: DomainSemanticCollaborator[];
  evidenceMap: Map<string, DomainSemanticEvidence>;
}) {
  if (items.length === 0) return <EmptyHint />;
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="text-sm">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">{item.relationType}</Badge>
            <span className="font-medium">{item.targetName}</span>
            {item.targetDomainId && (
              <span className="text-xs text-muted-foreground font-mono">dom:{item.targetDomainId}</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{item.reason}</p>
          <EvidencePills ids={item.evidenceIds} evidenceMap={evidenceMap} />
        </li>
      ))}
    </ul>
  );
}

function ScenarioList({
  items,
  evidenceMap,
}: {
  items: DomainSemanticScenario[];
  evidenceMap: Map<string, DomainSemanticEvidence>;
}) {
  if (items.length === 0) return <EmptyHint />;
  return (
    <ul className="space-y-3">
      {items.map((item, i) => (
        <li key={i} className="text-sm">
          <p className="font-medium">{item.title}</p>
          <ol className="list-decimal list-inside text-xs text-muted-foreground mt-1 space-y-0.5">
            {item.steps.map((step, j) => (
              <li key={j}>{step}</li>
            ))}
          </ol>
          <EvidencePills ids={item.evidenceIds} evidenceMap={evidenceMap} />
        </li>
      ))}
    </ul>
  );
}

function EmptyHint() {
  return <p className="text-xs text-muted-foreground">(없음)</p>;
}
