/**
 * 사이드바 컴포넌트
 * 글래스모피즘 + 다크/라이트 모드 토글
 * 네비게이션: Architecture, Mapping Graph, Services, Relations, Approval, Settings
 */
'use client';

import { useSyncExternalStore } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from 'next-themes';
import {
  LayoutGrid,     // Architecture (레이어드 뷰)
  GitGraph,       // Object Mapping (롤업 그래프)
  Server,         // Services
  GitBranch,      // Relations
  CheckCircle,    // Approval
  Activity,       // Inference Runs
  Settings,       // Settings
  Compass,        // 로고
  Sun,
  Moon,
} from 'lucide-react';
import { cn, Switch } from '@archi-navi/ui';
import { WorkspaceSwitcher } from '@/components/workspace/workspace-switcher';

/** 메인 네비게이션 아이템 */
const navItems = [
  {
    href: '/architecture',
    label: '아키텍처 뷰',
    icon: LayoutGrid,
    description: '레이어드 아키텍처 시각화',
  },
  {
    href: '/mapping-graph',
    label: 'Object Mapping',
    icon: GitGraph,
    description: 'Roll-up/Roll-down 그래프',
  },
  {
    href: '/services',
    label: 'Object 목록',
    icon: Server,
    description: '등록된 Object 관리 및 수동 등록',
  },
  {
    href: '/relations',
    label: '관계 매핑',
    icon: GitBranch,
    description: '확정된 Relation 관리',
  },
  {
    href: '/approval',
    label: '승인 대기',
    icon: CheckCircle,
    description: '추론된 관계 승인/거부',
  },
  {
    href: '/inference-runs',
    label: '추론 이력',
    icon: Activity,
    description: '추론 실행 이력 및 상태 모니터링',
  },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const isDark = hydrated && (resolvedTheme ?? theme) === 'dark';

  return (
    <aside className="flex h-screen w-64 flex-col glass-panel">
      {/* 로고 영역 */}
      <div className="flex h-14 items-center gap-2.5 border-b border-white/10 dark:border-white/10 px-4">
        <div className="relative">
          <Compass className="h-6 w-6 text-primary animate-glow-pulse" />
          {/* 글로우 효과 */}
          <div className="absolute inset-0 h-6 w-6 rounded-full bg-primary/20 blur-md" />
        </div>
        <span className="text-sm font-bold tracking-tight text-foreground text-glow">
          Archi<span className="text-primary">.</span>Navi
        </span>
      </div>

      {/* 워크스페이스 스위처 */}
      <div className="border-b border-white/10 dark:border-white/10 px-2 py-2">
        <WorkspaceSwitcher />
      </div>

      {/* 메인 네비게이션 */}
      <nav className="flex-1 space-y-1 px-3 py-4 overflow-y-auto">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200',
                isActive
                  ? 'bg-primary/15 text-primary shadow-sm'
                  : 'text-muted-foreground hover:bg-white/5 dark:hover:bg-white/5 hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* 하단 영역 — 설정 + 다크모드 토글 */}
      <div className="border-t border-white/10 dark:border-white/10 px-3 py-3 space-y-2">
        {/* 설정 링크 */}
        <Link
          href="/settings"
          className={cn(
            'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200',
            pathname.startsWith('/settings')
              ? 'bg-primary/15 text-primary shadow-sm'
              : 'text-muted-foreground hover:bg-white/5 dark:hover:bg-white/5 hover:text-foreground',
          )}
        >
          <Settings className="h-4 w-4 shrink-0" />
          <span>설정</span>
        </Link>

        {/* 다크/라이트 모드 토글 */}
        <div className="flex items-center justify-between px-3 py-1.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {isDark ? (
              <Moon className="h-3.5 w-3.5" />
            ) : (
              <Sun className="h-3.5 w-3.5" />
            )}
            <span>{isDark ? '다크 모드' : '라이트 모드'}</span>
          </div>
          <Switch
            checked={isDark}
            onCheckedChange={(checked) => setTheme(checked ? 'dark' : 'light')}
          />
        </div>
      </div>
    </aside>
  );
}
