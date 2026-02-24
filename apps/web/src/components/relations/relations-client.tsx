/**
 * 관계 매핑 클라이언트 컴포넌트 (개선 버전)
 *
 * 레이아웃:
 *  - 좌측 패널: COMPOUND 목록 (서비스/DB/브로커 단위) + 관계 수 배지
 *  - 우측 패널: 선택된 Compound의 Inbound / Outbound 관계 상세
 *
 * 관계 등록 플로우 (4단계):
 *  주체 Compound → 주체 Atomic → 대상 Compound → 대상 Atomic + 관계 타입 (자동 결정)
 */
'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Plus,
  Trash2,
  Loader2,
  Link as LinkIcon,
  ChevronRight,
  ArrowLeft,
  AlertCircle,
} from 'lucide-react';
import {
  cn,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  ConfirmDialog,
} from '@archi-navi/ui';
import { toast } from 'sonner';
import { useWorkspace } from '@/contexts/workspace-context';

/* ─── 도메인 타입 ─── */
interface ObjectItem {
  id: string;
  name: string;
  displayName: string | null;
  objectType: string;
  granularity: string;   // 'COMPOUND' | 'ATOMIC'
  depth: number;
  parentId: string | null;
}

interface RelationItem {
  id: string;
  relationType: string;
  status: string;
  confidence: number | null;
  source: string;
  isDerived: boolean;          // roll-up으로 자동 계산된 관계 여부
  subjectObjectId: string;
  objectId: string;
}

/* ─── 상수 / 헬퍼 ─── */
const RELATION_TYPES = [
  'call', 'expose', 'read', 'write', 'produce', 'consume', 'depend_on', 'fk_reference',
] as const;
type RelationType = typeof RELATION_TYPES[number];

/** objectType별 텍스트 색상 */
const TYPE_TEXT_COLORS: Record<string, string> = {
  service:        'text-indigo-400',
  api_endpoint:   'text-violet-400',
  database:       'text-emerald-400',
  db_table:       'text-cyan-400',
  message_broker: 'text-amber-400',
  topic:          'text-amber-400',
  kafka_topic:    'text-amber-400',
  domain:         'text-cyan-400',
};

function typeColor(objectType: string): string {
  return TYPE_TEXT_COLORS[objectType] ?? 'text-zinc-400';
}

function getRelationVariant(
  type: string,
): 'default' | 'secondary' | 'outline' | 'success' | 'warning' {
  switch (type) {
    case 'call':              return 'default';
    case 'read': case 'write': return 'secondary';
    case 'produce': case 'consume': return 'warning';
    case 'expose':            return 'success';
    default:                  return 'outline';
  }
}

/** displayName 우선, 없으면 name */
function label(obj: ObjectItem | undefined): string {
  if (!obj) return '(알 수 없음)';
  return obj.displayName ?? obj.name;
}

/**
 * 대상 objectType에 따라 사용 가능한 관계 타입 자동 결정
 * - service / api_endpoint  → call, expose, depend_on
 * - database / db_table     → read, write
 * - broker / topic          → produce, consume
 * - 기타                    → 전체 목록
 */
function getApplicableRelTypes(objectType: string): RelationType[] {
  if (['service', 'api_endpoint'].includes(objectType)) {
    return ['call', 'expose', 'depend_on'];
  }
  if (['database', 'db_table'].includes(objectType)) {
    return ['read', 'write'];
  }
  if (['message_broker', 'topic', 'kafka_topic'].includes(objectType)) {
    return ['produce', 'consume'];
  }
  return [...RELATION_TYPES];
}

/* ════════════════════════════════════════════════════════════════
   관계 행 컴포넌트 (상위 레벨 정의 → React reconcile 안정화)
   ════════════════════════════════════════════════════════════════ */
function RelationRow({
  rel,
  mode,
  compound,
  objMap,
  onDelete,
}: {
  rel: RelationItem;
  mode: 'inbound' | 'outbound';
  compound: ObjectItem;
  objMap: Map<string, ObjectItem>;
  onDelete: (rel: RelationItem) => void;
}) {
  /** id의 소속 Compound 반환 (COMPOUND면 자신, ATOMIC이면 부모) */
  const getOwner = (id: string): ObjectItem | undefined => {
    const obj = objMap.get(id);
    if (!obj) return undefined;
    return obj.parentId ? objMap.get(obj.parentId) : obj;
  };

  /* 외부 측 (이 Compound가 아닌 쪽) */
  const externalId       = mode === 'inbound' ? rel.subjectObjectId : rel.objectId;
  /* 내부 측 (이 Compound 소속) */
  const internalId       = mode === 'inbound' ? rel.objectId        : rel.subjectObjectId;

  const externalObj      = objMap.get(externalId);
  const internalObj      = objMap.get(internalId);
  const externalCompound = getOwner(externalId);
  /* compound 자신이 아니면 atomic */
  const isInternalAtomic = internalObj?.id !== compound.id;

  return (
    <div className="group flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-white/5 text-xs transition-colors">

      {/* 왼쪽: inbound=외부 Compound(+Atomic) / outbound=내부 Atomic */}
      <div className="flex-1 min-w-0">
        {mode === 'inbound' ? (
          /* 누가 참조하는지 → 외부 Compound + Atomic */
          <div className="flex items-center gap-1 min-w-0">
            <span className={cn('font-medium truncate', typeColor(externalCompound?.objectType ?? ''))}>
              {label(externalCompound ?? externalObj)}
            </span>
            {externalObj && externalObj.id !== externalCompound?.id && (
              <span className="text-muted-foreground truncate">
                <span className="mx-0.5">/</span>
                {label(externalObj)}
              </span>
            )}
          </div>
        ) : (
          /* 무엇을 통해 참조하는지 → 내부 Atomic */
          isInternalAtomic ? (
            <span className={cn('truncate', typeColor(internalObj?.objectType ?? ''))}>
              {label(internalObj)}
            </span>
          ) : (
            <span className="text-muted-foreground/40 italic text-[10px]">Compound 단위</span>
          )
        )}
      </div>

      {/* 중앙: 관계 타입 배지 */}
      <Badge
        variant={getRelationVariant(rel.relationType)}
        className="text-[9px] shrink-0"
      >
        {rel.relationType}
      </Badge>

      {/* 오른쪽: inbound=내부 Atomic / outbound=외부 Compound(+Atomic) */}
      <div className="flex-1 min-w-0 text-right">
        {mode === 'inbound' ? (
          /* 어떤 Atomic이 참조받는지 */
          isInternalAtomic ? (
            <span className={cn('truncate', typeColor(internalObj?.objectType ?? ''))}>
              {label(internalObj)}
            </span>
          ) : (
            <span className="text-muted-foreground/40 italic text-[10px]">Compound 단위</span>
          )
        ) : (
          /* 어디를 참조하는지 → 외부 Compound + Atomic */
          <div className="flex items-center justify-end gap-1 min-w-0">
            {externalObj && externalObj.id !== externalCompound?.id && (
              <span className="text-muted-foreground truncate">
                {label(externalObj)}
                <span className="mx-0.5">/</span>
              </span>
            )}
            <span className={cn('font-medium truncate', typeColor(externalCompound?.objectType ?? ''))}>
              {label(externalCompound ?? externalObj)}
            </span>
          </div>
        )}
      </div>

      {/* 삭제 버튼 (hover 시 표시) */}
      <button
        type="button"
        onClick={() => onDelete(rel)}
        className="shrink-0 rounded p-1 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:bg-destructive/10"
        title="삭제"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   4단계 관계 등록 다이얼로그
   ════════════════════════════════════════════════════════════════ */
function AddRelationDialog({
  open,
  onOpenChange,
  workspaceId,
  compounds,
  allObjects,
  relations,
  onSuccess,
  initialSubjectCompoundId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspaceId: string;
  compounds: ObjectItem[];
  allObjects: ObjectItem[];
  relations: RelationItem[];
  onSuccess: () => void;
  initialSubjectCompoundId?: string | undefined;
}) {
  const [step, setStep] = useState(1);
  const [subjectCompoundId, setSubjectCompoundId] = useState('');
  const [subjectAtomicId,   setSubjectAtomicId]   = useState('');
  const [targetCompoundId,  setTargetCompoundId]  = useState('');
  const [targetAtomicId,    setTargetAtomicId]    = useState('');
  const [relationType, setRelationType] = useState<RelationType>('call');
  const [saving, setSaving] = useState(false);

  /* 열릴 때 초기화 (사이드바 선택 compound 있으면 step 2부터 시작) */
  useEffect(() => {
    if (open) {
      setSubjectCompoundId(initialSubjectCompoundId ?? '');
      setSubjectAtomicId('');
      setTargetCompoundId('');
      setTargetAtomicId('');
      setRelationType('call');
      setStep(initialSubjectCompoundId ? 2 : 1);
    }
  }, [open, initialSubjectCompoundId]);

  /* 선택된 compound의 atomic 자식 목록 */
  const subjectAtomics = useMemo(
    () => allObjects.filter((o) => o.parentId === subjectCompoundId),
    [allObjects, subjectCompoundId],
  );
  const targetAtomics = useMemo(
    () => allObjects.filter((o) => o.parentId === targetCompoundId),
    [allObjects, targetCompoundId],
  );

  /* 최종 등록 ID (atomic 선택 시 atomic, 아니면 compound) */
  const finalSubjectId = subjectAtomicId || subjectCompoundId;
  const finalTargetId  = targetAtomicId  || targetCompoundId;

  /**
   * Compound ↔ Compound 관계 여부
   * - atomic을 선택하지 않으면 compound 단위 등록 → 양쪽 모두 compound = 등록 불가
   */
  const isBothCompound =
    !subjectAtomicId && !targetAtomicId &&
    !!subjectCompoundId && !!targetCompoundId;

  /** 동일한 (subject, relationType, target) 관계가 이미 존재하는지 */
  const isDuplicate = useMemo(
    () =>
      !!finalSubjectId &&
      !!finalTargetId &&
      relations.some(
        (r) =>
          r.subjectObjectId === finalSubjectId &&
          r.relationType    === relationType &&
          r.objectId        === finalTargetId,
      ),
    [relations, finalSubjectId, finalTargetId, relationType],
  );

  /**
   * 대상 타입 기반 관계 타입 자동 결정
   * - targetAtomicId가 있으면 atomic의 objectType 기준
   * - 없으면 targetCompound의 objectType 기준
   */
  const targetEffectObj = useMemo(
    () =>
      targetAtomicId
        ? allObjects.find((o) => o.id === targetAtomicId)
        : compounds.find((c) => c.id === targetCompoundId),
    [targetAtomicId, targetCompoundId, allObjects, compounds],
  );

  const applicableRelTypes = useMemo(
    () =>
      targetEffectObj
        ? getApplicableRelTypes(targetEffectObj.objectType)
        : [...RELATION_TYPES],
    [targetEffectObj],
  );

  /* 대상 타입 변경 시 현재 relationType이 가능 목록에 없으면 첫 번째로 리셋 */
  useEffect(() => {
    if (!applicableRelTypes.includes(relationType)) {
      setRelationType(applicableRelTypes[0] ?? 'call');
    }
  }, [applicableRelTypes, relationType]);

  /* 현재 step에서 "다음" 버튼 활성 조건 */
  const canProceed =
    (step === 1 && !!subjectCompoundId) ||
    step === 2 ||  // Atomic은 선택사항
    (step === 3 && !!targetCompoundId);
    // step 4는 Atomic 선택사항 + 타입 자동 선택 → 항상 제출 가능

  const handleSubmit = async () => {
    if (!finalSubjectId || !finalTargetId) {
      toast.error('주체와 대상을 선택하세요');
      return;
    }
    if (isBothCompound) {
      toast.error('Compound ↔ Compound 관계는 등록할 수 없습니다. Atomic을 선택하세요.');
      return;
    }
    if (isDuplicate) {
      toast.error('이미 등록된 관계입니다');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/relations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          subjectObjectId: finalSubjectId,
          relationType,
          objectId: finalTargetId,
          confidence: 1.0,
        }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? '등록 실패');
      }
      toast.success('관계 등록됨');
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '관계 등록 실패');
    } finally {
      setSaving(false);
    }
  };

  const STEP_LABELS = ['주체 Compound', '주체 Atomic', '대상 Compound', '대상 & 타입'];

  /* 미리보기용 객체 */
  const subjectCompound = compounds.find((c) => c.id === subjectCompoundId);
  const subjectAtomic   = allObjects.find((o) => o.id === subjectAtomicId);
  const targetCompound  = compounds.find((c) => c.id === targetCompoundId);
  const targetAtomic    = allObjects.find((o) => o.id === targetAtomicId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>관계 등록</DialogTitle>
        </DialogHeader>

        {/* ── 단계 표시기 ── */}
        <div className="flex items-start gap-0 mb-5">
          {STEP_LABELS.map((stepLabel, i) => (
            <div key={i} className="flex items-center flex-1">
              {/* 원 + 라벨 */}
              <div className="flex flex-col items-center gap-1 flex-1">
                <div
                  className={cn(
                    'w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors',
                    step === i + 1
                      ? 'bg-primary text-primary-foreground'
                      : step > i + 1
                      ? 'bg-primary/25 text-primary'
                      : 'bg-muted/30 text-muted-foreground/40',
                  )}
                >
                  {step > i + 1 ? '✓' : i + 1}
                </div>
                <span
                  className={cn(
                    'text-[9px] text-center leading-tight whitespace-nowrap',
                    step === i + 1 ? 'text-foreground font-medium' : 'text-muted-foreground/40',
                  )}
                >
                  {stepLabel}
                </span>
              </div>
              {/* 연결선 */}
              {i < STEP_LABELS.length - 1 && (
                <div
                  className={cn(
                    'h-px w-full mt-[-14px]',
                    step > i + 1 ? 'bg-primary/25' : 'bg-muted/20',
                  )}
                />
              )}
            </div>
          ))}
        </div>

        {/* ── 단계별 콘텐츠 ── */}
        <div className="min-h-[110px] space-y-3">
          {/* Step 1: 주체 Compound */}
          {step === 1 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">주체 Compound 선택</p>
              <Select value={subjectCompoundId} onValueChange={setSubjectCompoundId}>
                <SelectTrigger>
                  <SelectValue placeholder="Compound를 선택하세요" />
                </SelectTrigger>
                <SelectContent>
                  {compounds.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      <span className="font-medium">{label(c)}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{c.objectType}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Step 2: 주체 Atomic (선택사항) */}
          {step === 2 && (
            <div className="space-y-2">
              <div>
                <p className="text-sm font-medium">
                  주체 Atomic 선택
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    (선택사항 — 미선택 시 Compound 단위)
                  </span>
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  주체: <span className={cn('font-medium', typeColor(subjectCompound?.objectType ?? ''))}>{label(subjectCompound)}</span>
                </p>
              </div>
              {subjectAtomics.length > 0 ? (
                <Select
                  value={subjectAtomicId || '__none__'}
                  onValueChange={(v) => setSubjectAtomicId(v === '__none__' ? '' : v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* __none__: Compound 단위 등록 (선택 해제용 sentinel) */}
                    <SelectItem value="__none__">— Compound 단위로 등록 —</SelectItem>
                    {subjectAtomics.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        <span>{label(a)}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{a.objectType}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-sm text-muted-foreground py-2">
                  이 Compound에 등록된 Atomic이 없습니다.
                </p>
              )}
            </div>
          )}

          {/* Step 3: 대상 Compound */}
          {step === 3 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">대상 Compound 선택</p>
              <Select value={targetCompoundId} onValueChange={setTargetCompoundId}>
                <SelectTrigger>
                  <SelectValue placeholder="대상 Compound를 선택하세요" />
                </SelectTrigger>
                <SelectContent>
                  {compounds
                    .filter((c) => c.id !== subjectCompoundId)
                    .map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        <span className="font-medium">{label(c)}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{c.objectType}</span>
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Step 4: 대상 Atomic (선택사항) + 관계 타입 자동 결정 */}
          {step === 4 && (
            <div className="space-y-3">
              {/* 대상 Atomic 선택 */}
              <div className="space-y-2">
                <div>
                  <p className="text-sm font-medium">
                    대상 Atomic 선택
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                      (선택사항 — 미선택 시 Compound 단위)
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    대상: <span className={cn('font-medium', typeColor(targetCompound?.objectType ?? ''))}>{label(targetCompound)}</span>
                  </p>
                </div>
                {targetAtomics.length > 0 ? (
                  <Select
                    value={targetAtomicId || '__none__'}
                    onValueChange={(v) => setTargetAtomicId(v === '__none__' ? '' : v)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {/* __none__: Compound 단위 등록 (선택 해제용 sentinel) */}
                      <SelectItem value="__none__">— Compound 단위로 등록 —</SelectItem>
                      {targetAtomics.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          <span>{label(a)}</span>
                          <span className="ml-2 text-xs text-muted-foreground">{a.objectType}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-sm text-muted-foreground py-1">
                    이 Compound에 등록된 Atomic이 없습니다.
                  </p>
                )}
              </div>

              {/* 관계 타입 — 대상 유형에 따라 자동 결정, 필요 시 수동 변경 가능 */}
              <div className="space-y-1.5 pt-0.5">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">관계 타입</p>
                  <span className="text-[10px] text-muted-foreground/60">
                    대상 유형에 따라 자동 선택됩니다
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {applicableRelTypes.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setRelationType(t)}
                      className={cn(
                        'px-2.5 py-1 rounded-full text-xs font-medium transition-colors border',
                        relationType === t
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-muted/20 text-muted-foreground border-white/10 hover:bg-white/10',
                      )}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              {/* 미리보기 (compact) */}
              <div className="flex items-center gap-1.5 flex-wrap rounded-md bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
                <span className={cn('font-medium', typeColor(subjectCompound?.objectType ?? ''))}>
                  {label(subjectCompound)}
                  {subjectAtomic && (
                    <span className="text-violet-400"> / {label(subjectAtomic)}</span>
                  )}
                </span>
                <span className="text-muted-foreground/40">→</span>
                <Badge variant={getRelationVariant(relationType)} className="text-[9px]">
                  {relationType}
                </Badge>
                <span className="text-muted-foreground/40">→</span>
                <span className={cn('font-medium', typeColor(targetCompound?.objectType ?? ''))}>
                  {label(targetCompound)}
                  {targetAtomic && (
                    <span className="text-violet-400"> / {label(targetAtomic)}</span>
                  )}
                </span>
              </div>

              {/* ── 등록 불가 에러 메시지 ── */}
              {isBothCompound && (
                <div className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>
                    Compound ↔ Compound 관계는 등록할 수 없습니다.
                    <br />
                    주체 또는 대상의 <strong>Atomic</strong>을 선택하세요.
                  </span>
                </div>
              )}
              {!isBothCompound && isDuplicate && (
                <div className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  이미 등록된 관계입니다.
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── 내비게이션 버튼 ── */}
        <DialogFooter className="flex justify-between mt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setStep((s) => s - 1)}
            disabled={step === 1}
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            이전
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            {step < 4 ? (
              <Button size="sm" disabled={!canProceed} onClick={() => setStep((s) => s + 1)}>
                다음
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={saving || isBothCompound || isDuplicate}
                onClick={() => void handleSubmit()}
              >
                {saving
                  ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />등록 중...</>
                  : <><Plus className="h-4 w-4 mr-1.5" />등록</>
                }
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ════════════════════════════════════════════════════════════════
   선택된 Compound의 Inbound / Outbound 관계 상세
   ════════════════════════════════════════════════════════════════ */
function CompoundRelationDetail({
  compound,
  allObjects,
  relations,
  onDelete,
}: {
  compound: ObjectItem;
  allObjects: ObjectItem[];
  relations: RelationItem[];
  onDelete: (rel: RelationItem) => void;
}) {
  /* id → ObjectItem 맵 */
  const objMap = useMemo(
    () => new Map(allObjects.map((o) => [o.id, o])),
    [allObjects],
  );

  /* 이 Compound 소속 ID 집합 (compound 자신 + 모든 atomic 자식) */
  const memberIds = useMemo(() => {
    const ids = new Set<string>([compound.id]);
    allObjects
      .filter((o) => o.parentId === compound.id)
      .forEach((o) => ids.add(o.id));
    return ids;
  }, [compound, allObjects]);

  /**
   * 관계 목록에서 숨겨야 할 관계 판별
   * - isDerived: true  → roll-up으로 자동 계산된 파생 관계
   * - 양쪽 모두 COMPOUND → 수동 등록이라도 COMPOUND 단위 관계는 숨김
   */
  const isHiddenRelation = useCallback(
    (r: RelationItem): boolean => {
      if (r.isDerived) return true;
      const subGran = objMap.get(r.subjectObjectId)?.granularity;
      const objGran = objMap.get(r.objectId)?.granularity;
      return subGran === 'COMPOUND' && objGran === 'COMPOUND';
    },
    [objMap],
  );

  /* Inbound: 이 Compound 또는 그 Atomic이 objectId인 관계 (숨김 관계 제외) */
  const inbound = useMemo(
    () => relations.filter((r) => memberIds.has(r.objectId) && !isHiddenRelation(r)),
    [relations, memberIds, isHiddenRelation],
  );

  /* Outbound: 이 Compound 또는 그 Atomic이 subjectObjectId인 관계 (숨김 관계 제외) */
  const outbound = useMemo(
    () => relations.filter((r) => memberIds.has(r.subjectObjectId) && !isHiddenRelation(r)),
    [relations, memberIds, isHiddenRelation],
  );

  if (inbound.length === 0 && outbound.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
        <LinkIcon className="h-8 w-8 opacity-20" />
        <p className="text-sm">등록된 관계가 없습니다</p>
        <p className="text-xs text-center">
          우측 상단 "관계 등록" 버튼으로 첫 관계를 등록하세요.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Inbound ── */}
      {inbound.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-blue-400 text-base">←</span>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Inbound
            </h3>
            <span className="text-[10px] text-muted-foreground/50 bg-muted/20 px-1.5 py-0.5 rounded-full">
              {inbound.length}
            </span>
          </div>

          {/* 컬럼 헤더 */}
          <div className="flex items-center gap-3 px-3 pb-1 text-[10px] text-muted-foreground/50 uppercase tracking-wider">
            <span className="flex-1">참조하는 곳</span>
            <span className="w-16 text-center shrink-0">타입</span>
            <span className="flex-1 text-right">참조받는 Atomic</span>
            <span className="w-5 shrink-0" />
          </div>

          <div className="space-y-0.5">
            {inbound.map((rel) => (
              <RelationRow
                key={rel.id}
                rel={rel}
                mode="inbound"
                compound={compound}
                objMap={objMap}
                onDelete={onDelete}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── Outbound ── */}
      {outbound.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Outbound
            </h3>
            <span className="text-orange-400 text-base">→</span>
            <span className="text-[10px] text-muted-foreground/50 bg-muted/20 px-1.5 py-0.5 rounded-full">
              {outbound.length}
            </span>
          </div>

          {/* 컬럼 헤더 */}
          <div className="flex items-center gap-3 px-3 pb-1 text-[10px] text-muted-foreground/50 uppercase tracking-wider">
            <span className="flex-1">참조하는 Atomic</span>
            <span className="w-16 text-center shrink-0">타입</span>
            <span className="flex-1 text-right">참조되는 곳</span>
            <span className="w-5 shrink-0" />
          </div>

          <div className="space-y-0.5">
            {outbound.map((rel) => (
              <RelationRow
                key={rel.id}
                rel={rel}
                mode="outbound"
                compound={compound}
                objMap={objMap}
                onDelete={onDelete}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   메인 컴포넌트
   ════════════════════════════════════════════════════════════════ */
export function RelationsClient() {
  const { workspaceId } = useWorkspace();
  const [allObjects, setAllObjects] = useState<ObjectItem[]>([]);
  const [relations,  setRelations]  = useState<RelationItem[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [selectedCompoundId, setSelectedCompoundId] = useState<string | null>(null);
  const [addOpen,      setAddOpen]      = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RelationItem | null>(null);
  const [deleting,     setDeleting]     = useState(false);

  /* ─── 데이터 로드 ─── */
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [relRes, objRes] = await Promise.all([
        fetch(`/api/relations?workspaceId=${workspaceId}&status=APPROVED`),
        fetch(`/api/objects?workspaceId=${workspaceId}`),
      ]);
      if (!relRes.ok || !objRes.ok) throw new Error('로드 실패');
      setRelations((await relRes.json()) as RelationItem[]);
      setAllObjects((await objRes.json()) as ObjectItem[]);
    } catch {
      console.error('[RelationsClient] 로드 실패');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { void loadData(); }, [loadData]);

  /* ─── COMPOUND 목록 (사이드바용) ─── */
  const compounds = useMemo(
    () => allObjects.filter((o) => o.granularity === 'COMPOUND'),
    [allObjects],
  );

  /* ─── 선택된 Compound 객체 ─── */
  const selectedCompound = useMemo(
    () => allObjects.find((o) => o.id === selectedCompoundId),
    [allObjects, selectedCompoundId],
  );

  /* ─── Compound별 관계 수 (사이드바 배지용) ─── */
  const relCountByCompound = useMemo(() => {
    const compoundIdSet = new Set(compounds.map((c) => c.id));
    /* ATOMIC → 부모 COMPOUND 역추적 맵 */
    const atomicToCompound = new Map<string, string>();
    /* granularity 조회용 맵 */
    const objMapForCount   = new Map(allObjects.map((o) => [o.id, o]));
    allObjects.forEach((o) => {
      if (o.parentId && compoundIdSet.has(o.parentId)) {
        atomicToCompound.set(o.id, o.parentId);
      }
    });

    const countMap = new Map<string, number>();
    relations
      /* 목록에서 숨기는 관계와 동일한 기준으로 배지 수에서도 제외 */
      .filter((r) => {
        if (r.isDerived) return false;
        const subGran = objMapForCount.get(r.subjectObjectId)?.granularity;
        const objGran = objMapForCount.get(r.objectId)?.granularity;
        return !(subGran === 'COMPOUND' && objGran === 'COMPOUND');
      })
      .forEach((r) => {
        const subComp =
          compoundIdSet.has(r.subjectObjectId)
            ? r.subjectObjectId
            : atomicToCompound.get(r.subjectObjectId);
        const objComp =
          compoundIdSet.has(r.objectId)
            ? r.objectId
            : atomicToCompound.get(r.objectId);

        if (subComp) countMap.set(subComp, (countMap.get(subComp) ?? 0) + 1);
        if (objComp && objComp !== subComp)
          countMap.set(objComp, (countMap.get(objComp) ?? 0) + 1);
      });
    return countMap;
  }, [compounds, allObjects, relations]);

  /* ─── 관계 삭제 ─── */
  const deleteRelation = async (id: string) => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/relations/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('삭제 API 오류');
      toast.success('관계 삭제됨');
      setDeleteTarget(null);
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '삭제 실패');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex h-full">

      {/* ════════════════════════════
          좌측: Compound 목록 패널
          ════════════════════════════ */}
      <aside className="w-56 shrink-0 border-r border-white/5 flex flex-col h-full">
        <div className="px-4 py-3 border-b border-white/5 shrink-0">
          <h2 className="text-sm font-semibold text-foreground">Compound 목록</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {loading ? '로딩 중...' : `${compounds.length}개`}
          </p>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : compounds.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground px-4">
            <p className="text-xs text-center">Compound 오브젝트가 없습니다.</p>
          </div>
        ) : (
          <nav className="flex-1 overflow-y-auto py-1.5">
            {compounds.map((c) => {
              const count = relCountByCompound.get(c.id) ?? 0;
              const isSelected = selectedCompoundId === c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => setSelectedCompoundId(c.id)}
                  className={cn(
                    'w-full flex items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors',
                    isSelected
                      ? 'bg-primary/10 text-primary border-r-2 border-primary'
                      : 'text-muted-foreground hover:bg-white/5 hover:text-foreground border-r-2 border-transparent',
                  )}
                >
                  {/* objectType 색상 점 */}
                  <span
                    className={cn('shrink-0 h-1.5 w-1.5 rounded-full', {
                      'bg-indigo-400':  c.objectType === 'service',
                      'bg-emerald-400': c.objectType === 'database',
                      'bg-amber-400':   ['message_broker', 'topic', 'kafka_topic'].includes(c.objectType),
                      'bg-cyan-400':    c.objectType === 'domain',
                      'bg-zinc-400':    !['service','database','message_broker','topic','kafka_topic','domain'].includes(c.objectType),
                    })}
                  />
                  <span className="flex-1 truncate font-medium">{label(c)}</span>
                  {count > 0 && (
                    <span
                      className={cn(
                        'shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                        isSelected
                          ? 'bg-primary/20 text-primary'
                          : 'bg-muted/40 text-muted-foreground',
                      )}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        )}
      </aside>

      {/* ════════════════════════════
          우측: 관계 상세 패널
          ════════════════════════════ */}
      <main className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        {/* 스티키 헤더 */}
        <div className="shrink-0 flex items-center justify-between gap-4 px-6 py-3 border-b border-white/5 bg-background/80 backdrop-blur-sm">
          <div className="min-w-0">
            {selectedCompound ? (
              <>
                <h2 className="text-base font-semibold text-foreground truncate">
                  {label(selectedCompound)}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {selectedCompound.objectType}
                  <span className="mx-1.5 text-muted-foreground/30">·</span>
                  {(relCountByCompound.get(selectedCompound.id) ?? 0)}개의 관계
                </p>
              </>
            ) : (
              <h2 className="text-sm font-medium text-muted-foreground">
                Compound를 선택하세요
              </h2>
            )}
          </div>
          <Button
            size="sm"
            onClick={() => setAddOpen(true)}
            disabled={compounds.length === 0}
          >
            <Plus className="h-4 w-4 mr-1.5" />
            관계 등록
          </Button>
        </div>

        {/* 콘텐츠 */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {!selectedCompound ? (
            /* 미선택 상태 */
            <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
              <LinkIcon className="h-10 w-10 opacity-20" />
              <p className="text-sm">좌측 목록에서 Compound를 선택하세요</p>
              <p className="text-xs text-center max-w-xs">
                서비스, 데이터베이스, 메시지 브로커 등 Compound 단위의 관계를 확인하고 관리합니다.
              </p>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <CompoundRelationDetail
              compound={selectedCompound}
              allObjects={allObjects}
              relations={relations}
              onDelete={setDeleteTarget}
            />
          )}
        </div>
      </main>

      {/* ─── 관계 등록 다이얼로그 ─── */}
      <AddRelationDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        workspaceId={workspaceId}
        compounds={compounds}
        allObjects={allObjects}
        relations={relations}
        onSuccess={() => void loadData()}
        initialSubjectCompoundId={selectedCompoundId ?? undefined}
      />

      {/* ─── 삭제 확인 다이얼로그 ─── */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => { if (!v && !deleting) setDeleteTarget(null); }}
        title="관계 삭제"
        description={
          deleteTarget
            ? `"${deleteTarget.relationType}" 관계를 삭제하시겠습니까?`
            : ''
        }
        confirmLabel="삭제"
        destructive
        loading={deleting}
        onConfirm={() => {
          if (deleteTarget) void deleteRelation(deleteTarget.id);
        }}
      />
    </div>
  );
}
