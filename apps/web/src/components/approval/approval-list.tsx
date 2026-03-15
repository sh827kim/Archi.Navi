/**
 * 승인 대기 목록 컴포넌트
 * PENDING 상태의 relation_candidates를 조회하고 승인/거부 처리
 *
 * - ATOMIC 후보: 소속 COMPOUND(서비스) 표시 + 승인/거부
 * - COMPOUND→COMPOUND 후보: 승인/거부 대신 "세부 매핑" 버튼 표시
 */
'use client';

import { useEffect, useState, useTransition, useCallback, useRef } from 'react';
import { Check, X, Sparkles, Link2, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import {
  Button, Badge, Spinner, ConfirmDialog,
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from '@archi-navi/ui';
import { useWorkspace } from '@/contexts/workspace-context';

/** 후보 관계 타입 (API 응답) */
interface RelationCandidate {
  id: string;
  subjectName: string;
  subjectGranularity: 'COMPOUND' | 'ATOMIC';
  subjectParentName: string | null;
  subjectObjectType: string | null;
  relationType: string;
  objectName: string;
  objectGranularity: 'COMPOUND' | 'ATOMIC';
  objectParentName: string | null;
  objectObjectType: string | null;
  objectId: string;
  subjectObjectId: string;
  confidence: number;
  source: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
}

/** 엔드포인트 (세부 매핑용) */
interface EndpointInfo {
  id: string;
  name: string;
  method: string;
  path: string;
}

const CODE_ENGINE_LS_KEY = 'archi-navi:inference:code-engine';

function resolveCodeEngine(): 'hybrid' | 'ast' | 'regex' {
  if (typeof window === 'undefined') return 'hybrid';
  const saved = localStorage.getItem(CODE_ENGINE_LS_KEY);
  if (saved === 'regex') return 'regex';
  if (saved === 'ast' || saved === 'auto') return 'ast';
  return 'hybrid';
}

/** 서비스 레벨 후보 여부 */
function isCompoundToCompound(c: RelationCandidate): boolean {
  return c.subjectGranularity === 'COMPOUND' && c.objectGranularity === 'COMPOUND';
}

/** 오브젝트명 렌더링 (ATOMIC이면 parent 서비스명 포함) */
function ObjectLabel({ name, granularity, parentName, objectType }: {
  name: string;
  granularity: string;
  parentName: string | null;
  objectType: string | null;
}) {
  if (granularity === 'ATOMIC' && parentName) {
    return (
      <span className="flex items-center gap-1">
        <span className="text-muted-foreground text-xs">{parentName}</span>
        <ChevronRight className="h-3 w-3 text-muted-foreground" />
        <span className="font-medium text-foreground">{name}</span>
      </span>
    );
  }
  return <span className="font-medium text-foreground">{name}</span>;
}

export function ApprovalList() {
  const { workspaceId } = useWorkspace();
  const [candidates, setCandidates] = useState<RelationCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningInference, setRunningInference] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [rejectTarget, setRejectTarget] = useState<RelationCandidate | null>(null);

  // 세부 매핑 Sheet 상태
  const [mappingTarget, setMappingTarget] = useState<RelationCandidate | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointInfo[]>([]);
  const [selectedEndpoints, setSelectedEndpoints] = useState<Set<string>>(new Set());
  const [loadingEndpoints, setLoadingEndpoints] = useState(false);
  const [submittingMapping, setSubmittingMapping] = useState(false);
  const endpointRequestSeqRef = useRef(0);

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
          code?: {
            signalCount?: number;
            enginesUsed?: string[];
            fallbackCount?: number;
            scanFailures?: Array<{ filePath: string; reason: string; language: string }>;
          };
        };
        warnings?: string[];
      };
      if (!res.ok) throw new Error(payload.error ?? '추론 실행 실패');

      const created = payload.summary?.relationCandidatesCreated ?? 0;
      const enginesUsed = payload.results?.code?.enginesUsed ?? [];
      const fallbackCount = payload.results?.code?.fallbackCount ?? 0;
      const scanFailureCount = payload.results?.code?.scanFailures?.length ?? 0;

      // 엔진 메타 정보 문자열 조립
      const engineParts: string[] = [];
      if (enginesUsed.length > 0) {
        engineParts.push(`엔진: ${enginesUsed.join('+')}`);
      }
      if (fallbackCount > 0) {
        engineParts.push(`fallback ${fallbackCount}건`);
      }
      if (scanFailureCount > 0) {
        engineParts.push(`파싱 실패 ${scanFailureCount}건`);
      }
      const engineSuffix = engineParts.length > 0 ? ` (${engineParts.join(', ')})` : '';

      if (created > 0) {
        toast.success(`추론 실행 완료 — 관계 후보 ${created}개 생성${engineSuffix}`);
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

  const closeMappingSheet = useCallback(() => {
    endpointRequestSeqRef.current += 1;
    setMappingTarget(null);
    setEndpoints([]);
    setSelectedEndpoints(new Set());
    setLoadingEndpoints(false);
  }, []);

  // 세부 매핑: 엔드포인트 목록 로드
  const openMappingSheet = async (cand: RelationCandidate) => {
    const requestSeq = endpointRequestSeqRef.current + 1;
    endpointRequestSeqRef.current = requestSeq;
    setMappingTarget(cand);
    setEndpoints([]);
    setSelectedEndpoints(new Set());
    setLoadingEndpoints(true);
    try {
      const res = await fetch(`/api/inference/candidates/${cand.id}/endpoints`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { endpoints: EndpointInfo[] };
      if (requestSeq !== endpointRequestSeqRef.current) return;
      setEndpoints(data.endpoints);
    } catch {
      if (requestSeq !== endpointRequestSeqRef.current) return;
      setEndpoints([]);
      toast.error('엔드포인트 목록 로드 실패');
    } finally {
      if (requestSeq !== endpointRequestSeqRef.current) return;
      setLoadingEndpoints(false);
    }
  };

  // 세부 매핑: 선택한 엔드포인트로 매핑 실행
  const submitMapping = async () => {
    if (!mappingTarget || selectedEndpoints.size === 0) return;
    setSubmittingMapping(true);
    try {
      const res = await fetch(`/api/inference/candidates/${mappingTarget.id}/map-endpoints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpointIds: [...selectedEndpoints] }),
      });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as {
        createdRelationCount: number;
        resolvedRelationCount?: number;
        reusedRelationCount?: number;
      };
      const resolvedRelationCount = data.resolvedRelationCount ?? data.createdRelationCount;
      const reusedRelationCount = data.reusedRelationCount ?? 0;

      if (resolvedRelationCount > 0) {
        if (data.createdRelationCount > 0 && reusedRelationCount > 0) {
          toast.success(
            `${data.createdRelationCount}개 엔드포인트 관계 생성, ${reusedRelationCount}개 기존 관계 재사용`,
          );
        } else if (data.createdRelationCount > 0) {
          toast.success(`${data.createdRelationCount}개 엔드포인트 관계 생성됨`);
        } else {
          toast.success(`${resolvedRelationCount}개 기존 엔드포인트 관계를 재사용해 원본 후보를 정리했습니다.`);
        }
        setCandidates((prev) => prev.filter((c) => c.id !== mappingTarget.id));
        closeMappingSheet();
      } else {
        toast.warning('생성된 엔드포인트 관계가 없어 원본 후보를 유지했습니다.');
      }
    } catch {
      toast.error('매핑 처리 실패');
    } finally {
      setSubmittingMapping(false);
    }
  };

  // 엔드포인트 체크 토글
  const toggleEndpoint = (epId: string) => {
    setSelectedEndpoints((prev) => {
      const next = new Set(prev);
      if (next.has(epId)) next.delete(epId);
      else next.add(epId);
      return next;
    });
  };

  // 전체 선택/해제
  const toggleAll = () => {
    if (selectedEndpoints.size === endpoints.length) {
      setSelectedEndpoints(new Set());
    } else {
      setSelectedEndpoints(new Set(endpoints.map((ep) => ep.id)));
    }
  };

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

  // COMPOUND→COMPOUND 후보와 나머지를 분리
  const compoundCandidates = candidates.filter(isCompoundToCompound);
  const atomicCandidates = candidates.filter((c) => !isCompoundToCompound(c));

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

      {/* ATOMIC 레벨 후보: 승인/거부 */}
      {atomicCandidates.length > 0 && (
        <div className="space-y-2">
          {atomicCandidates.map((cand) => (
            <div
              key={cand.id}
              className="flex items-center justify-between rounded-xl p-4 transition-all glass-card"
            >
              {/* 관계 정보 */}
              <div className="flex items-center gap-3 flex-wrap">
                <ObjectLabel
                  name={cand.subjectName}
                  granularity={cand.subjectGranularity}
                  parentName={cand.subjectParentName}
                  objectType={cand.subjectObjectType}
                />
                <Badge variant="outline">{cand.relationType}</Badge>
                <ObjectLabel
                  name={cand.objectName}
                  granularity={cand.objectGranularity}
                  parentName={cand.objectParentName}
                  objectType={cand.objectObjectType}
                />
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
      )}

      {/* COMPOUND→COMPOUND 후보: 세부 매핑 */}
      {compoundCandidates.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-muted-foreground mb-2">
            서비스 간 관계 — 세부 매핑 필요 ({compoundCandidates.length}건)
          </h3>
          <div className="space-y-2">
            {compoundCandidates.map((cand) => (
              <div
                key={cand.id}
                className="flex items-center justify-between rounded-xl p-4 transition-all glass-card border border-dashed border-muted-foreground/30"
              >
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-medium text-foreground">{cand.subjectName}</span>
                  <Badge variant="outline">{cand.relationType}</Badge>
                  <span className="font-medium text-foreground">{cand.objectName}</span>
                  <Badge variant="secondary" className="text-xs">서비스 레벨</Badge>
                </div>

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
                      variant="outline"
                      onClick={() => void openMappingSheet(cand)}
                    >
                      <Link2 className="h-3.5 w-3.5 mr-1" />
                      세부 매핑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setRejectTarget(cand)}
                      disabled={isPending}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

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

      {/* 세부 매핑 Sheet */}
      <Sheet
        open={!!mappingTarget}
        onOpenChange={(open) => { if (!open) closeMappingSheet(); }}
      >
        <SheetContent className="sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>엔드포인트 세부 매핑</SheetTitle>
            <SheetDescription>
              <span className="font-medium">{mappingTarget?.subjectName}</span>
              {' → '}
              <span className="font-medium">{mappingTarget?.objectName}</span>
              {' 서비스에서 실제로 호출하는 엔드포인트를 선택하세요.'}
            </SheetDescription>
          </SheetHeader>

          <div className="mt-4 space-y-2 max-h-[60vh] overflow-y-auto">
            {loadingEndpoints ? (
              <div className="flex h-20 items-center justify-center">
                <Spinner />
              </div>
            ) : endpoints.length === 0 ? (
              <div className="text-sm text-muted-foreground text-center py-8">
                등록된 엔드포인트가 없습니다.
                <br />
                코드 스캔 또는 OpenAPI 임포트를 먼저 실행하세요.
              </div>
            ) : (
              <>
                {/* 전체 선택/해제 */}
                <div className="flex items-center justify-between pb-2 border-b">
                  <span className="text-xs text-muted-foreground">
                    {endpoints.length}개 엔드포인트
                  </span>
                  <Button size="sm" variant="ghost" onClick={toggleAll}>
                    {selectedEndpoints.size === endpoints.length ? '전체 해제' : '전체 선택'}
                  </Button>
                </div>

                {endpoints.map((ep) => {
                  const isSelected = selectedEndpoints.has(ep.id);
                  return (
                    <button
                      key={ep.id}
                      type="button"
                      onClick={() => toggleEndpoint(ep.id)}
                      className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-colors text-left ${
                        isSelected
                          ? 'border-primary bg-primary/5'
                          : 'border-transparent hover:bg-muted/50'
                      }`}
                    >
                      {/* 체크 표시 */}
                      <div className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 ${
                        isSelected ? 'bg-primary border-primary' : 'border-muted-foreground/40'
                      }`}>
                        {isSelected && <Check className="h-3 w-3 text-primary-foreground" />}
                      </div>

                      {/* 메서드 + 경로 */}
                      <div className="flex items-center gap-2 min-w-0">
                        <Badge
                          variant="outline"
                          className={`text-xs shrink-0 ${
                            ep.method === 'GET' ? 'text-green-600 border-green-600/30' :
                            ep.method === 'POST' ? 'text-blue-600 border-blue-600/30' :
                            ep.method === 'PUT' ? 'text-orange-600 border-orange-600/30' :
                            ep.method === 'DELETE' ? 'text-red-600 border-red-600/30' :
                            ''
                          }`}
                        >
                          {ep.method}
                        </Badge>
                        <span className="text-sm font-mono truncate">{ep.path}</span>
                      </div>
                    </button>
                  );
                })}
              </>
            )}
          </div>

          <SheetFooter className="mt-4">
            <Button
              variant="outline"
              onClick={closeMappingSheet}
            >
              취소
            </Button>
            <Button
              onClick={() => void submitMapping()}
              disabled={selectedEndpoints.size === 0 || submittingMapping}
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              {submittingMapping ? '처리 중...' : `${selectedEndpoints.size}개 매핑 적용`}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
