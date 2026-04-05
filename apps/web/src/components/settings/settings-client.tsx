/**
 * 설정 페이지 — 클라이언트 컴포넌트
 * 탭 구성: 일반 | 레이어 관리 | 태그 관리 | AI 설정 | 추론 / Rollup | 코드 스캔
 */
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Plus,
  Trash2,
  Palette,
  GripVertical,
  Eye,
  EyeOff,
  Check,
  Bot,
  FlaskConical,
  Database,
  RefreshCw,
  ScanLine,
  FolderSearch,
  Github,
  Building,
  Loader2,
  CheckCircle2,
  SkipForward,
  Tag,
  FolderOpen,
  History,
  ChevronRight,
} from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  cn,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Button,
  Input,
  Switch,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@archi-navi/ui';
import { useWorkspace } from '@/contexts/workspace-context';
import { isAbsoluteScanPathPrefix } from '@/lib/scanPathPrefix';
import { PathPickerDialog } from '@/components/shared/path-picker-dialog';

/* ─── 타입 ─── */
interface LayerItem {
  id: string;
  name: string;
  displayName: string | null;
  color: string | null;
  sortOrder: number;
  isEnabled: boolean;
}

interface FeedbackConfig {
  enabled: boolean;
  minSamples: number;
  maxAdjustment: number;
}

interface FeedbackSummary {
  totalKeys: number;
  eligibleKeys: number;
  approvedCount: number;
  rejectedCount: number;
  totalSamples: number;
}

interface FeedbackEntry {
  key: string;
  approved: number;
  rejected: number;
  total: number;
  approvalRate: number;
  adjustment: number;
}

interface InferenceProfileFeedbackPayload {
  relationFeedbackConfig?: FeedbackConfig;
  relationFeedbackSummary?: FeedbackSummary;
  relationFeedbackEntries?: FeedbackEntry[];
  domainFeedbackConfig?: FeedbackConfig;
  domainFeedbackSummary?: FeedbackSummary;
  domainFeedbackEntries?: FeedbackEntry[];
}

/* ─── localStorage 키 ─── */
const LS = {
  AI_PROVIDER: 'archi-navi:ai-provider',
  AI_API_KEY: 'archi-navi:ai-api-key',
  AI_MODEL: 'archi-navi:ai-model',
  INF_W_CODE: 'archi-navi:inference:w-code',
  INF_W_DB: 'archi-navi:inference:w-db',
  INF_W_MSG: 'archi-navi:inference:w-msg',
  INF_CV_ENABLED: 'archi-navi:inference:cv-enabled',
  INF_CV_BOOST: 'archi-navi:inference:cv-boost-factor',
  INF_CV_PENALTY: 'archi-navi:inference:cv-penalty-factor',
  INF_CODE_ENGINE: 'archi-navi:inference:code-engine',
  ROLLUP_HUB: 'archi-navi:rollup:hub-threshold',
  ROLLUP_CLUSTER: 'archi-navi:rollup:min-cluster',
} as const;

type CodeEngineMode = 'hybrid' | 'ast' | 'regex';

function normalizeCodeEngineMode(value: string): CodeEngineMode {
  if (value === 'ast' || value === 'regex' || value === 'hybrid') return value;
  if (value === 'auto') return 'ast';
  return 'hybrid';
}

/* ─── AI 제공자 기본 모델 ─── */
const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-5',
  google: 'gemini-pro',
  custom: '',
};

const DEFAULT_FEEDBACK_CONFIG: FeedbackConfig = {
  enabled: true,
  minSamples: 10,
  maxAdjustment: 0.15,
};

const EMPTY_FEEDBACK_SUMMARY: FeedbackSummary = {
  totalKeys: 0,
  eligibleKeys: 0,
  approvedCount: 0,
  rejectedCount: 0,
  totalSamples: 0,
};

function buildDefaultProfileUrl(
  workspaceId: string,
  options?: { includeFeedbackEntries?: boolean },
): string {
  const searchParams = new URLSearchParams({ workspaceId });
  if (options?.includeFeedbackEntries) {
    searchParams.set('includeFeedbackEntries', 'true');
  }
  return `/api/inference/profiles/default?${searchParams.toString()}`;
}

function buildDefaultProfileMutationUrl(options?: { includeFeedbackEntries?: boolean }): string {
  if (!options?.includeFeedbackEntries) {
    return '/api/inference/profiles/default';
  }

  const searchParams = new URLSearchParams({ includeFeedbackEntries: 'true' });
  return `/api/inference/profiles/default?${searchParams.toString()}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeFeedbackEntries(value: unknown): FeedbackEntry[] {
  if (!Array.isArray(value)) return [];

  return value
    .flatMap((entry) => {
      const record = asRecord(entry);
      if (!record) return [];

      const key = typeof record.key === 'string' && record.key.trim().length > 0
        ? record.key.trim()
        : null;
      if (!key) return [];

      const approved = Math.max(0, Math.round(asFiniteNumber(record.approved) ?? 0));
      const rejected = Math.max(0, Math.round(asFiniteNumber(record.rejected) ?? 0));
      const total = Math.max(
        approved + rejected,
        Math.round(asFiniteNumber(record.total) ?? approved + rejected),
      );
      const approvalRate = total > 0 ? approved / total : 0;
      const adjustment = asFiniteNumber(record.adjustment) ?? 0;

      return [{
        key,
        approved,
        rejected,
        total,
        approvalRate,
        adjustment,
      }];
    })
    .sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      const adjustmentGap = Math.abs(b.adjustment) - Math.abs(a.adjustment);
      if (adjustmentGap !== 0) return adjustmentGap;
      return a.key.localeCompare(b.key);
    });
}

function applyRelationFeedbackPayload(
  payload: InferenceProfileFeedbackPayload,
  fallbackConfig: FeedbackConfig,
): {
  config: FeedbackConfig;
  summary: FeedbackSummary;
  entries: FeedbackEntry[];
} {
  return {
    config: {
      enabled: payload.relationFeedbackConfig?.enabled ?? fallbackConfig.enabled,
      minSamples: payload.relationFeedbackConfig?.minSamples ?? fallbackConfig.minSamples,
      maxAdjustment: payload.relationFeedbackConfig?.maxAdjustment ?? fallbackConfig.maxAdjustment,
    },
    summary: payload.relationFeedbackSummary ?? EMPTY_FEEDBACK_SUMMARY,
    entries: normalizeFeedbackEntries(payload.relationFeedbackEntries),
  };
}

function applyDomainFeedbackPayload(
  payload: InferenceProfileFeedbackPayload,
  fallbackConfig: FeedbackConfig,
): {
  config: FeedbackConfig;
  summary: FeedbackSummary;
  entries: FeedbackEntry[];
} {
  return {
    config: {
      enabled: payload.domainFeedbackConfig?.enabled ?? fallbackConfig.enabled,
      minSamples: payload.domainFeedbackConfig?.minSamples ?? fallbackConfig.minSamples,
      maxAdjustment: payload.domainFeedbackConfig?.maxAdjustment ?? fallbackConfig.maxAdjustment,
    },
    summary: payload.domainFeedbackSummary ?? EMPTY_FEEDBACK_SUMMARY,
    entries: normalizeFeedbackEntries(payload.domainFeedbackEntries),
  };
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatSignedPercentPoints(value: number): string {
  const rounded = Math.round(value * 1000) / 10;
  if (Object.is(rounded, -0)) return '0%p';
  return `${rounded > 0 ? '+' : ''}${rounded}%p`;
}

function getFeedbackEntryStatus(
  entry: FeedbackEntry,
  minSamples: number,
): '통계 없음' | '표본 부족' | '보정 적용' {
  if (entry.total === 0) return '통계 없음';
  if (entry.total < minSamples) return '표본 부족';
  return '보정 적용';
}

function readLocalStorage(key: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return localStorage.getItem(key) ?? fallback;
}

function readLocalStorageNumber(
  key: string,
  fallback: number,
  parser: (value: string) => number = Number,
): number {
  if (typeof window === 'undefined') return fallback;
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  const parsed = parser(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/* ════════════════════════════════════════════════════════════════
   루트 컴포넌트
   ════════════════════════════════════════════════════════════════ */
export function SettingsClient() {
  const { workspaceId } = useWorkspace();
  if (!workspaceId) return null;

  return (
    <div className="p-6 max-w-3xl space-y-4">
      <h2 className="text-lg font-semibold text-foreground">설정</h2>

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">일반</TabsTrigger>
          <TabsTrigger value="layers">레이어 관리</TabsTrigger>
          <TabsTrigger value="tags">태그 관리</TabsTrigger>
          <TabsTrigger value="ai">AI 설정</TabsTrigger>
          <TabsTrigger value="engine">추론 / Rollup</TabsTrigger>
          <TabsTrigger value="scan">코드 스캔</TabsTrigger>
        </TabsList>

        {/* ─── 일반 탭 ─── */}
        <TabsContent value="general" className="space-y-4">
          {/* 워크스페이스 정보 */}
          <Card className="glass-card">
            <CardHeader>
              <CardTitle>워크스페이스</CardTitle>
              <CardDescription>현재 워크스페이스 상태</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="font-medium text-muted-foreground mb-1">DB 타입</div>
                  <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs font-mono">
                    Embedded PostgreSQL / PostgreSQL
                  </div>
                </div>
                <div>
                  <div className="font-medium text-muted-foreground mb-1">상태</div>
                  <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs font-mono text-green-400">
                    ● 정상 가동 중
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 개발자 도구 */}
          <DevTools workspaceId={workspaceId} />
        </TabsContent>

        {/* ─── 레이어 관리 탭 ─── */}
        <TabsContent value="layers">
          <LayerManagement workspaceId={workspaceId} />
        </TabsContent>

        {/* ─── 태그 관리 탭 ─── */}
        <TabsContent value="tags">
          <TagManagement workspaceId={workspaceId} />
        </TabsContent>

        {/* ─── AI 설정 탭 ─── */}
        <TabsContent value="ai">
          <AiSettings />
        </TabsContent>

        {/* ─── 추론/Rollup 탭 ─── */}
        <TabsContent value="engine">
          <EngineSettings workspaceId={workspaceId} />
        </TabsContent>

        {/* ─── 코드 스캔 탭 ─── */}
        <TabsContent value="scan">
          <ScanSettings workspaceId={workspaceId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   개발자 도구 (샘플 데이터 / 초기화)
   ════════════════════════════════════════════════════════════════ */
function DevTools({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [seeding, setSeeding] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  const seedData = async () => {
    setSeeding(true);
    try {
      const res = await fetch('/api/dev/seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      if (!res.ok) throw new Error('seed failed');
      const data = (await res.json()) as {
        inserted: {
          layers: number;
          tags: number;
          objects: number;
          compoundRelations: number;
          atomicRelations: number;
        };
      };
      const { layers, tags, objects, compoundRelations, atomicRelations } = data.inserted;
      toast.success(
        `샘플 데이터 주입 완료 — 레이어 ${layers}개, 태그 ${tags}개, 오브젝트 ${objects}개, COMPOUND 관계 ${compoundRelations}개, ATOMIC 관계 ${atomicRelations}개`,
      );
    } catch {
      toast.error('샘플 데이터 주입 실패');
    } finally {
      setSeeding(false);
    }
  };

  const resetData = async () => {
    setResetting(true);
    try {
      const res = await fetch('/api/dev/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      const data = (await res.json()) as {
        error?: string;
        deleted?: {
          objects?: number;
          layers?: number;
          tags?: number;
          relations?: number;
          relationCandidates?: number;
          domainCandidates?: number;
          codeArtifacts?: number;
          evidences?: number;
        };
        remaining?: {
          objects?: number;
          layers?: number;
          tags?: number;
          relations?: number;
          relationCandidates?: number;
          domainCandidates?: number;
          codeArtifacts?: number;
          evidences?: number;
        };
      };
      if (!res.ok) {
        const remaining = data.remaining;
        if (remaining) {
          throw new Error(
            `초기화 실패 — 남은 데이터: Object ${remaining.objects ?? 0}, 관계 ${remaining.relations ?? 0}, 후보 ${remaining.relationCandidates ?? 0}, 도메인후보 ${remaining.domainCandidates ?? 0}`,
          );
        }
        throw new Error(data.error ?? 'reset failed');
      }
      setResetOpen(false);
      const deleted = data.deleted;
      if (deleted) {
        toast.success(
          `워크스페이스 초기화 완료 — Object ${deleted.objects ?? 0}, 레이어 ${deleted.layers ?? 0}, 태그 ${deleted.tags ?? 0}, 관계 ${deleted.relations ?? 0}, 후보 ${deleted.relationCandidates ?? 0}, 도메인후보 ${deleted.domainCandidates ?? 0}, 코드아티팩트 ${deleted.codeArtifacts ?? 0} 삭제`,
        );
      } else {
        toast.success('워크스페이스 데이터 초기화 완료');
      }
      // 강제 reload 대신 라우트 데이터만 새로고침해 HMR 충돌 가능성을 낮춘다.
      window.dispatchEvent(new CustomEvent('archi-navi:workspace-reset', { detail: { workspaceId } }));
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '초기화 실패');
    } finally {
      setResetting(false);
    }
  };

  return (
    <>
      <Card className="glass-card border-amber-500/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-amber-400">
            <FlaskConical className="h-4 w-4" />
            개발자 도구
          </CardTitle>
          <CardDescription>테스트용 데이터 관리. 프로덕션 환경에서는 주의하세요.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* 샘플 데이터 */}
          <div className="flex items-center justify-between rounded-lg border border-border/50 px-4 py-3">
            <div>
              <div className="text-sm font-medium text-foreground">샘플 데이터 주입</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                레이어 4개 · COMPOUND 12개 · ATOMIC 31개 · 관계 56개 (쇼핑몰 마이크로서비스)
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void seedData()}
              disabled={seeding}
            >
              <Database className="h-3.5 w-3.5 mr-1.5" />
              {seeding ? '주입 중...' : '샘플 넣기'}
            </Button>
          </div>

          {/* 워크스페이스 초기화 */}
          <div className="flex items-center justify-between rounded-lg border border-destructive/20 px-4 py-3">
            <div>
              <div className="text-sm font-medium text-foreground">워크스페이스 초기화</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                현재 워크스페이스의 모든 데이터를 삭제합니다
              </div>
            </div>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setResetOpen(true)}
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              전체 초기화
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={(open) => {
          if (!open) setResetOpen(false);
        }}
        title="워크스페이스 초기화"
        description="현재 워크스페이스의 모든 오브젝트, 관계, 레이어 데이터가 삭제됩니다. 이 작업은 되돌릴 수 없습니다."
        confirmLabel="전체 삭제"
        destructive
        loading={resetting}
        onConfirm={() => void resetData()}
      />
    </>
  );
}

/* ════════════════════════════════════════════════════════════════
   레이어 관리 (DnD Sortable)
   ════════════════════════════════════════════════════════════════ */
function LayerManagement({ workspaceId }: { workspaceId: string }) {
  const [layers, setLayers] = useState<LayerItem[]>([]);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#8b5cf6');
  const [deleteTarget, setDeleteTarget] = useState<LayerItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  // DnD 센서 설정 — activationConstraint로 클릭 이벤트와 드래그 충돌 방지
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 }, // 8px 이상 이동해야 드래그로 인식
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const fetchLayers = useCallback(async () => {
    try {
      const res = await fetch(`/api/layers?workspaceId=${workspaceId}`);
      if (!res.ok) return;
      const data = (await res.json()) as LayerItem[];
      setLayers(data);
    } catch {
      console.error('레이어 목록 로드 실패');
    }
  }, [workspaceId]);

  useEffect(() => {
    void fetchLayers();
  }, [fetchLayers]);

  /* 레이어 추가 */
  const addLayer = async () => {
    if (!newName.trim()) return;
    try {
      const res = await fetch('/api/layers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          name: newName.trim(),
          color: newColor,
          sortOrder: layers.length,
        }),
      });
      if (!res.ok) throw new Error('add failed');
      setNewName('');
      toast.success('레이어 추가됨');
      await fetchLayers();
    } catch {
      toast.error('레이어 추가 실패');
    }
  };

  /* 레이어 삭제 (response.ok 체크 + loading 상태) */
  const deleteLayer = async (id: string) => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/layers/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`delete failed: ${res.status}`);
      toast.success('레이어 삭제됨');
      setDeleteTarget(null);
      await fetchLayers();
    } catch {
      toast.error('레이어 삭제 실패');
    } finally {
      setDeleting(false);
    }
  };

  /* 활성/비활성 토글 */
  const toggleEnabled = async (layer: LayerItem) => {
    try {
      const res = await fetch(`/api/layers/${layer.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isEnabled: !layer.isEnabled }),
      });
      if (!res.ok) throw new Error('toggle failed');
      await fetchLayers();
    } catch {
      toast.error('상태 변경 실패');
    }
  };

  /* DnD 드래그 완료 → sortOrder 일괄 업데이트 */
  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = layers.findIndex((l) => l.id === active.id);
    const newIndex = layers.findIndex((l) => l.id === over.id);
    const reordered = arrayMove(layers, oldIndex, newIndex);

    // 낙관적 업데이트 (UI 즉시 반영)
    setLayers(reordered);

    try {
      await Promise.all(
        reordered.map((layer, idx) =>
          fetch(`/api/layers/${layer.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sortOrder: idx }),
          }),
        ),
      );
    } catch {
      toast.error('순서 변경 실패');
      await fetchLayers(); // 실패 시 서버 데이터 복원
    }
  };

  return (
    <Card className="glass-card">
      <CardHeader>
        <CardTitle>레이어 관리</CardTitle>
        <CardDescription>
          아키텍처 뷰에서 사용할 계층을 등록하고 드래그로 순서를 조정합니다
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 새 레이어 추가 폼 */}
        <div className="flex gap-2">
          <Input
            placeholder="새 레이어 이름"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addLayer();
            }}
            className="flex-1"
          />
          <div className="flex items-center gap-1">
            <Palette className="h-4 w-4 text-muted-foreground" />
            <input
              type="color"
              value={newColor}
              onChange={(e) => setNewColor(e.target.value)}
              className="h-9 w-9 rounded-md border border-input bg-transparent cursor-pointer"
            />
          </div>
          <Button onClick={() => void addLayer()} disabled={!newName.trim()}>
            <Plus className="h-4 w-4 mr-1" />
            추가
          </Button>
        </div>

        {/* DnD 레이어 목록 */}
        {layers.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            등록된 레이어가 없습니다. 위에서 추가하거나 마법사를 사용하세요.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={(e) => void handleDragEnd(e)}
          >
            <SortableContext
              items={layers.map((l) => l.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-1">
                {layers.map((layer) => (
                  <SortableLayerItem
                    key={layer.id}
                    layer={layer}
                    onToggle={toggleEnabled}
                    onDelete={(l) => setDeleteTarget(l)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}

        {/* 삭제 확인 다이얼로그 */}
        <ConfirmDialog
          open={!!deleteTarget}
          onOpenChange={(open) => {
            if (!open && !deleting) setDeleteTarget(null);
          }}
          title="레이어 삭제"
          description={`"${deleteTarget?.name}" 레이어를 삭제하시겠습니까? 배치된 Object의 할당도 함께 제거됩니다.`}
          confirmLabel="삭제"
          destructive
          loading={deleting}
          onConfirm={() => {
            const id = deleteTarget?.id;
            if (id) void deleteLayer(id);
          }}
        />
      </CardContent>
    </Card>
  );
}

/* ─── DnD 개별 레이어 항목 ─── */
function SortableLayerItem({
  layer,
  onToggle,
  onDelete,
}: {
  layer: LayerItem;
  onToggle: (layer: LayerItem) => void;
  onDelete: (layer: LayerItem) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: layer.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2.5 transition-all',
        'glass-card',
        !layer.isEnabled && 'opacity-50',
        isDragging && 'shadow-lg ring-1 ring-primary/50 z-10 opacity-90',
      )}
    >
      {/* 드래그 핸들 */}
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground touch-none"
      >
        <GripVertical className="h-4 w-4" />
      </div>

      {/* 색상 인디케이터 */}
      <div
        className="h-4 w-4 rounded-full shrink-0"
        style={{ backgroundColor: layer.color ?? '#6b7280' }}
      />

      {/* 이름 */}
      <span className="flex-1 text-sm font-medium text-foreground">
        {layer.displayName ?? layer.name}
      </span>

      {/* 활성/비활성 토글 */}
      <Switch
        checked={layer.isEnabled}
        onCheckedChange={() => onToggle(layer)}
      />

      {/* 삭제 버튼 */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
        onClick={() => onDelete(layer)}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   태그 관리
   ════════════════════════════════════════════════════════════════ */
interface TagItem {
  id: string;
  name: string;
  color: string | null;
  objectCount: number;
}

/** 프리셋 색상 (태그 추가 시 선택지) */
const TAG_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#22c55e',
  '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6',
  '#d946ef', '#ec4899', '#6b7280', '#78716c',
];

function TagManagement({ workspaceId }: { workspaceId: string }) {
  const [tagList, setTagList] = useState<TagItem[]>([]);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#3b82f6');
  const [deleteTarget, setDeleteTarget] = useState<TagItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  /* 태그 목록 로드 */
  const fetchTags = useCallback(async () => {
    try {
      const res = await fetch(`/api/tags?workspaceId=${workspaceId}`);
      if (!res.ok) return;
      const data = (await res.json()) as TagItem[];
      setTagList(data);
    } catch {
      console.error('태그 목록 로드 실패');
    }
  }, [workspaceId]);

  useEffect(() => {
    void fetchTags();
  }, [fetchTags]);

  /* 태그 추가 */
  const addTag = async () => {
    if (!newName.trim()) return;
    try {
      const res = await fetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, name: newName.trim(), color: newColor }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? '태그 추가 실패');
      }
      setNewName('');
      toast.success('태그 추가됨');
      await fetchTags();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '태그 추가 실패');
    }
  };

  /* 태그 삭제 */
  const deleteTag = async (id: string) => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/tags/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      toast.success('태그 삭제됨');
      setDeleteTarget(null);
      await fetchTags();
    } catch {
      toast.error('태그 삭제 실패');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card className="glass-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Tag className="h-4 w-4 text-primary" />
          태그 관리
        </CardTitle>
        <CardDescription>
          Object에 분류용 태그를 생성하고 관리합니다
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 새 태그 추가 폼 */}
        <div className="flex gap-2">
          <Input
            placeholder="새 태그 이름"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addTag();
            }}
            className="flex-1"
          />
          {/* 색상 프리셋 선택 */}
          <div className="flex items-center gap-1">
            <div className="flex gap-0.5 flex-wrap max-w-[120px]">
              {TAG_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setNewColor(c)}
                  className={cn(
                    'h-5 w-5 rounded-full transition-all shrink-0',
                    newColor === c && 'ring-2 ring-white ring-offset-1 ring-offset-background',
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
          <Button onClick={() => void addTag()} disabled={!newName.trim()}>
            <Plus className="h-4 w-4 mr-1" />
            추가
          </Button>
        </div>

        {/* 태그 목록 */}
        {tagList.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            등록된 태그가 없습니다. 위에서 추가해주세요.
          </p>
        ) : (
          <div className="space-y-1">
            {tagList.map((tag) => (
              <div
                key={tag.id}
                className="flex items-center gap-3 rounded-lg px-3 py-2.5 glass-card"
              >
                {/* 색상 dot */}
                <div
                  className="h-4 w-4 rounded-full shrink-0"
                  style={{ backgroundColor: tag.color ?? '#6b7280' }}
                />
                {/* 이름 */}
                <span className="flex-1 text-sm font-medium text-foreground">
                  {tag.name}
                </span>
                {/* 사용 개수 */}
                <span className="text-xs text-muted-foreground">
                  {tag.objectCount}개 사용
                </span>
                {/* 삭제 버튼 */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => setDeleteTarget(tag)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* 삭제 확인 다이얼로그 */}
        <ConfirmDialog
          open={!!deleteTarget}
          onOpenChange={(open) => {
            if (!open && !deleting) setDeleteTarget(null);
          }}
          title="태그 삭제"
          description={`"${deleteTarget?.name}" 태그를 삭제하시겠습니까? 모든 Object에서 해당 태그가 제거됩니다.`}
          confirmLabel="삭제"
          destructive
          loading={deleting}
          onConfirm={() => {
            const id = deleteTarget?.id;
            if (id) void deleteTag(id);
          }}
        />
      </CardContent>
    </Card>
  );
}

/* ════════════════════════════════════════════════════════════════
   AI 설정
   ════════════════════════════════════════════════════════════════ */
function AiSettings() {
  const [provider, setProvider] = useState(() => readLocalStorage(LS.AI_PROVIDER, 'openai'));
  const [apiKey, setApiKey] = useState(() => readLocalStorage(LS.AI_API_KEY, ''));
  const [model, setModel] = useState(() => {
    const savedProvider = readLocalStorage(LS.AI_PROVIDER, 'openai');
    const fallbackModel = DEFAULT_MODELS[savedProvider] ?? '';
    return readLocalStorage(LS.AI_MODEL, fallbackModel);
  });
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);

  // 제공자 변경 시 기본 모델 자동 설정
  const handleProviderChange = (val: string) => {
    setProvider(val);
    setModel(DEFAULT_MODELS[val] ?? '');
    setSaved(false);
  };

  const save = () => {
    localStorage.setItem(LS.AI_PROVIDER, provider);
    localStorage.setItem(LS.AI_API_KEY, apiKey);
    localStorage.setItem(LS.AI_MODEL, model);
    setSaved(true);
    toast.success('AI 설정 저장됨');
    setTimeout(() => setSaved(false), 2000);
  };

  const isConfigured = !!apiKey.trim();

  return (
    <div className="space-y-4">
      <Card className="glass-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" />
            AI 설정
            {/* 설정 상태 뱃지 */}
            <span
              className={cn(
                'ml-auto text-xs px-2 py-0.5 rounded-full font-normal',
                isConfigured
                  ? 'bg-green-500/15 text-green-400'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {isConfigured ? '● 설정됨' : '● 미설정'}
            </span>
          </CardTitle>
          <CardDescription>자연어 질의 및 AI 채팅에 사용할 제공자를 설정합니다</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* AI 제공자 선택 */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">AI 제공자</label>
            <Select value={provider} onValueChange={handleProviderChange}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="제공자 선택" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI (GPT)</SelectItem>
                <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                <SelectItem value="google">Google (Gemini)</SelectItem>
                <SelectItem value="custom">Custom / OpenAI-compatible</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* API Key 입력 */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">API Key</label>
            <div className="relative">
              <Input
                type={showKey ? 'text' : 'password'}
                placeholder={
                  provider === 'openai'
                    ? 'sk-...'
                    : provider === 'anthropic'
                    ? 'sk-ant-...'
                    : 'API 키 입력'
                }
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setSaved(false);
                }}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {/* 모델 이름 */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">모델</label>
            <Input
              placeholder={DEFAULT_MODELS[provider] ?? '모델명 입력'}
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setSaved(false);
              }}
            />
          </div>

          {/* 저장 버튼 */}
          <Button onClick={save} className="w-full sm:w-auto">
            {saved ? (
              <>
                <Check className="h-4 w-4 mr-1.5" />
                저장됨
              </>
            ) : (
              '설정 저장'
            )}
          </Button>
        </CardContent>
      </Card>

      {/* 환경변수 안내 */}
      <Card className="glass-card border-muted/30">
        <CardContent className="pt-4">
          <p className="text-xs text-muted-foreground">
            환경변수로도 설정 가능합니다 (환경변수가 우선 적용됩니다)
          </p>
          <ul className="mt-2 space-y-1 font-mono text-xs text-muted-foreground/70 list-disc list-inside">
            <li>AI_PROVIDER — openai | anthropic | google</li>
            <li>OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   추론 / Rollup 설정
   ════════════════════════════════════════════════════════════════ */
export function EngineSettings({ workspaceId }: { workspaceId: string }) {
  const [wCode, setWCode] = useState(() => readLocalStorageNumber(LS.INF_W_CODE, 0.5, parseFloat));
  const [wDb, setWDb] = useState(() => readLocalStorageNumber(LS.INF_W_DB, 0.3, parseFloat));
  const [wMsg, setWMsg] = useState(() => readLocalStorageNumber(LS.INF_W_MSG, 0.2, parseFloat));
  const [crossValidationEnabled, setCrossValidationEnabled] = useState(() =>
    readLocalStorage(LS.INF_CV_ENABLED, 'true') !== 'false',
  );
  const [crossValidationBoostFactor, setCrossValidationBoostFactor] = useState(() =>
    readLocalStorageNumber(LS.INF_CV_BOOST, 0.3, parseFloat),
  );
  const [crossValidationPenaltyFactor, setCrossValidationPenaltyFactor] = useState(() =>
    readLocalStorageNumber(LS.INF_CV_PENALTY, 0.85, parseFloat),
  );
  const [hubThreshold, setHubThreshold] = useState(() =>
    readLocalStorageNumber(LS.ROLLUP_HUB, 50, (value) => parseInt(value, 10)),
  );
  const [minCluster, setMinCluster] = useState(() =>
    readLocalStorageNumber(LS.ROLLUP_CLUSTER, 3, (value) => parseInt(value, 10)),
  );
  const [codeEngine, setCodeEngine] = useState<CodeEngineMode>(() =>
    normalizeCodeEngineMode(readLocalStorage(LS.INF_CODE_ENGINE, 'hybrid')),
  );
  const [relationFeedbackEnabled, setRelationFeedbackEnabled] = useState(
    DEFAULT_FEEDBACK_CONFIG.enabled,
  );
  const [relationFeedbackMinSamples, setRelationFeedbackMinSamples] = useState(
    DEFAULT_FEEDBACK_CONFIG.minSamples,
  );
  const [relationFeedbackMaxAdjustment, setRelationFeedbackMaxAdjustment] = useState(
    DEFAULT_FEEDBACK_CONFIG.maxAdjustment,
  );
  const [relationFeedbackSummary, setRelationFeedbackSummary] = useState<FeedbackSummary>(
    EMPTY_FEEDBACK_SUMMARY,
  );
  const [relationFeedbackEntries, setRelationFeedbackEntries] = useState<FeedbackEntry[]>([]);
  const [domainFeedbackEnabled, setDomainFeedbackEnabled] = useState(DEFAULT_FEEDBACK_CONFIG.enabled);
  const [domainFeedbackMinSamples, setDomainFeedbackMinSamples] = useState(
    DEFAULT_FEEDBACK_CONFIG.minSamples,
  );
  const [domainFeedbackMaxAdjustment, setDomainFeedbackMaxAdjustment] = useState(
    DEFAULT_FEEDBACK_CONFIG.maxAdjustment,
  );
  const [domainFeedbackSummary, setDomainFeedbackSummary] = useState<FeedbackSummary>(
    EMPTY_FEEDBACK_SUMMARY,
  );
  const [domainFeedbackEntries, setDomainFeedbackEntries] = useState<FeedbackEntry[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [syncingProfile, setSyncingProfile] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [resettingRelationFeedback, setResettingRelationFeedback] = useState(false);
  const [resettingDomainFeedback, setResettingDomainFeedback] = useState(false);
  const [saved, setSaved] = useState(false);

  // 가중치 합계 검증
  const weightSum = Math.round((wCode + wDb + wMsg) * 100) / 100;
  const weightOk = Math.abs(weightSum - 1.0) < 0.001;

  /* 숫자 범위 clamp */
  const clamp = (val: number, min: number, max: number) =>
    Math.max(min, Math.min(max, isNaN(val) ? min : val));

  useEffect(() => {
    let cancelled = false;

    async function loadDefaultProfile() {
      setSyncingProfile(true);
      try {
        const res = await fetch(buildDefaultProfileUrl(workspaceId, { includeFeedbackEntries: true }));
        if (!res.ok) throw new Error();
        const profile = (await res.json()) as {
          id: string;
          wCode: number;
          wDb: number;
          wMsg: number;
          minClusterSize: number;
          crossValidation?: {
            enabled: boolean;
            boostFactor: number;
            penaltyFactor: number;
          };
        } & InferenceProfileFeedbackPayload;
        if (cancelled) return;
        setProfileId(profile.id);
        setWCode(clamp(profile.wCode, 0, 1));
        setWDb(clamp(profile.wDb, 0, 1));
        setWMsg(clamp(profile.wMsg, 0, 1));
        setMinCluster(clamp(profile.minClusterSize, 2, 50));
        setCrossValidationEnabled(profile.crossValidation?.enabled ?? true);
        setCrossValidationBoostFactor(clamp(profile.crossValidation?.boostFactor ?? 0.3, 0, 1));
        setCrossValidationPenaltyFactor(clamp(profile.crossValidation?.penaltyFactor ?? 0.85, 0, 1));
        const relationFeedback = applyRelationFeedbackPayload(profile, DEFAULT_FEEDBACK_CONFIG);
        setRelationFeedbackEnabled(
          relationFeedback.config.enabled,
        );
        setRelationFeedbackMinSamples(
          clamp(relationFeedback.config.minSamples, 1, 10000),
        );
        setRelationFeedbackMaxAdjustment(
          clamp(relationFeedback.config.maxAdjustment, 0, 1),
        );
        setRelationFeedbackSummary(relationFeedback.summary);
        setRelationFeedbackEntries(relationFeedback.entries);

        const domainFeedback = applyDomainFeedbackPayload(profile, DEFAULT_FEEDBACK_CONFIG);
        setDomainFeedbackEnabled(domainFeedback.config.enabled);
        setDomainFeedbackMinSamples(
          clamp(domainFeedback.config.minSamples, 1, 10000),
        );
        setDomainFeedbackMaxAdjustment(
          clamp(domainFeedback.config.maxAdjustment, 0, 1),
        );
        setDomainFeedbackSummary(domainFeedback.summary);
        setDomainFeedbackEntries(domainFeedback.entries);
      } catch {
        if (!cancelled) {
          toast.error('기본 추론 프로필 로드 실패 (로컬 설정으로 동작)');
        }
      } finally {
        if (!cancelled) setSyncingProfile(false);
      }
    }

    void loadDefaultProfile();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const save = async () => {
    if (!weightOk) {
      toast.error(
        `가중치 합계가 ${weightSum.toFixed(2)}입니다. 합이 1.00이 되어야 합니다.`,
      );
      return;
    }
    setSavingProfile(true);
    try {
      const res = await fetch(buildDefaultProfileMutationUrl({ includeFeedbackEntries: true }), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          wCode,
          wDb,
          wMsg,
          minClusterSize: minCluster,
          crossValidation: {
            enabled: crossValidationEnabled,
            boostFactor: crossValidationBoostFactor,
            penaltyFactor: crossValidationPenaltyFactor,
          },
          relationFeedbackConfig: {
            enabled: relationFeedbackEnabled,
            minSamples: relationFeedbackMinSamples,
            maxAdjustment: relationFeedbackMaxAdjustment,
          },
          domainFeedbackConfig: {
            enabled: domainFeedbackEnabled,
            minSamples: domainFeedbackMinSamples,
            maxAdjustment: domainFeedbackMaxAdjustment,
          },
        }),
      });
      const payload = (await res.json()) as {
        id?: string;
        error?: string;
      } & InferenceProfileFeedbackPayload;
      if (!res.ok) throw new Error(payload.error ?? '프로필 저장 실패');

      if (payload.id) setProfileId(payload.id);
      const relationFeedback = applyRelationFeedbackPayload(payload, {
        enabled: relationFeedbackEnabled,
        minSamples: relationFeedbackMinSamples,
        maxAdjustment: relationFeedbackMaxAdjustment,
      });
      setRelationFeedbackEnabled(relationFeedback.config.enabled);
      setRelationFeedbackMinSamples(
        relationFeedback.config.minSamples,
      );
      setRelationFeedbackMaxAdjustment(
        relationFeedback.config.maxAdjustment,
      );
      setRelationFeedbackSummary(relationFeedback.summary);
      setRelationFeedbackEntries(relationFeedback.entries);
      const domainFeedback = applyDomainFeedbackPayload(payload, {
        enabled: domainFeedbackEnabled,
        minSamples: domainFeedbackMinSamples,
        maxAdjustment: domainFeedbackMaxAdjustment,
      });
      setDomainFeedbackEnabled(domainFeedback.config.enabled);
      setDomainFeedbackMinSamples(
        domainFeedback.config.minSamples,
      );
      setDomainFeedbackMaxAdjustment(
        domainFeedback.config.maxAdjustment,
      );
      setDomainFeedbackSummary(domainFeedback.summary);
      setDomainFeedbackEntries(domainFeedback.entries);
      localStorage.setItem(LS.INF_W_CODE, wCode.toString());
      localStorage.setItem(LS.INF_W_DB, wDb.toString());
      localStorage.setItem(LS.INF_W_MSG, wMsg.toString());
      localStorage.setItem(LS.INF_CV_ENABLED, String(crossValidationEnabled));
      localStorage.setItem(LS.INF_CV_BOOST, crossValidationBoostFactor.toString());
      localStorage.setItem(LS.INF_CV_PENALTY, crossValidationPenaltyFactor.toString());
      localStorage.setItem(LS.INF_CODE_ENGINE, codeEngine);
      localStorage.setItem(LS.ROLLUP_HUB, hubThreshold.toString());
      localStorage.setItem(LS.ROLLUP_CLUSTER, minCluster.toString());

      setSaved(true);
      toast.success('추론/Rollup 설정 저장됨 (기본 프로필 동기화 완료)');
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '설정 저장 실패');
    } finally {
      setSavingProfile(false);
    }
  };

  const resetRelationFeedback = async () => {
    setResettingRelationFeedback(true);
    try {
      const res = await fetch(buildDefaultProfileMutationUrl({ includeFeedbackEntries: true }), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, resetRelationFeedback: true }),
      });
      const payload = (await res.json()) as { error?: string } & InferenceProfileFeedbackPayload;
      if (!res.ok) throw new Error(payload.error ?? '피드백 통계 초기화 실패');

      const relationFeedback = applyRelationFeedbackPayload(payload, DEFAULT_FEEDBACK_CONFIG);
      setRelationFeedbackEnabled(
        relationFeedback.config.enabled,
      );
      setRelationFeedbackMinSamples(
        relationFeedback.config.minSamples,
      );
      setRelationFeedbackMaxAdjustment(
        relationFeedback.config.maxAdjustment,
      );
      setRelationFeedbackSummary(relationFeedback.summary);
      setRelationFeedbackEntries(relationFeedback.entries);
      setSaved(false);
      toast.success('relation feedback 설정과 집계를 초기화했습니다');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '피드백 통계 초기화 실패');
    } finally {
      setResettingRelationFeedback(false);
    }
  };

  const resetDomainFeedback = async () => {
    setResettingDomainFeedback(true);
    try {
      const res = await fetch(buildDefaultProfileMutationUrl({ includeFeedbackEntries: true }), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, resetDomainFeedback: true }),
      });
      const payload = (await res.json()) as { error?: string } & InferenceProfileFeedbackPayload;
      if (!res.ok) throw new Error(payload.error ?? '도메인 피드백 통계 초기화 실패');

      const domainFeedback = applyDomainFeedbackPayload(payload, DEFAULT_FEEDBACK_CONFIG);
      setDomainFeedbackEnabled(domainFeedback.config.enabled);
      setDomainFeedbackMinSamples(
        domainFeedback.config.minSamples,
      );
      setDomainFeedbackMaxAdjustment(
        domainFeedback.config.maxAdjustment,
      );
      setDomainFeedbackSummary(domainFeedback.summary);
      setDomainFeedbackEntries(domainFeedback.entries);
      setSaved(false);
      toast.success('domain feedback 설정과 집계를 초기화했습니다');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '도메인 피드백 통계 초기화 실패');
    } finally {
      setResettingDomainFeedback(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* 추론 가중치 */}
      <Card className="glass-card">
        <CardHeader>
          <CardTitle>추론 가중치</CardTitle>
          <CardDescription>도메인 추론 Track A/B 파라미터 (합계 = 1.00)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{syncingProfile ? '기본 프로필 동기화 중...' : '기본 프로필 동기화됨'}</span>
            {profileId && <span className="font-mono">profile: {profileId.slice(0, 8)}…</span>}
          </div>
          <WeightSlider
            label="w_code (코드 분석)"
            value={wCode}
            onChange={(v) => {
              setWCode(v);
              setSaved(false);
            }}
          />
          <WeightSlider
            label="w_db (DB 스키마)"
            value={wDb}
            onChange={(v) => {
              setWDb(v);
              setSaved(false);
            }}
          />
          <WeightSlider
            label="w_msg (메시지/이벤트)"
            value={wMsg}
            onChange={(v) => {
              setWMsg(v);
              setSaved(false);
            }}
          />

          {/* 합계 표시 */}
          <div
            className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 text-sm',
              weightOk ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400',
            )}
          >
            <span className="font-semibold">합계:</span>
            <span className="font-mono">{weightSum.toFixed(2)}</span>
            {weightOk ? (
              <Check className="h-4 w-4 ml-auto" />
            ) : (
              <span className="ml-auto text-xs">합이 1.00이어야 합니다</span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="glass-card">
        <CardHeader>
          <CardTitle>Cross-Signal Validation</CardTitle>
          <CardDescription>교차 검증 활성화와 boost / penalty 계수를 조정합니다</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between rounded-lg border border-border/60 px-4 py-3">
            <div>
              <div className="text-sm font-medium text-foreground">교차 검증 활성화</div>
              <p className="text-xs text-muted-foreground">
                비활성화하면 multi-source boost와 contradiction penalty를 적용하지 않습니다
              </p>
            </div>
            <Switch
              checked={crossValidationEnabled}
              onCheckedChange={(checked) => {
                setCrossValidationEnabled(checked);
                setSaved(false);
              }}
            />
          </div>
          <WeightSlider
            label="boostFactor"
            value={crossValidationBoostFactor}
            onChange={(v) => {
              setCrossValidationBoostFactor(v);
              setSaved(false);
            }}
          />
          <WeightSlider
            label="penaltyFactor"
            value={crossValidationPenaltyFactor}
            onChange={(v) => {
              setCrossValidationPenaltyFactor(v);
              setSaved(false);
            }}
          />
          <p className="text-xs text-muted-foreground">
            현재 단일 contradiction penalty: {(1 - crossValidationPenaltyFactor).toFixed(2)}
          </p>
        </CardContent>
      </Card>

      <Card className="glass-card">
        <CardHeader>
          <CardTitle>Feedback Loop</CardTitle>
          <CardDescription>relation/domain feedback 설정, 요약, reset을 각각 독립적으로 관리합니다</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <FeedbackSection
            title="Relation Feedback"
            description="relation candidate 승인/거절 집계를 보고 confidence 보정 규칙을 조정합니다"
            enabled={relationFeedbackEnabled}
            minSamples={relationFeedbackMinSamples}
            maxAdjustment={relationFeedbackMaxAdjustment}
            summary={relationFeedbackSummary}
            entries={relationFeedbackEntries}
            testIdPrefix="relation-feedback"
            resetLabel="Relation reset"
            resetting={resettingRelationFeedback}
            syncingProfile={syncingProfile}
            emptyMessage="아직 누적된 relation feedback 집계가 없습니다."
            onEnabledChange={(checked) => {
              setRelationFeedbackEnabled(checked);
              setSaved(false);
            }}
            onMinSamplesChange={(value) => {
              setRelationFeedbackMinSamples(clamp(value, 1, 10000));
              setSaved(false);
            }}
            onMaxAdjustmentChange={(value) => {
              setRelationFeedbackMaxAdjustment(clamp(value, 0, 1));
              setSaved(false);
            }}
            onReset={() => void resetRelationFeedback()}
          />

          <FeedbackSection
            title="Domain Feedback"
            description="현재 공개 계약은 Track A domain candidate feedback 설정/집계만 다룹니다. queued/orchestrated parity는 여기서 보장하지 않습니다"
            enabled={domainFeedbackEnabled}
            minSamples={domainFeedbackMinSamples}
            maxAdjustment={domainFeedbackMaxAdjustment}
            summary={domainFeedbackSummary}
            entries={domainFeedbackEntries}
            testIdPrefix="domain-feedback"
            resetLabel="Domain reset"
            resetting={resettingDomainFeedback}
            syncingProfile={syncingProfile}
            emptyMessage="아직 누적된 domain feedback 집계가 없습니다."
            onEnabledChange={(checked) => {
              setDomainFeedbackEnabled(checked);
              setSaved(false);
            }}
            onMinSamplesChange={(value) => {
              setDomainFeedbackMinSamples(clamp(value, 1, 10000));
              setSaved(false);
            }}
            onMaxAdjustmentChange={(value) => {
              setDomainFeedbackMaxAdjustment(clamp(value, 0, 1));
              setSaved(false);
            }}
            onReset={() => void resetDomainFeedback()}
          />
        </CardContent>
      </Card>

      {/* 코드 추출 엔진 */}
      <Card className="glass-card">
        <CardHeader>
          <CardTitle>코드 시그널 엔진</CardTitle>
          <CardDescription>
            `modes: [code]` 실행 시 사용할 기본 코드 추출 엔진
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Select
            value={codeEngine}
            onValueChange={(value) => {
              setCodeEngine(normalizeCodeEngineMode(value));
              setSaved(false);
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="엔진 선택" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hybrid">Hybrid (AST + Regex 병합, 기본)</SelectItem>
              <SelectItem value="ast">AST 우선 + Regex fallback</SelectItem>
              <SelectItem value="regex">Regex only</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            저장 후 관계 추론 실행 시 요청 본문 `codeEngine`에 적용됩니다.
          </p>
        </CardContent>
      </Card>

      {/* Rollup 파라미터 */}
      <Card className="glass-card">
        <CardHeader>
          <CardTitle>Roll-up 파라미터</CardTitle>
          <CardDescription>그래프 집계 및 클러스터링 설정</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Hub Threshold */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-foreground">
                Hub Threshold (in-degree)
              </label>
              <span className="text-xs text-muted-foreground">범위: 5 ~ 500</span>
            </div>
            <div className="flex gap-3 items-center">
              <input
                type="range"
                min={5}
                max={500}
                step={5}
                value={hubThreshold}
                onChange={(e) => {
                  setHubThreshold(Number(e.target.value));
                  setSaved(false);
                }}
                className="flex-1 accent-primary cursor-pointer"
              />
              <input
                type="number"
                min={5}
                max={500}
                value={hubThreshold}
                onChange={(e) => {
                  setHubThreshold(clamp(Number(e.target.value), 5, 500));
                  setSaved(false);
                }}
                className="w-20 rounded-md border border-input bg-background px-2 py-1 text-sm text-center"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              in-degree가 이 값 이상인 노드를 Hub로 분류합니다
            </p>
          </div>

          {/* Min Cluster Size */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-foreground">
                Min Cluster Size (Louvain)
              </label>
              <span className="text-xs text-muted-foreground">범위: 2 ~ 50</span>
            </div>
            <div className="flex gap-3 items-center">
              <input
                type="range"
                min={2}
                max={50}
                step={1}
                value={minCluster}
                onChange={(e) => {
                  setMinCluster(Number(e.target.value));
                  setSaved(false);
                }}
                className="flex-1 accent-primary cursor-pointer"
              />
              <input
                type="number"
                min={2}
                max={50}
                value={minCluster}
                onChange={(e) => {
                  setMinCluster(clamp(Number(e.target.value), 2, 50));
                  setSaved(false);
                }}
                className="w-20 rounded-md border border-input bg-background px-2 py-1 text-sm text-center"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Louvain 알고리즘에서 유효한 클러스터의 최소 크기
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 저장 버튼 */}
      <Button
        onClick={() => void save()}
        className="w-full sm:w-auto"
        disabled={!weightOk || savingProfile || syncingProfile}
      >
        {saved ? (
          <>
            <Check className="h-4 w-4 mr-1.5" />
            저장됨
          </>
        ) : savingProfile ? (
          '저장 중...'
        ) : (
          '설정 저장'
        )}
      </Button>
    </div>
  );
}

function FeedbackSection({
  title,
  description,
  enabled,
  minSamples,
  maxAdjustment,
  summary,
  entries,
  testIdPrefix,
  resetLabel,
  resetting,
  syncingProfile,
  emptyMessage,
  onEnabledChange,
  onMinSamplesChange,
  onMaxAdjustmentChange,
  onReset,
}: {
  title: string;
  description: string;
  enabled: boolean;
  minSamples: number;
  maxAdjustment: number;
  summary: FeedbackSummary;
  entries: FeedbackEntry[];
  testIdPrefix: string;
  resetLabel: string;
  resetting: boolean;
  syncingProfile: boolean;
  emptyMessage: string;
  onEnabledChange: (checked: boolean) => void;
  onMinSamplesChange: (value: number) => void;
  onMaxAdjustmentChange: (value: number) => void;
  onReset: () => void;
}) {
  return (
    <div
      className="space-y-5 rounded-xl border border-border/60 px-4 py-4"
      data-testid={`${testIdPrefix}-section`}
    >
      <div className="space-y-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>

      <div className="flex items-center justify-between rounded-lg border border-border/60 px-4 py-3">
        <div>
          <div className="text-sm font-medium text-foreground">피드백 보정 활성화</div>
          <p className="text-xs text-muted-foreground">
            집계는 유지하고 다음 run의 보정 적용 여부만 제어합니다
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={onEnabledChange} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground" htmlFor={`${testIdPrefix}-min-samples`}>
            최소 샘플 수
          </label>
          <Input
            id={`${testIdPrefix}-min-samples`}
            type="number"
            min={1}
            max={10000}
            value={minSamples}
            onChange={(event) => onMinSamplesChange(Number(event.target.value))}
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground" htmlFor={`${testIdPrefix}-max-adjustment`}>
            최대 보정치
          </label>
          <Input
            id={`${testIdPrefix}-max-adjustment`}
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={maxAdjustment}
            onChange={(event) => onMaxAdjustmentChange(Number(event.target.value))}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-border/60 px-3 py-2">
          <div className="text-xs text-muted-foreground">총 key</div>
          <div className="text-lg font-semibold">{summary.totalKeys}</div>
        </div>
        <div className="rounded-lg border border-border/60 px-3 py-2">
          <div className="text-xs text-muted-foreground">보정 가능 key</div>
          <div className="text-lg font-semibold">{summary.eligibleKeys}</div>
        </div>
        <div className="rounded-lg border border-border/60 px-3 py-2">
          <div className="text-xs text-muted-foreground">승인 / 거절</div>
          <div className="text-lg font-semibold">
            {summary.approvedCount} / {summary.rejectedCount}
          </div>
        </div>
        <div className="rounded-lg border border-border/60 px-3 py-2">
          <div className="text-xs text-muted-foreground">총 샘플</div>
          <div className="text-lg font-semibold">{summary.totalSamples}</div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-foreground">집계 요약</div>
          <Button
            type="button"
            variant="outline"
            onClick={onReset}
            disabled={resetting || syncingProfile}
          >
            {resetting ? '초기화 중...' : resetLabel}
          </Button>
        </div>
        {summary.totalSamples === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 px-4 py-6 text-sm text-muted-foreground">
            {emptyMessage}
          </div>
        ) : entries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 px-4 py-6 text-sm text-muted-foreground">
            key별 상세 통계가 아직 내려오지 않았습니다.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border/60">
            <table
              className="w-full border-collapse text-sm"
              data-testid={`${testIdPrefix}-detail-table`}
            >
              <thead className="bg-muted/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Key</th>
                  <th className="px-3 py-2 font-medium">승인 / 거절</th>
                  <th className="px-3 py-2 font-medium">승인률</th>
                  <th className="px-3 py-2 font-medium">보정치</th>
                  <th className="px-3 py-2 font-medium">상태</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const status = getFeedbackEntryStatus(entry, minSamples);
                  return (
                    <tr key={entry.key} className="border-t border-border/60">
                      <td className="px-3 py-2 font-mono text-xs text-foreground">{entry.key}</td>
                      <td className="px-3 py-2 text-foreground">
                        {entry.approved} / {entry.rejected}
                      </td>
                      <td className="px-3 py-2 text-foreground">{formatPercent(entry.approvalRate)}</td>
                      <td className="px-3 py-2 text-foreground">
                        {formatSignedPercentPoints(entry.adjustment)}
                      </td>
                      <td className="px-3 py-2">
                        <span className="rounded-full border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">
                          {status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── 가중치 슬라이더 (재사용 컴포넌트) ─── */
function WeightSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const clampWeight = (v: number) =>
    Math.round(Math.max(0, Math.min(1, isNaN(v) ? 0 : v)) * 100) / 100;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-foreground">{label}</label>
        <span className="text-xs text-muted-foreground">0.00 ~ 1.00</span>
      </div>
      <div className="flex gap-3 items-center">
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="flex-1 accent-primary cursor-pointer"
        />
        <input
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={value}
          onChange={(e) => onChange(clampWeight(parseFloat(e.target.value)))}
          className="w-20 rounded-md border border-input bg-background px-2 py-1 text-sm text-center font-mono"
        />
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   코드 스캔 설정
   ════════════════════════════════════════════════════════════════ */

/** 스캔 모드 옵션 */
const SCAN_MODES = [
  {
    value: 'workspace-dir' as const,
    label: '워크스페이스 폴더',
    description: '폴더 하위의 모든 프로젝트를 자동 감지합니다',
    icon: FolderSearch,
    placeholder: '/path/to/workspace',
  },
  {
    value: 'github-org' as const,
    label: 'GitHub Org',
    description: 'Organization의 모든 레포를 스캔합니다',
    icon: Building,
    placeholder: 'my-organization',
  },
  {
    value: 'local' as const,
    label: '로컬 디렉토리',
    description: '단일 프로젝트 폴더를 스캔합니다',
    icon: FolderSearch,
    placeholder: '/path/to/your-project',
  },
  {
    value: 'github-repo' as const,
    label: 'GitHub 레포',
    description: '단일 GitHub 레포를 클론하여 스캔합니다',
    icon: Github,
    placeholder: 'owner/repo',
  },
] as const;

/** 스캔 결과 프로젝트 타입 */
interface ScanProjectResult {
  name: string;
  path: string;
  language: string;
  markerFile: string;
}

/** 스캔 API 응답 타입 */
interface ScanApiResult {
  mode: string;
  target: string;
  projects: ScanProjectResult[];
  registered: number;
  skipped: number;
  bootstrap?: {
    analyzedProjectCount: number;
    signalCount: number;
    candidateCount: number;
    createdEndpointCount: number;
    createdAtomicCount: number;
    warnings: string[];
  };
}

/** SSE 스트림에서 서버가 보내는 이벤트 형식 */
type ScanStreamEvent =
  | { type: 'start'; total: number }
  | { type: 'progress'; current: number; total: number; message: string }
  | { type: 'complete'; result: ScanApiResult }
  | { type: 'error'; message: string };

/** 디렉토리 자동완성 항목 */
interface DirSuggestion {
  name: string;
  path: string;
}

export function ScanSettings({ workspaceId }: { workspaceId: string }) {
  const [mode, setMode] = useState<'local' | 'workspace-dir' | 'github-repo' | 'github-org'>(
    'workspace-dir',
  );
  const [target, setTarget] = useState('');
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanApiResult | null>(null);
  // 스캔 진행 상태 (모달 표시용)
  const [progress, setProgress] = useState(0);           // 0~100
  const [progressMessage, setProgressMessage] = useState('');
  const [progressTotal, setProgressTotal] = useState(0); // 총 레포 수

  // 자동완성 관련 상태
  const [suggestions, setSuggestions] = useState<DirSuggestion[]>([]);
  const [savedPaths, setSavedPaths] = useState<string[]>([]);
  const [savedParentDirs, setSavedParentDirs] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedMode = SCAN_MODES.find((m) => m.value === mode)!;
  const isGithub = mode === 'github-repo' || mode === 'github-org';

  // 워크스페이스의 기존 스캔 경로 로드 + 기본값 복원
  useEffect(() => {
    if (!workspaceId) return;
    fetch(`/api/scan/paths?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((res) => res.json())
      .then((data: { paths?: string[]; parentDirs?: string[] }) => {
        const paths = data.paths ?? [];
        const parents = data.parentDirs ?? [];
        setSavedPaths(paths);
        setSavedParentDirs(parents);
        // 기존 스캔 경로가 있으면 가장 첫 번째 부모 디렉토리를 기본값으로 설정
        const first = parents[0];
        if (first && !target) {
          setTarget(first);
        }
      })
      .catch(() => { /* 실패 시 무시 */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // 디렉토리 자동완성 fetch (로컬 모드 전용)
  const fetchSuggestions = useCallback((prefix: string) => {
    if (!prefix || !isAbsoluteScanPathPrefix(prefix)) {
      setSuggestions([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/fs/browse?prefix=${encodeURIComponent(prefix)}`);
        const data = (await res.json()) as { dirs?: DirSuggestion[] };
        setSuggestions(data.dirs ?? []);
      } catch {
        setSuggestions([]);
      }
    }, 200);
  }, []);

  // 외부 클릭 시 드롭다운 닫기
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // 자동완성 항목 선택 핸들러
  const selectSuggestion = (path: string) => {
    setTarget(path);
    setResult(null);
    setShowSuggestions(false);
    setSelectedIdx(-1);
    inputRef.current?.focus();
  };

  // 현재 모드가 로컬(파일시스템) 인지
  const isLocalMode = mode === 'local' || mode === 'workspace-dir';

  // 드롭다운에 표시할 항목 조합: 등록된 경로 + 자동완성 디렉토리
  const combinedSuggestions = (() => {
    if (!isLocalMode) return [];
    const items: Array<{ type: 'saved' | 'dir'; label: string; path: string }> = [];

    // 등록된 경로 (target이 비어있거나 매칭되는 것만)
    const relevantPaths = mode === 'workspace-dir' ? savedParentDirs : savedPaths;
    for (const p of relevantPaths) {
      if (!target || p.toLowerCase().includes(target.toLowerCase())) {
        items.push({ type: 'saved', label: p, path: p });
      }
    }

    // 자동완성 디렉토리 (등록된 경로와 중복 제거)
    const savedSet = new Set(items.map((i) => i.path));
    for (const dir of suggestions) {
      if (!savedSet.has(dir.path)) {
        items.push({ type: 'dir', label: dir.name, path: dir.path });
      }
    }
    return items;
  })();

  /** 스캔 실행 (SSE 스트리밍으로 진행 상황 수신) */
  const executeScan = async (dryRun: boolean) => {
    if (!target.trim()) {
      toast.error('스캔 대상을 입력하세요');
      return;
    }

    setScanning(true);
    setResult(null);
    setProgress(0);
    setProgressMessage('연결 중...');
    setProgressTotal(0);

    // 브라우저 새로고침 / 탭 닫기 방지
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, mode, target: target.trim(), dryRun }),
      });

      // HTTP 에러 (스트림 시작 전)
      if (!res.ok || !res.body) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `스캔 실패 (${res.status})`);
      }

      // SSE 스트림 읽기
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalResult: ScanApiResult | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // 청크를 줄 단위로 분리해서 이벤트 파싱
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // 마지막 불완전 줄은 다음 청크와 합침

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          let event: ScanStreamEvent;
          try {
            event = JSON.parse(line.slice(6)) as ScanStreamEvent;
          } catch {
            continue; // 불완전한 JSON 청크 무시
          }

          if (event.type === 'start') {
            setProgressTotal(event.total);
            setProgressMessage(
              event.total > 0 ? `0 / ${event.total} 처리 중...` : '스캔 시작...',
            );
          } else if (event.type === 'progress') {
            const pct = event.total > 0 ? (event.current / event.total) * 100 : 50;
            setProgress(pct);
            setProgressMessage(event.message);
          } else if (event.type === 'complete') {
            setProgress(100);
            setProgressMessage('완료!');
            finalResult = event.result;
          } else if (event.type === 'error') {
            throw new Error(event.message);
          }
        }
      }

      if (finalResult) {
        setResult(finalResult);
        if (dryRun) {
          toast.success(`${finalResult.projects.length}개 프로젝트 발견 (미리보기)`);
        } else {
          const bootstrapSuffix = finalResult.bootstrap && finalResult.bootstrap.createdAtomicCount > 0
            ? `, 원자 오브젝트 ${finalResult.bootstrap.createdAtomicCount}개 bootstrap`
            : '';
          toast.success(
            `${finalResult.registered}개 등록, ${finalResult.skipped}개 스킵${bootstrapSuffix}`,
          );
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '스캔 실패');
    } finally {
      setScanning(false);
      setProgress(0);
      setProgressMessage('');
      window.removeEventListener('beforeunload', handleBeforeUnload);
    }
  };

  /** 언어 색상 매핑 */
  const langColor = (lang: string): string => {
    switch (lang) {
      case 'node': return 'text-green-400';
      case 'java': return 'text-orange-400';
      case 'kotlin': return 'text-purple-400';
      case 'python': return 'text-blue-400';
      case 'go': return 'text-cyan-400';
      case 'rust': return 'text-red-400';
      default: return 'text-muted-foreground';
    }
  };

  return (
    <>
    {/* ── 스캔 진행 모달 (블로킹 오버레이) ── */}
    {scanning && (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm">
        <div className="w-full max-w-sm mx-4 rounded-2xl border border-border bg-card/95 p-6 shadow-2xl">
          {/* 헤더 */}
          <div className="flex items-center gap-3 mb-5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/20">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">스캔 중...</p>
              <p className="truncate text-xs text-muted-foreground">{target}</p>
            </div>
          </div>

          {/* 진행률 바 */}
          <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>

          {/* 진행 텍스트 */}
          <div className="mb-5 flex items-center justify-between text-xs text-muted-foreground">
            <span className="mr-2 truncate">{progressMessage || '처리 중...'}</span>
            {progressTotal > 0 && (
              <span className="shrink-0 tabular-nums">{Math.round(progress)}%</span>
            )}
          </div>

          {/* 안내 문구 */}
          <p className="text-center text-[11px] text-muted-foreground/60">
            스캔이 완료될 때까지 페이지를 닫거나 이동하지 마세요
          </p>
        </div>
      </div>
    )}

    <div className="space-y-4">
      {/* 모드 선택 */}
      <Card className="glass-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScanLine className="h-4 w-4 text-primary" />
            코드 스캔
          </CardTitle>
          <CardDescription>프로젝트를 탐색하여 서비스 Object로 자동 등록합니다</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 모드 라디오 카드 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {SCAN_MODES.map((m) => {
              const Icon = m.icon;
              const isActive = mode === m.value;
              return (
                <button
                  key={m.value}
                  onClick={() => { setMode(m.value); setResult(null); }}
                  className={cn(
                    'relative flex items-start gap-3 rounded-xl p-3 text-left transition-all glass-card',
                    isActive
                      ? 'border-primary bg-primary/10 ring-2 ring-primary'
                      : 'opacity-60 hover:opacity-90',
                  )}
                >
                  {isActive && (
                    <CheckCircle2 className="absolute top-2 right-2 h-4 w-4 text-primary" />
                  )}
                  <Icon className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
                  <div>
                    <div className="text-sm font-medium text-foreground">{m.label}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{m.description}</div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* GitHub 모드 안내 */}
          {isGithub && (
            <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
              <Github className="h-4 w-4 shrink-0" />
              gh CLI 로그인이 필요합니다 (gh auth login)
            </div>
          )}

          {/* 대상 입력 — 로컬 모드: 자동완성 드롭다운 포함 */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              스캔 대상
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Input
                  ref={inputRef}
                  placeholder={selectedMode.placeholder}
                  value={target}
                  onChange={(e) => {
                    const val = e.target.value;
                    setTarget(val);
                    setResult(null);
                    setSelectedIdx(-1);
                    if (isLocalMode) {
                      fetchSuggestions(val);
                      setShowSuggestions(true);
                    }
                  }}
                  onFocus={() => {
                    if (isLocalMode) setShowSuggestions(true);
                  }}
                  onKeyDown={(e) => {
                    // 드롭다운 키보드 네비게이션
                    if (showSuggestions && combinedSuggestions.length > 0) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setSelectedIdx((prev) =>
                          prev < combinedSuggestions.length - 1 ? prev + 1 : 0,
                        );
                        return;
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setSelectedIdx((prev) =>
                          prev > 0 ? prev - 1 : combinedSuggestions.length - 1,
                        );
                        return;
                      }
                      if (e.key === 'Enter' && selectedIdx >= 0) {
                        e.preventDefault();
                        const sel = combinedSuggestions[selectedIdx];
                        if (sel) selectSuggestion(sel.path);
                        return;
                      }
                      if (e.key === 'Escape') {
                        setShowSuggestions(false);
                        return;
                      }
                    }
                    if (e.key === 'Enter') void executeScan(true);
                  }}
                />

                {/* 자동완성 드롭다운 */}
                {showSuggestions && isLocalMode && combinedSuggestions.length > 0 && (
                  <div
                    ref={suggestionsRef}
                    className="absolute z-50 top-full left-0 right-0 mt-1 max-h-60 overflow-y-auto rounded-lg border border-border bg-card shadow-lg"
                  >
                    {/* 등록된 경로 섹션 */}
                    {combinedSuggestions.some((s) => s.type === 'saved') && (
                      <>
                        <div className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wider bg-muted/30">
                          <History className="inline h-3 w-3 mr-1 -mt-0.5" />
                          최근 스캔 경로
                        </div>
                        {combinedSuggestions
                          .filter((s) => s.type === 'saved')
                          .map((item, i) => {
                            const globalIdx = combinedSuggestions.indexOf(item);
                            return (
                              <button
                                key={`saved-${item.path}`}
                                type="button"
                                className={cn(
                                  'w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-accent/50 transition-colors',
                                  globalIdx === selectedIdx && 'bg-accent/50',
                                )}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => selectSuggestion(item.path)}
                              >
                                <History className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                <span className="truncate text-foreground">{item.path}</span>
                              </button>
                            );
                          })}
                      </>
                    )}

                    {/* 디렉토리 후보 섹션 */}
                    {combinedSuggestions.some((s) => s.type === 'dir') && (
                      <>
                        <div className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wider bg-muted/30">
                          <FolderOpen className="inline h-3 w-3 mr-1 -mt-0.5" />
                          디렉토리
                        </div>
                        {combinedSuggestions
                          .filter((s) => s.type === 'dir')
                          .map((item) => {
                            const globalIdx = combinedSuggestions.indexOf(item);
                            return (
                              <button
                                key={`dir-${item.path}`}
                                type="button"
                                className={cn(
                                  'w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-accent/50 transition-colors',
                                  globalIdx === selectedIdx && 'bg-accent/50',
                                )}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => selectSuggestion(item.path)}
                              >
                                <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                <span className="truncate text-foreground">{item.label}</span>
                                <ChevronRight className="h-3 w-3 text-muted-foreground ml-auto shrink-0" />
                              </button>
                            );
                          })}
                      </>
                    )}
                  </div>
                )}
              </div>
              {isLocalMode && (
                <PathPickerDialog
                  value={target}
                  onSelect={selectSuggestion}
                  disabled={scanning}
                  triggerLabel="폴더 선택"
                  title="스캔 대상 폴더 선택"
                  description="로컬 파일시스템을 탐색해 스캔 대상을 선택합니다."
                  {...(savedParentDirs[0] ? { fallbackPath: savedParentDirs[0] } : {})}
                />
              )}
            </div>
          </div>

          {/* 버튼 */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => void executeScan(true)}
              disabled={scanning || !target.trim()}
            >
              {scanning ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Eye className="h-4 w-4 mr-1.5" />}
              미리보기 (Dry-run)
            </Button>
            <Button
              onClick={() => void executeScan(false)}
              disabled={scanning || !target.trim()}
            >
              {scanning ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <ScanLine className="h-4 w-4 mr-1.5" />}
              스캔 시작
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 스캔 결과 */}
      {result && (
        <Card className="glass-card">
          <CardHeader>
            <CardTitle className="text-sm">
              스캔 결과 — {result.projects.length}개 프로젝트
            </CardTitle>
            <CardDescription>
              등록: {result.registered}개 / 스킵: {result.skipped}개
            </CardDescription>
          </CardHeader>
          <CardContent>
            {result.projects.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                프로젝트를 찾지 못했습니다. 경로를 확인해주세요.
              </p>
            ) : (
              <div className="space-y-2">
                {result.projects.map((proj, i) => (
                  <div
                    key={`${proj.name}-${i}`}
                    className="flex items-center gap-3 rounded-lg border border-border/50 px-3 py-2.5"
                  >
                    {/* 등록/스킵 아이콘 */}
                    {result.registered > 0 && i < result.registered ? (
                      <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" />
                    ) : (
                      <SkipForward className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}

                    {/* 프로젝트 정보 */}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">
                        {proj.name}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">{proj.path}</div>
                    </div>

                    {/* 언어 태그 */}
                    <span className={cn('text-xs font-mono shrink-0', langColor(proj.language))}>
                      {proj.language}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
    </>
  );
}
