'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@archi-navi/ui';
import { useWorkspace } from '@/contexts/workspace-context';
import { normalizeWorkspaceName, WORKSPACE_NAME_MAX_LENGTH } from '@/lib/workspace-name';

type Step = 0 | 1 | 2 | 3 | 4;
type ScanMode = 'local' | 'workspace-dir' | 'github-repo' | 'github-org';

interface LayerDraft {
  id: string;
  name: string;
  color: string;
}

interface TagDraft {
  id: string;
  name: string;
  color: string;
}

interface ScanResult {
  registered: number;
  skipped: number;
  projects: { name: string }[];
}

type ScanStreamEvent =
  | { type: 'start'; total: number }
  | { type: 'progress'; current: number; total: number; message: string }
  | { type: 'complete'; result: ScanResult }
  | { type: 'error'; message: string };

const SCAN_MODE_OPTIONS: Array<{ value: ScanMode; label: string; placeholder: string }> = [
  { value: 'local', label: '로컬 프로젝트', placeholder: '/path/to/project' },
  { value: 'workspace-dir', label: '워크스페이스 폴더', placeholder: '/path/to/workspace' },
  { value: 'github-repo', label: 'GitHub 레포', placeholder: 'owner/repo' },
  { value: 'github-org', label: 'GitHub Org', placeholder: 'my-org' },
];

export function WorkspaceOnboardingWizard() {
  const router = useRouter();
  const { setWorkspace, refreshWorkspaces } = useWorkspace();
  const idSeq = useRef(100);
  const [step, setStep] = useState<Step>(0);
  const [pending, setPending] = useState(false);

  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  const [wCode, setWCode] = useState(0.5);
  const [wDb, setWDb] = useState(0.3);
  const [wMsg, setWMsg] = useState(0.2);

  const [layers, setLayers] = useState<LayerDraft[]>([
    { id: 'layer-1', name: 'Presentation', color: '#3b82f6' },
    { id: 'layer-2', name: 'Application', color: '#8b5cf6' },
    { id: 'layer-3', name: 'Domain', color: '#06b6d4' },
    { id: 'layer-4', name: 'Infrastructure', color: '#10b981' },
  ]);

  const [tags, setTags] = useState<TagDraft[]>([
    { id: 'tag-1', name: 'core', color: '#2563eb' },
    { id: 'tag-2', name: 'legacy', color: '#f59e0b' },
  ]);

  const [scanMode, setScanMode] = useState<ScanMode>('local');
  const [scanTarget, setScanTarget] = useState('');
  const [scanDryRun, setScanDryRun] = useState(false);
  const [scanMessage, setScanMessage] = useState('');

  const progressLabels = ['제목', '추론 설정', '레이어', '태그', '코드 스캔'] as const;
  const weightSum = useMemo(() => Number((wCode + wDb + wMsg).toFixed(2)), [wCode, wDb, wMsg]);
  const selectedScanMode = SCAN_MODE_OPTIONS.find((mode) => mode.value === scanMode)!;
  const nextId = (prefix: string) => {
    idSeq.current += 1;
    return `${prefix}-${idSeq.current}`;
  };

  const createWorkspace = async (): Promise<string> => {
    const normalized = normalizeWorkspaceName(workspaceName);
    if ('error' in normalized) {
      if (normalized.error === 'name is required') {
        throw new Error('워크스페이스 제목을 입력하세요.');
      }

      throw new Error(`워크스페이스 이름은 ${WORKSPACE_NAME_MAX_LENGTH}자 이하로 입력하세요.`);
    }

    const res = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: normalized.name }),
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      if (err.error === `name must be at most ${WORKSPACE_NAME_MAX_LENGTH} characters`) {
        throw new Error(`워크스페이스 이름은 ${WORKSPACE_NAME_MAX_LENGTH}자 이하로 입력하세요.`);
      }
      throw new Error(err.error ?? '워크스페이스 생성에 실패했습니다.');
    }

    const created = (await res.json()) as { id: string; name: string };
    setWorkspaceId(created.id);
    setWorkspaceName(created.name);
    return created.id;
  };

  const saveInferenceProfile = async (id: string) => {
    if (Math.abs(weightSum - 1) > 0.001) {
      throw new Error('가중치 합계가 1.00이어야 합니다.');
    }

    const res = await fetch('/api/inference/profiles/default', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: id,
        wCode,
        wDb,
        wMsg,
      }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? '추론 설정 저장에 실패했습니다.');
    }
  };

  const saveLayers = async (id: string) => {
    const cleaned = layers
      .map((layer) => ({
        name: layer.name.trim(),
        color: layer.color || null,
      }))
      .filter((layer) => layer.name.length > 0);

    if (cleaned.length === 0) {
      return;
    }

    const existingRes = await fetch(`/api/layers?workspaceId=${id}`);
    if (!existingRes.ok) {
      throw new Error('기존 레이어 조회에 실패했습니다.');
    }
    const existing = (await existingRes.json()) as { name: string }[];
    const existingNames = new Set(existing.map((layer) => layer.name.toLowerCase()));

    for (let i = 0; i < cleaned.length; i++) {
      const layer = cleaned[i]!;
      if (existingNames.has(layer.name.toLowerCase())) {
        continue;
      }
      const res = await fetch('/api/layers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: id,
          name: layer.name,
          color: layer.color,
          sortOrder: i,
        }),
      });
      if (!res.ok) {
        throw new Error(`레이어 생성 실패: ${layer.name}`);
      }
    }
  };

  const saveTags = async (id: string) => {
    const cleaned = tags
      .map((tag) => ({
        name: tag.name.trim(),
        color: tag.color || '#6b7280',
      }))
      .filter((tag) => tag.name.length > 0);

    if (cleaned.length === 0) {
      return;
    }

    const existingRes = await fetch(`/api/tags?workspaceId=${id}`);
    if (!existingRes.ok) {
      throw new Error('기존 태그 조회에 실패했습니다.');
    }
    const existing = (await existingRes.json()) as { name: string }[];
    const existingNames = new Set(existing.map((tag) => tag.name.toLowerCase()));

    for (const tag of cleaned) {
      if (existingNames.has(tag.name.toLowerCase())) {
        continue;
      }
      const res = await fetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: id,
          name: tag.name,
          color: tag.color,
        }),
      });
      if (!res.ok && res.status !== 409) {
        throw new Error(`태그 생성 실패: ${tag.name}`);
      }
    }
  };

  const runScan = async (id: string): Promise<ScanResult | null> => {
    if (!scanTarget.trim()) {
      return null;
    }

    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: id,
        mode: scanMode,
        target: scanTarget.trim(),
        dryRun: scanDryRun,
      }),
    });

    if (!res.ok || !res.body) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? '코드 스캔 실행에 실패했습니다.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: ScanResult | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const event = JSON.parse(line.slice(6)) as ScanStreamEvent;
        if (event.type === 'progress') {
          setScanMessage(event.message);
        } else if (event.type === 'complete') {
          result = event.result;
        } else if (event.type === 'error') {
          throw new Error(event.message);
        }
      }
    }

    return result;
  };

  const finalize = async (id: string) => {
    await refreshWorkspaces();
    setWorkspace(id);
    router.push('/architecture');
  };

  const handleNext = async () => {
    setPending(true);
    try {
      if (step === 0) {
        await createWorkspace();
        setStep(1);
      } else if (step === 1) {
        if (!workspaceId) throw new Error('워크스페이스가 생성되지 않았습니다.');
        await saveInferenceProfile(workspaceId);
        setStep(2);
      } else if (step === 2) {
        if (!workspaceId) throw new Error('워크스페이스가 생성되지 않았습니다.');
        await saveLayers(workspaceId);
        setStep(3);
      } else if (step === 3) {
        if (!workspaceId) throw new Error('워크스페이스가 생성되지 않았습니다.');
        await saveTags(workspaceId);
        setStep(4);
      } else if (step === 4) {
        if (!workspaceId) throw new Error('워크스페이스가 생성되지 않았습니다.');
        const scanResult = await runScan(workspaceId);
        if (scanResult) {
          toast.success(`코드 스캔 완료: ${scanResult.registered}개 등록, ${scanResult.skipped}개 스킵`);
        } else {
          toast.success('코드 스캔을 건너뛰고 설정을 완료했습니다.');
        }
        await finalize(workspaceId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '설정 중 오류가 발생했습니다.';
      toast.error(message);
    } finally {
      setPending(false);
    }
  };

  const handleSkipScan = async () => {
    if (!workspaceId) return;
    setPending(true);
    try {
      toast.success('코드 스캔을 건너뛰고 설정을 완료했습니다.');
      await finalize(workspaceId);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">워크스페이스 생성</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              제목 입력부터 코드 스캔까지 한 번에 초기 구성을 진행합니다.
            </p>
          </div>
          <Button variant="outline" onClick={() => router.push('/workspaces')} disabled={pending}>
            목록으로
          </Button>
        </div>

        <div className="mb-6 flex gap-2">
          {progressLabels.map((label, index) => {
            const active = index === step;
            const done = index < step;
            return (
              <div
                key={label}
                className={`flex-1 rounded-lg border px-2 py-2 text-center text-xs ${
                  active
                    ? 'border-primary bg-primary/10 text-primary'
                    : done
                      ? 'border-border bg-accent/40 text-foreground'
                      : 'border-border/70 text-muted-foreground'
                }`}
              >
                {index + 1}. {label}
              </div>
            );
          })}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{progressLabels[step]}</CardTitle>
            <CardDescription>
              {step === 0 && '워크스페이스 이름을 입력합니다.'}
              {step === 1 && '관계 추론 기본 가중치를 저장합니다.'}
              {step === 2 && '아키텍처 레이어를 초기 등록합니다.'}
              {step === 3 && '태그를 미리 등록합니다.'}
              {step === 4 && '코드 스캔을 실행하거나 건너뛸 수 있습니다.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {step === 0 && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">제목</p>
                <Input
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                  placeholder="예: 쇼핑몰 플랫폼"
                  disabled={pending}
                  maxLength={WORKSPACE_NAME_MAX_LENGTH}
                />
                <p className="text-xs text-muted-foreground">
                  {workspaceName.length}/{WORKSPACE_NAME_MAX_LENGTH}
                </p>
              </div>
            )}

            {step === 1 && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Code</p>
                    <Input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      value={wCode}
                      onChange={(e) => setWCode(Number(e.target.value))}
                      disabled={pending}
                    />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">DB</p>
                    <Input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      value={wDb}
                      onChange={(e) => setWDb(Number(e.target.value))}
                      disabled={pending}
                    />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Message</p>
                    <Input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      value={wMsg}
                      onChange={(e) => setWMsg(Number(e.target.value))}
                      disabled={pending}
                    />
                  </div>
                </div>
                <p className={`text-xs ${Math.abs(weightSum - 1) <= 0.001 ? 'text-muted-foreground' : 'text-red-500'}`}>
                  가중치 합계: {weightSum.toFixed(2)} (정상값 1.00)
                </p>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-3">
                {layers.map((layer, index) => (
                  <div key={layer.id} className="grid grid-cols-[1fr_auto_auto] gap-2">
                    <Input
                      value={layer.name}
                      onChange={(e) => {
                        const value = e.target.value;
                        setLayers((prev) => prev.map((item, i) => (i === index ? { ...item, name: value } : item)));
                      }}
                      placeholder="레이어 이름"
                      disabled={pending}
                    />
                    <Input
                      type="color"
                      value={layer.color}
                      onChange={(e) => {
                        const value = e.target.value;
                        setLayers((prev) => prev.map((item, i) => (i === index ? { ...item, color: value } : item)));
                      }}
                      className="h-10 w-14 p-1"
                      disabled={pending}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setLayers((prev) => prev.filter((item) => item.id !== layer.id))}
                      disabled={pending || layers.length === 1}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  onClick={() =>
                    setLayers((prev) => [...prev, { id: nextId('layer'), name: '', color: '#6b7280' }])
                  }
                  disabled={pending}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  레이어 추가
                </Button>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-3">
                {tags.map((tag, index) => (
                  <div key={tag.id} className="grid grid-cols-[1fr_auto_auto] gap-2">
                    <Input
                      value={tag.name}
                      onChange={(e) => {
                        const value = e.target.value;
                        setTags((prev) => prev.map((item, i) => (i === index ? { ...item, name: value } : item)));
                      }}
                      placeholder="태그 이름"
                      disabled={pending}
                    />
                    <Input
                      type="color"
                      value={tag.color}
                      onChange={(e) => {
                        const value = e.target.value;
                        setTags((prev) => prev.map((item, i) => (i === index ? { ...item, color: value } : item)));
                      }}
                      className="h-10 w-14 p-1"
                      disabled={pending}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setTags((prev) => prev.filter((item) => item.id !== tag.id))}
                      disabled={pending || tags.length === 1}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  onClick={() =>
                    setTags((prev) => [...prev, { id: nextId('tag'), name: '', color: '#6b7280' }])
                  }
                  disabled={pending}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  태그 추가
                </Button>
              </div>
            )}

            {step === 4 && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">스캔 모드</p>
                  <Select value={scanMode} onValueChange={(value) => setScanMode(value as ScanMode)} disabled={pending}>
                    <SelectTrigger>
                      <SelectValue placeholder="스캔 모드 선택" />
                    </SelectTrigger>
                    <SelectContent>
                      {SCAN_MODE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">대상</p>
                  <Input
                    value={scanTarget}
                    onChange={(e) => setScanTarget(e.target.value)}
                    placeholder={selectedScanMode.placeholder}
                    disabled={pending}
                  />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2">
                  <p className="text-sm text-muted-foreground">미리보기(dry-run)</p>
                  <Switch checked={scanDryRun} onCheckedChange={setScanDryRun} disabled={pending} />
                </div>
                {scanMessage && (
                  <p className="text-xs text-muted-foreground">{scanMessage}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  대상을 비워두면 스캔 없이 완료됩니다.
                </p>
              </div>
            )}

            <div className="flex items-center justify-between border-t border-border/70 pt-4">
              <Button
                variant="outline"
                onClick={() => setStep((prev) => Math.max(0, prev - 1) as Step)}
                disabled={pending || step === 0}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                이전
              </Button>

              {step < 4 ? (
                <Button onClick={() => void handleNext()} disabled={pending}>
                  {pending ? '저장 중...' : '다음'}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              ) : (
                <div className="flex items-center gap-2">
                  <Button variant="outline" onClick={() => void handleSkipScan()} disabled={pending}>
                    건너뛰고 완료
                  </Button>
                  <Button onClick={() => void handleNext()} disabled={pending}>
                    {pending ? '처리 중...' : '스캔 후 완료'}
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
