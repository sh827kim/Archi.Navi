/**
 * 워크스페이스 셋업 마법사
 * 다이얼로그 기반 멀티 스텝 위저드
 * 1. 환영 → 2. 레이어 프리셋 → 3. 데이터 소스 안내 → 4. 완료
 */
'use client';

import { useState, useCallback } from 'react';
import { Layers, Terminal, CheckCircle2, Sparkles, ArrowRight, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import {
  cn,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Button,
} from '@archi-navi/ui';

/* ─── 프리셋 ─── */
interface LayerPreset {
  name: string;
  description: string;
  layers: { name: string; color: string }[];
}

const PRESETS: LayerPreset[] = [
  {
    name: 'Standard 4-Layer',
    description: 'Presentation → Application → Domain → Infrastructure',
    layers: [
      { name: 'Presentation', color: '#3b82f6' },
      { name: 'Application', color: '#8b5cf6' },
      { name: 'Domain', color: '#06b6d4' },
      { name: 'Infrastructure', color: '#10b981' },
    ],
  },
  {
    name: 'Microservice 6-Layer',
    description: 'Gateway → BFF → Application → Domain → Infrastructure → Data',
    layers: [
      { name: 'Gateway', color: '#f59e0b' },
      { name: 'BFF', color: '#3b82f6' },
      { name: 'Application', color: '#8b5cf6' },
      { name: 'Domain', color: '#06b6d4' },
      { name: 'Infrastructure', color: '#10b981' },
      { name: 'Data', color: '#ef4444' },
    ],
  },
  {
    name: '빈 설정',
    description: '레이어 없이 시작 (설정에서 나중에 추가)',
    layers: [],
  },
];

interface SetupWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}

export function SetupWizard({ open, onOpenChange, onComplete }: SetupWizardProps) {
  const [step, setStep] = useState(0);
  const [selectedPreset, setSelectedPreset] = useState(0);
  const [applying, setApplying] = useState(false);

  const applyPreset = useCallback(async () => {
    const preset = PRESETS[selectedPreset];
    if (!preset || preset.layers.length === 0) {
      onComplete();
      return;
    }

    setApplying(true);
    try {
      for (let i = 0; i < preset.layers.length; i++) {
        const layer = preset.layers[i]!;
        await fetch('/api/layers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: layer.name,
            color: layer.color,
            sortOrder: i,
          }),
        });
      }
      toast.success(`${preset.name} 프리셋 적용 완료`);
      onComplete();
    } catch {
      toast.error('레이어 프리셋 적용 실패');
    } finally {
      setApplying(false);
    }
  }, [selectedPreset, onComplete]);

  const steps = [
    /* Step 0: 환영 */
    {
      content: (
        <div className="flex flex-col items-center text-center gap-4 py-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/15">
            <Sparkles className="h-8 w-8 text-primary" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">
              Archi.Navi에 오신 것을 환영합니다
            </h3>
            <p className="mt-2 text-sm text-muted-foreground max-w-sm">
              MSA 아키텍처의 서비스 간 의존 관계를 시각화하고 관리하는 도구입니다.
              간단한 초기 설정을 시작해볼까요?
            </p>
          </div>
        </div>
      ),
    },
    /* Step 1: 레이어 프리셋 선택 */
    {
      content: (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Layers className="h-4 w-4" />
            아키텍처 레이어 프리셋을 선택하세요
          </div>
          <div className="space-y-2">
            {PRESETS.map((preset, idx) => {
              const isSelected = selectedPreset === idx;
              return (
                <button
                  key={preset.name}
                  onClick={() => setSelectedPreset(idx)}
                  className={cn(
                    'relative w-full rounded-xl p-4 text-left transition-all',
                    'glass-card',
                    isSelected
                      ? 'border-primary bg-primary/10 ring-2 ring-primary shadow-md'
                      : 'opacity-60 hover:opacity-90',
                  )}
                >
                  {/* 선택 체크 아이콘 (우측 상단) */}
                  {isSelected && (
                    <div className="absolute top-3 right-3">
                      <CheckCircle2 className="h-5 w-5 text-primary" />
                    </div>
                  )}
                  <div className="font-medium text-foreground text-sm">{preset.name}</div>
                  <div className="text-xs text-muted-foreground mt-1">{preset.description}</div>
                  {preset.layers.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {preset.layers.map((l) => (
                        <div key={l.name} className="flex items-center gap-1">
                          <div
                            className="h-3 w-3 rounded-full shrink-0"
                            style={{ backgroundColor: l.color }}
                          />
                          {/* 선택된 카드에서만 레이어 이름 표시 */}
                          {isSelected && (
                            <span className="text-[10px] text-muted-foreground">{l.name}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ),
    },
    /* Step 2: 데이터 소스 안내 */
    {
      content: (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Terminal className="h-4 w-4" />
            데이터를 가져오는 방법
          </div>
          <div className="space-y-3">
            <div className="glass-card rounded-xl p-4">
              <div className="text-sm font-medium text-foreground">CLI로 코드 스캔</div>
              <code className="mt-2 block rounded-lg bg-muted/50 px-3 py-2 text-xs font-mono text-foreground">
                npx anavi scan --path ./your-project
              </code>
              <p className="mt-2 text-xs text-muted-foreground">
                프로젝트 코드를 분석하여 서비스, API, DB를 자동으로 등록합니다.
              </p>
            </div>
            <div className="glass-card rounded-xl p-4">
              <div className="text-sm font-medium text-foreground">수동 등록</div>
              <p className="mt-1 text-xs text-muted-foreground">
                서비스 목록 페이지에서 직접 Object를 추가할 수 있습니다.
              </p>
            </div>
          </div>
        </div>
      ),
    },
    /* Step 3: 완료 */
    {
      content: (
        <div className="flex flex-col items-center text-center gap-4 py-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-green-500/15">
            <CheckCircle2 className="h-8 w-8 text-green-500" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">설정 완료!</h3>
            <p className="mt-2 text-sm text-muted-foreground max-w-sm">
              이제 아키텍처 뷰에서 레이어를 확인하고, 서비스를 배치해보세요.
            </p>
          </div>
        </div>
      ),
    },
  ];

  const isLast = step === steps.length - 1;
  const isPresetStep = step === 1;

  const handleNext = () => {
    if (isLast) {
      void applyPreset();
    } else {
      setStep((s) => Math.min(s + 1, steps.length - 1));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>워크스페이스 설정</DialogTitle>
          <DialogDescription>
            단계 {step + 1} / {steps.length}
          </DialogDescription>
        </DialogHeader>

        {/* 스텝 인디케이터 */}
        <div className="flex justify-center gap-1.5 mb-2">
          {steps.map((_, idx) => (
            <div
              key={idx}
              className={cn(
                'h-1.5 rounded-full transition-all',
                idx === step ? 'w-6 bg-primary' : 'w-1.5 bg-muted',
              )}
            />
          ))}
        </div>

        {/* 컨텐츠 */}
        {steps[step]?.content}

        {/* 버튼 */}
        <div className="flex justify-between mt-4">
          <Button
            variant="ghost"
            onClick={() => setStep((s) => Math.max(s - 1, 0))}
            disabled={step === 0}
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            이전
          </Button>
          <Button onClick={handleNext} disabled={applying}>
            {applying ? '적용 중...' : isLast ? '완료' : '다음'}
            {!isLast && <ArrowRight className="h-4 w-4 ml-1" />}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
