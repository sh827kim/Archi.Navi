/**
 * Object 목록 — 클라이언트 컴포넌트
 * - 타입별 탭 (전체 | Service | Database | Broker | API | Domain)
 * - 카드/리스트 뷰 토글 + 검색
 * - 클릭 → 우측 상세 Sheet (Inbound/Outbound 관계, 자식 목록)
 * - Edit Mode: visibility 토글, 삭제
 * - 수동 Object 등록 다이얼로그
 */
'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import {
  Search,
  LayoutGrid,
  List,
  Server,
  Database,
  Radio,
  Globe,
  Box,
  Plus,
  Loader2,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
  ChevronRight,
  ArrowRight,
  ArrowLeft,
  CheckCheck,
  Download,
  Check,
  X,
  Tag,
} from 'lucide-react';
import {
  cn,
  Badge,
  Input,
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
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  ConfirmDialog,
} from '@archi-navi/ui';
import { toast } from 'sonner';
import { useWorkspace } from '@/contexts/workspace-context';

/* ─── 타입 ─── */
interface ObjectItem {
  id: string;
  name: string;
  displayName: string | null;
  objectType: string;
  granularity: string;
  visibility: string;
  parentId: string | null;
  depth: number;
}

interface RelationDetail {
  id: string;
  relationType: string;
  targetId?: string;
  targetName?: string;
  targetType?: string;
  sourceId?: string;
  sourceName?: string;
  sourceType?: string;
}

interface ObjectDetail extends ObjectItem {
  description: string | null;
  outbound: RelationDetail[];
  inbound: RelationDetail[];
  children: ObjectItem[];
}

/** 태그 정보 */
interface TagInfo {
  id: string;
  name: string;
  color: string | null;
}

/** objectType → 아이콘 + 색상 맵핑 */
const TYPE_CONFIG: Record<string, { icon: typeof Server; color: string; label: string }> = {
  service:        { icon: Server,   color: '#3b82f6', label: 'Service'   },
  api_endpoint:   { icon: Globe,    color: '#8b5cf6', label: 'API'       },
  database:       { icon: Database, color: '#10b981', label: 'Database'  },
  kafka_topic:    { icon: Radio,    color: '#f59e0b', label: 'Kafka'     },
  message_broker: { icon: Radio,    color: '#f59e0b', label: 'Broker'    },
  domain:         { icon: Box,      color: '#06b6d4', label: 'Domain'    },
};

function getConfig(type: string) {
  return TYPE_CONFIG[type] ?? { icon: Box, color: '#6b7280', label: type };
}

/** 관계 타입 → Badge 색상 */
const RELATION_COLORS: Record<string, string> = {
  call:       'bg-blue-500/15 text-blue-400',
  expose:     'bg-purple-500/15 text-purple-400',
  read:       'bg-green-500/15 text-green-400',
  write:      'bg-green-500/15 text-green-400',
  produce:    'bg-amber-500/15 text-amber-400',
  consume:    'bg-amber-500/15 text-amber-400',
  depend_on:  'bg-gray-500/15 text-gray-400',
};

/** 탭 목록 */
const TABS = [
  { value: 'all',            label: '전체'     },
  { value: 'service',        label: 'Service'  },
  { value: 'database',       label: 'Database' },
  { value: 'message_broker', label: 'Broker'   },
  { value: 'api_endpoint',   label: 'API'      },
  { value: 'domain',         label: 'Domain'   },
] as const;

const EMPTY_FORM = { objectType: 'service', name: '', displayName: '' };

/* ════════════════════════════════════════════════════════════════
   Object 등록 다이얼로그
   ════════════════════════════════════════════════════════════════ */
function AddObjectDialog({
  open, onOpenChange, workspaceId, onSuccess,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspaceId: string;
  onSuccess: () => void;
}) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) setForm(EMPTY_FORM); }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { toast.error('Object 이름을 입력하세요'); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/objects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, objectType: form.objectType, name: form.name.trim(), displayName: form.displayName.trim() || null, granularity: 'ATOMIC' }),
      });
      if (!res.ok) throw new Error();
      toast.success(`"${form.name}" 등록됨`);
      onOpenChange(false);
      onSuccess();
    } catch { toast.error('Object 등록 실패'); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Object 등록</DialogTitle></DialogHeader>
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Object 타입</label>
            <Select value={form.objectType} onValueChange={(val) => setForm((f) => ({ ...f, objectType: val }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="service">Service</SelectItem>
                <SelectItem value="api_endpoint">API Endpoint</SelectItem>
                <SelectItem value="database">Database</SelectItem>
                <SelectItem value="kafka_topic">Kafka Topic</SelectItem>
                <SelectItem value="message_broker">Message Broker</SelectItem>
                <SelectItem value="domain">Domain</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">이름 <span className="text-destructive">*</span></label>
            <Input placeholder="예: order-service, user-db" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus />
            <p className="text-xs text-muted-foreground">기술적 식별자 (소문자-하이픈 권장)</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">표시 이름 <span className="text-muted-foreground text-xs">(선택)</span></label>
            <Input placeholder="예: 주문 서비스" value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>취소</Button>
            <Button type="submit" disabled={saving || !form.name.trim()}>
              {saving ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />등록 중...</> : <><Plus className="h-4 w-4 mr-1.5" />등록</>}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ════════════════════════════════════════════════════════════════
   인라인 편집 필드 (displayName / description)
   ════════════════════════════════════════════════════════════════ */
function InlineEditField({
  value,
  placeholder,
  onSave,
  multiline = false,
}: {
  value: string;
  placeholder: string;
  onSave: (newVal: string) => Promise<void>;
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setDraft(value); }, [value]);

  const commit = async () => {
    if (draft === value) { setEditing(false); return; }
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } catch { /* 에러는 상위에서 처리 */ }
    finally { setSaving(false); }
  };

  const cancel = () => { setDraft(value); setEditing(false); };

  if (!editing) {
    return (
      <div
        className="group flex items-center gap-1.5 cursor-pointer rounded-md px-1 -mx-1 hover:bg-muted/30 transition-colors"
        onClick={() => setEditing(true)}
      >
        <span className={cn('text-sm', value ? 'text-foreground' : 'text-muted-foreground italic')}>
          {value || placeholder}
        </span>
        <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
      </div>
    );
  }

  /* 편집 모드 */
  const InputEl = multiline ? 'textarea' : 'input';
  return (
    <div className="flex items-start gap-1">
      <InputEl
        className={cn(
          'flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary',
          multiline && 'min-h-[60px] resize-y',
        )}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !multiline) void commit();
          if (e.key === 'Escape') cancel();
        }}
        autoFocus
        placeholder={placeholder}
      />
      <button
        onClick={() => void commit()}
        disabled={saving}
        className="rounded p-1 text-green-400 hover:bg-green-500/10 transition-colors"
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
      </button>
      <button onClick={cancel} className="rounded p-1 text-muted-foreground hover:bg-muted/50 transition-colors">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   Object 상세 Sheet 패널
   ════════════════════════════════════════════════════════════════ */
function ObjectDetailSheet({
  objectId, workspaceId, open, onOpenChange, onUpdate,
}: {
  objectId: string | null;
  workspaceId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onUpdate?: () => void;
}) {
  const [detail, setDetail] = useState<ObjectDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [objectTags, setObjectTags] = useState<TagInfo[]>([]);
  const [allTags, setAllTags] = useState<TagInfo[]>([]);
  const [showTagPicker, setShowTagPicker] = useState(false);

  const loadDetail = useCallback(async () => {
    if (!objectId || !open) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/objects/${objectId}?workspaceId=${workspaceId}`);
      const data = (await res.json()) as ObjectDetail;
      setDetail(data);
    } catch {
      toast.error('상세 정보 로드 실패');
    } finally {
      setLoading(false);
    }
  }, [objectId, workspaceId, open]);

  /* Object 상세 로드 */
  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  /* 태그 로드 (Object 태그 + 전체 태그) */
  useEffect(() => {
    if (!objectId || !open) return;
    // Object에 달린 태그
    fetch(`/api/objects/${objectId}/tags?workspaceId=${workspaceId}`)
      .then((r) => r.json())
      .then((data: TagInfo[]) => setObjectTags(data))
      .catch(() => { /* 태그 로드 실패 무시 */ });
    // 전체 태그 목록 (Picker용)
    fetch(`/api/tags?workspaceId=${workspaceId}`)
      .then((r) => r.json())
      .then((data: TagInfo[]) => setAllTags(data))
      .catch(() => { /* 태그 로드 실패 무시 */ });
  }, [objectId, workspaceId, open]);

  if (!open) return null;

  const config = detail ? getConfig(detail.objectType) : null;
  const Icon = config?.icon ?? Box;
  const outboundVisible = detail?.outbound.filter((r) => r.relationType !== 'expose') ?? [];

  /* 인라인 필드 저장 핸들러 */
  const saveField = async (field: string, value: string) => {
    if (!detail) return;
    const res = await fetch(`/api/objects/${detail.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, [field]: value || null }),
    });
    if (!res.ok) { toast.error('저장 실패'); throw new Error(); }
    // 로컬 상태 업데이트
    setDetail((prev) => prev ? { ...prev, [field]: value || null } : prev);
    toast.success('저장됨');
    onUpdate?.();
  };

  /* 태그 추가/제거 */
  const addTag = async (tagId: string) => {
    if (!objectId) return;
    const res = await fetch(`/api/objects/${objectId}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, tagId }),
    });
    if (res.ok) {
      const added = allTags.find((t) => t.id === tagId);
      if (added) setObjectTags((prev) => [...prev, added]);
      setShowTagPicker(false);
    }
  };

  const removeTag = async (tagId: string) => {
    if (!objectId) return;
    const res = await fetch(`/api/objects/${objectId}/tags`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, tagId }),
    });
    if (res.ok) {
      setObjectTags((prev) => prev.filter((t) => t.id !== tagId));
    }
  };

  // Picker에서 이미 달린 태그 제외
  const availableTags = allTags.filter(
    (t) => !objectTags.some((ot) => ot.id === t.id),
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader className="pr-8">
          <SheetTitle className="sr-only">
            {detail ? `${detail.displayName ?? detail.name} 상세 정보` : 'Object 상세 정보'}
          </SheetTitle>
          {detail && config && (
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg shrink-0" style={{ backgroundColor: `${config.color}20` }}>
                <Icon className="h-5 w-5" style={{ color: config.color }} />
              </div>
              <div className="flex-1 min-w-0">
                {/* displayName 인라인 편집 */}
                <InlineEditField
                  value={detail.displayName ?? ''}
                  placeholder="표시 이름 입력..."
                  onSave={(v) => saveField('displayName', v)}
                />
                <p className="text-xs text-muted-foreground font-mono mt-0.5">{detail.name}</p>
              </div>
            </div>
          )}
        </SheetHeader>

        {loading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {!loading && detail && (
          <div className="px-6 py-4 space-y-6">
            {/* 설명 (인라인 편집) */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">설명</h3>
              <InlineEditField
                value={detail.description ?? ''}
                placeholder="설명을 입력하세요..."
                onSave={(v) => saveField('description', v)}
                multiline
              />
            </section>

            {/* 태그 */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Tag className="h-3.5 w-3.5" />
                태그
              </h3>
              <div className="flex items-center gap-1.5 flex-wrap">
                {objectTags.map((tag) => (
                  <span
                    key={tag.id}
                    className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium text-white"
                    style={{ backgroundColor: tag.color ?? '#6b7280' }}
                  >
                    {tag.name}
                    <button
                      onClick={() => void removeTag(tag.id)}
                      className="hover:bg-white/20 rounded-full p-0.5 transition-colors"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
                {/* 태그 추가 버튼 */}
                <button
                  onClick={() => setShowTagPicker((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                >
                  <Plus className="h-3 w-3" />
                  태그 추가
                </button>
              </div>
              {/* 태그 Picker */}
              {showTagPicker && (
                <div className="rounded-lg border border-border bg-background p-2 space-y-1 max-h-40 overflow-y-auto">
                  {availableTags.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-2">
                      추가할 태그가 없습니다. 설정에서 태그를 생성하세요.
                    </p>
                  ) : (
                    availableTags.map((tag) => (
                      <button
                        key={tag.id}
                        onClick={() => void addTag(tag.id)}
                        className="flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-sm hover:bg-muted/50 transition-colors"
                      >
                        <div className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: tag.color ?? '#6b7280' }} />
                        <span className="text-foreground">{tag.name}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </section>

            {/* 기본 정보 */}
            <section className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">기본 정보</h3>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-lg bg-muted/30 px-3 py-2">
                  <p className="text-xs text-muted-foreground mb-0.5">타입</p>
                  <p className="font-medium text-foreground">{config?.label}</p>
                </div>
                <div className="rounded-lg bg-muted/30 px-3 py-2">
                  <p className="text-xs text-muted-foreground mb-0.5">Granularity</p>
                  <p className="font-medium text-foreground">{detail.granularity}</p>
                </div>
                <div className="rounded-lg bg-muted/30 px-3 py-2">
                  <p className="text-xs text-muted-foreground mb-0.5">가시성</p>
                  <button
                    className={cn(
                      'flex items-center gap-1.5 font-medium transition-colors hover:opacity-80',
                      detail.visibility === 'VISIBLE' ? 'text-green-400' : 'text-muted-foreground',
                    )}
                    onClick={async () => {
                      const next = detail.visibility === 'VISIBLE' ? 'HIDDEN' : 'VISIBLE';
                      await saveField('visibility', next);
                    }}
                    title="클릭하여 가시성 전환"
                  >
                    {detail.visibility === 'VISIBLE'
                      ? <Eye className="h-3.5 w-3.5" />
                      : <EyeOff className="h-3.5 w-3.5" />}
                    {detail.visibility}
                  </button>
                </div>
                <div className="rounded-lg bg-muted/30 px-3 py-2">
                  <p className="text-xs text-muted-foreground mb-0.5">Depth</p>
                  <p className="font-medium text-foreground">{detail.depth}</p>
                </div>
              </div>
            </section>

            {/* Outbound 관계 */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <ArrowRight className="h-3.5 w-3.5" />
                Outbound ({outboundVisible.length})
              </h3>
              {outboundVisible.length === 0 ? (
                <p className="text-xs text-muted-foreground">없음</p>
              ) : (
                <div className="space-y-1.5">
                  {outboundVisible.map((r) => {
                    const tc = getConfig(r.targetType ?? '');
                    const TIcon = tc.icon;
                    return (
                      <div key={r.id} className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2">
                        <TIcon className="h-3.5 w-3.5 shrink-0" style={{ color: tc.color }} />
                        <span className="flex-1 text-xs font-medium text-foreground truncate">{r.targetName}</span>
                        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium shrink-0', RELATION_COLORS[r.relationType] ?? 'bg-muted text-muted-foreground')}>
                          {r.relationType}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Inbound 관계 */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <ArrowLeft className="h-3.5 w-3.5" />
                Inbound ({detail.inbound.length})
              </h3>
              {detail.inbound.length === 0 ? (
                <p className="text-xs text-muted-foreground">없음</p>
              ) : (
                <div className="space-y-1.5">
                  {detail.inbound.map((r) => {
                    const sc = getConfig(r.sourceType ?? '');
                    const SIcon = sc.icon;
                    return (
                      <div key={r.id} className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2">
                        <SIcon className="h-3.5 w-3.5 shrink-0" style={{ color: sc.color }} />
                        <span className="flex-1 text-xs font-medium text-foreground truncate">{r.sourceName}</span>
                        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium shrink-0', RELATION_COLORS[r.relationType] ?? 'bg-muted text-muted-foreground')}>
                          {r.relationType}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* 자식 Object (COMPOUND인 경우) */}
            {detail.granularity === 'COMPOUND' && (
              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <ChevronRight className="h-3.5 w-3.5" />
                  하위 Object ({detail.children.length})
                </h3>
                {detail.children.length === 0 ? (
                  <p className="text-xs text-muted-foreground">없음</p>
                ) : (
                  <div className="space-y-1.5">
                    {detail.children.map((child) => {
                      const cc = getConfig(child.objectType);
                      const CIcon = cc.icon;
                      return (
                        <div key={child.id} className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2">
                          <CIcon className="h-3.5 w-3.5 shrink-0" style={{ color: cc.color }} />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-foreground truncate">{child.displayName ?? child.name}</p>
                            <p className="text-[10px] text-muted-foreground font-mono truncate">{child.name}</p>
                          </div>
                          <span className="text-[10px] text-muted-foreground">{cc.label}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/* ════════════════════════════════════════════════════════════════
   메인 컴포넌트
   ════════════════════════════════════════════════════════════════ */
export function ObjectListClient() {
  const { workspaceId } = useWorkspace();

  const [objects, setObjects] = useState<ObjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<string>('all');
  const [addOpen, setAddOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ObjectItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  /* ─── 데이터 로드 ─── */
  const loadObjects = useCallback(async () => {
    if (!workspaceId) {
      setObjects([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/objects?workspaceId=${workspaceId}`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as ObjectItem[];
      setObjects(data);
    } catch { console.error('[ObjectListClient] 로드 실패'); }
    finally { setLoading(false); }
  }, [workspaceId]);

  useEffect(() => { void loadObjects(); }, [loadObjects]);

  /* ─── Visibility 토글 ─── */
  const toggleVisibility = async (obj: ObjectItem) => {
    const next = obj.visibility === 'VISIBLE' ? 'HIDDEN' : 'VISIBLE';
    // 낙관적 업데이트
    setObjects((prev) => prev.map((o) => o.id === obj.id ? { ...o, visibility: next } : o));
    try {
      const res = await fetch(`/api/objects/${obj.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, visibility: next }),
      });
      if (!res.ok) throw new Error();
    } catch {
      toast.error('가시성 변경 실패');
      await loadObjects(); // 롤백
    }
  };

  /* ─── 삭제 ─── */
  const deleteObject = async (id: string) => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/objects/${id}?workspaceId=${workspaceId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      toast.success('Object 삭제됨');
      setDeleteTarget(null);
      await loadObjects();
    } catch { toast.error('삭제 실패'); }
    finally { setDeleting(false); }
  };

  /* ─── 카드 클릭 (상세 패널) ─── */
  const handleCardClick = (obj: ObjectItem) => {
    if (editMode) return; // 편집 모드에서는 상세 열지 않음
    setSelectedObjectId(obj.id);
    setDetailOpen(true);
  };

  /* ─── CSV 내보내기 ─── */
  const exportCsv = () => {
    if (filtered.length === 0) {
      toast.error('내보낼 Object가 없습니다');
      return;
    }
    // BOM 접두사 → 한글 Excel 호환
    const BOM = '\uFEFF';
    const header = ['name', 'displayName', 'objectType', 'granularity', 'visibility'];
    const rows = filtered.map((obj) =>
      header.map((key) => {
        const val = obj[key as keyof ObjectItem] ?? '';
        // 콤마·줄바꿈 포함 시 따옴표 감싸기
        const str = String(val);
        return str.includes(',') || str.includes('\n') || str.includes('"')
          ? `"${str.replace(/"/g, '""')}"`
          : str;
      }).join(','),
    );
    const csv = BOM + [header.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `archi-navi-objects-${date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`${filtered.length}개 Object를 CSV로 내보냈습니다`);
  };

  /* ─── 탭 + 검색 필터링 (루트 오브젝트만: depth=0) ─── */
  const filtered = useMemo(() => {
    // 탭에 따라 depth 기준 필터 여부 결정: API 탭이면 자식도 포함
    let list = activeTab === 'api_endpoint' ? objects : objects.filter((o) => o.depth === 0);
    if (activeTab !== 'all') {
      if (activeTab === 'message_broker') {
        list = list.filter((o) => o.objectType === 'message_broker' || o.objectType === 'kafka_topic');
      } else {
        list = list.filter((o) => o.objectType === activeTab);
      }
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((o) => o.name.toLowerCase().includes(q) || (o.displayName?.toLowerCase().includes(q) ?? false));
    }
    return list;
  }, [objects, activeTab, searchQuery]);

  /* ─── 탭별 카운트 ─── */
  const tabCount = useMemo(() => {
    const counts: Record<string, number> = { all: objects.filter((o) => o.depth === 0).length };
    for (const obj of objects) {
      // API 탭은 전체 api_endpoint 카운트
      if (obj.objectType === 'api_endpoint') {
        counts['api_endpoint'] = (counts['api_endpoint'] ?? 0) + 1;
      } else if (obj.depth === 0) {
        const key = obj.objectType === 'kafka_topic' ? 'message_broker' : obj.objectType;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    return counts;
  }, [objects]);

  /* ─── 카드 렌더 ─── */
  const renderCard = (obj: ObjectItem) => {
    const config = getConfig(obj.objectType);
    const Icon = config.icon;
    const isHidden = obj.visibility !== 'VISIBLE';

    return (
      <div
        key={obj.id}
        onClick={() => handleCardClick(obj)}
        className={cn(
          'glass-card rounded-xl p-4 transition-all relative group',
          !editMode && 'cursor-pointer hover:shadow-lg hover:ring-1 hover:ring-primary/30',
          isHidden && 'opacity-50',
        )}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg shrink-0" style={{ backgroundColor: `${config.color}20` }}>
            <Icon className="h-5 w-5" style={{ color: config.color }} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{obj.displayName ?? obj.name}</p>
            <p className="text-xs text-muted-foreground font-mono truncate mt-0.5">{obj.name}</p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="text-[10px]">{config.label}</Badge>
          {obj.granularity === 'COMPOUND' && <Badge variant="outline" className="text-[10px] text-primary border-primary/30">COMPOUND</Badge>}
          {isHidden && <Badge variant="outline" className="text-[10px] text-muted-foreground">HIDDEN</Badge>}
        </div>

        {/* 편집 모드 오버레이 */}
        {editMode && (
          <div className="absolute top-2 right-2 flex items-center gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); void toggleVisibility(obj); }}
              className={cn('rounded-md p-1.5 transition-colors', isHidden ? 'bg-muted/50 text-muted-foreground hover:text-foreground' : 'bg-primary/10 text-primary hover:bg-primary/20')}
              title={isHidden ? '표시' : '숨기기'}
            >
              {isHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setDeleteTarget(obj); }}
              className="rounded-md p-1.5 transition-colors bg-destructive/10 text-destructive hover:bg-destructive/20"
              title="삭제"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {/* 비편집 모드: 우측 화살표 힌트 */}
        {!editMode && (
          <ChevronRight className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors" />
        )}
      </div>
    );
  };

  if (!workspaceId) {
    return null;
  }

  return (
    <div className="p-6 space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Object 목록</h2>
          <p className="text-sm text-muted-foreground">
            {loading ? '로딩 중...' : `총 ${objects.filter((o) => o.depth === 0).length}개 · 필터 ${filtered.length}개`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Object 등록 */}
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" />
            추가
          </Button>
          {/* CSV 내보내기 */}
          <Button size="sm" variant="outline" onClick={exportCsv} disabled={filtered.length === 0}>
            <Download className="h-4 w-4 mr-1.5" />CSV
          </Button>
          {/* 편집 모드 토글 */}
          <Button size="sm" variant={editMode ? 'default' : 'outline'} onClick={() => setEditMode((v) => !v)}>
            {editMode ? <><CheckCheck className="h-4 w-4 mr-1.5" />완료</> : <><Pencil className="h-4 w-4 mr-1.5" />편집</>}
          </Button>
          {/* 뷰 토글 */}
          <div className="flex rounded-lg border border-border">
            <button onClick={() => setViewMode('grid')} className={cn('p-2 transition-colors', viewMode === 'grid' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground')}>
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button onClick={() => setViewMode('list')} className={cn('p-2 transition-colors', viewMode === 'list' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground')}>
              <List className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* 편집 모드 안내 */}
      {editMode && (
        <div className="flex items-center gap-2 rounded-lg bg-primary/10 border border-primary/20 px-4 py-2 text-sm text-primary">
          <Pencil className="h-4 w-4 shrink-0" />
          <span>편집 모드 — 카드에서 눈 아이콘으로 가시성 토글, 휴지통으로 삭제</span>
        </div>
      )}

      {/* 탭 바 */}
      <div className="flex gap-0.5 border-b border-border overflow-x-auto">
        {TABS.map((tab) => {
          const count = tabCount[tab.value] ?? 0;
          if (tab.value !== 'all' && count === 0) return null;
          return (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              className={cn(
                'relative flex items-center gap-1.5 px-3 pb-2.5 pt-1 text-sm font-medium transition-colors whitespace-nowrap',
                activeTab === tab.value ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                'after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5',
                activeTab === tab.value ? 'after:bg-primary' : 'after:bg-transparent',
              )}
            >
              {tab.label}
              {count > 0 && (
                <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium', activeTab === tab.value ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* 검색 */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Object 검색..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9" />
      </div>

      {/* 로딩 */}
      {loading && (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin mr-2" />
          <span className="text-sm">로드 중...</span>
        </div>
      )}

      {/* 빈 상태 */}
      {!loading && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
          {objects.length === 0 ? (
            <>
              <Box className="h-10 w-10 opacity-20" />
              <p className="text-sm">등록된 Object가 없습니다.</p>
              <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
                <Plus className="h-4 w-4 mr-1.5" />첫 Object 등록하기
              </Button>
            </>
          ) : (
            <p className="text-sm">검색 조건에 맞는 Object가 없습니다.</p>
          )}
        </div>
      )}

      {/* 카드 그리드 뷰 */}
      {!loading && filtered.length > 0 && viewMode === 'grid' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {filtered.map((obj) => renderCard(obj))}
        </div>
      )}

      {/* 테이블 리스트 뷰 */}
      {!loading && filtered.length > 0 && viewMode === 'list' && (
        <div className="rounded-xl glass-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/5">
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">이름</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">타입</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Granularity</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">가시성</th>
                {editMode && <th className="px-4 py-3 text-right font-medium text-muted-foreground">작업</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((obj) => {
                const config = getConfig(obj.objectType);
                const isHidden = obj.visibility !== 'VISIBLE';
                return (
                  <tr
                    key={obj.id}
                    onClick={() => handleCardClick(obj)}
                    className={cn('border-b border-white/5 last:border-0 transition-colors', !editMode && 'cursor-pointer hover:bg-white/5', isHidden && 'opacity-50')}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{obj.displayName ?? obj.name}</div>
                      <div className="text-xs text-muted-foreground font-mono">{obj.name}</div>
                    </td>
                    <td className="px-4 py-3"><Badge variant="outline">{config.label}</Badge></td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{obj.granularity}</td>
                    <td className="px-4 py-3">
                      <span className={cn('text-xs', isHidden ? 'text-muted-foreground' : 'text-green-400')}>{obj.visibility}</span>
                    </td>
                    {editMode && (
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); void toggleVisibility(obj); }}
                            className="rounded p-1 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                          >
                            {isHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setDeleteTarget(obj); }}
                            className="rounded p-1 hover:bg-destructive/10 transition-colors text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Object 추가 다이얼로그 */}
      <AddObjectDialog open={addOpen} onOpenChange={setAddOpen} workspaceId={workspaceId} onSuccess={() => void loadObjects()} />

      {/* Object 상세 Sheet */}
      <ObjectDetailSheet objectId={selectedObjectId} workspaceId={workspaceId} open={detailOpen} onOpenChange={setDetailOpen} onUpdate={() => void loadObjects()} />

      {/* 삭제 확인 다이얼로그 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null); }}
        title="Object 삭제"
        description={`"${deleteTarget?.name}" Object를 삭제하시겠습니까? 관련 관계도 함께 삭제됩니다.`}
        confirmLabel="삭제"
        destructive
        loading={deleting}
        onConfirm={() => { if (deleteTarget) void deleteObject(deleteTarget.id); }}
      />
    </div>
  );
}

// 하위 호환
export { ObjectListClient as ServiceListClient };
