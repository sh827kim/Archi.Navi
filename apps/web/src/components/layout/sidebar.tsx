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
  House,
  LayoutGrid,     // Architecture (레이어드 뷰)
  GitGraph,       // Object Mapping (롤업 그래프)
  Server,         // Services
  GitBranch,      // Relations
  CheckCircle,    // Approval
  Activity,       // Inference Runs
  SearchCode,     // Query Engine
  Settings,       // Settings
  Compass,        // 로고
  Sun,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { cn } from '@archi-navi/ui';
import { WorkspaceSwitcher } from '@/components/workspace/workspace-switcher';
import { useSidebarStore } from '@/stores/sidebar';

/** 메인 네비게이션 아이템 */
const navItems = [
  {
    href: '/home',
    label: '홈',
    icon: House,
    description: '운영 요약과 빠른 액션',
  },
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
  {
    href: '/query',
    label: '쿼리 엔진',
    icon: SearchCode,
    description: '영향도/경로/사용 주체 직접 쿼리',
  },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const collapsed = useSidebarStore((state) => state.collapsed);
  const toggleCollapsed = useSidebarStore((state) => state.toggleCollapsed);
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const isDark = hydrated && (resolvedTheme ?? theme) === 'dark';

  return (
    <aside
      className={cn(
        'flex h-screen shrink-0 flex-col glass-panel transition-[width] duration-200',
        collapsed ? 'w-[88px]' : 'w-64',
      )}
    >
      {/* 로고 영역 */}
      <div
        className={cn(
          'relative flex h-14 items-center border-b border-white/10 dark:border-white/10',
          collapsed ? 'justify-center px-3' : 'justify-between gap-2.5 px-4',
        )}
      >
        <div className={cn('flex items-center gap-2.5', collapsed && 'justify-center')}>
          <div className="relative">
            <Compass className="h-6 w-6 text-primary animate-glow-pulse" />
            <div className="absolute inset-0 h-6 w-6 rounded-full bg-primary/20 blur-md" />
          </div>
          {!collapsed ? (
            <span className="text-sm font-bold tracking-tight text-foreground text-glow">
              Archi<span className="text-primary">.</span>Navi
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={toggleCollapsed}
          className={cn(
            'rounded-md p-2 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground',
            collapsed ? 'absolute right-2 top-2' : '',
          )}
          aria-label={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
          title={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>

      {/* 워크스페이스 스위처 */}
      <div
        className={cn(
          'border-b border-white/10 py-2 dark:border-white/10',
          collapsed ? 'px-3' : 'px-2',
        )}
      >
        <WorkspaceSwitcher collapsed={collapsed} />
      </div>

      {/* 메인 네비게이션 */}
      <nav className={cn('flex-1 space-y-1 overflow-y-auto py-4', collapsed ? 'px-2' : 'px-3')}>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              aria-label={item.label}
              title={collapsed ? item.label : item.description}
              className={cn(
                'flex items-center rounded-lg py-2.5 text-sm font-medium transition-all duration-200',
                collapsed ? 'justify-center px-2' : 'gap-3 px-3',
                isActive
                  ? 'bg-primary/15 text-primary shadow-sm'
                  : 'text-muted-foreground hover:bg-white/5 dark:hover:bg-white/5 hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed ? <span>{item.label}</span> : null}
            </Link>
          );
        })}
      </nav>

      {/* 하단 영역 — 설정 + 다크모드 토글 */}
      <div
        className={cn(
          'border-t border-white/10 py-3 dark:border-white/10',
          collapsed ? 'space-y-1 px-2' : 'space-y-2 px-3',
        )}
      >
        {/* 설정 링크 */}
        <Link
          href="/settings"
          prefetch={false}
          aria-label="설정"
          title="설정"
          className={cn(
            'flex items-center rounded-lg py-2.5 text-sm font-medium transition-all duration-200',
            collapsed ? 'justify-center px-2' : 'gap-3 px-3',
            pathname.startsWith('/settings')
              ? 'bg-primary/15 text-primary shadow-sm'
              : 'text-muted-foreground hover:bg-white/5 dark:hover:bg-white/5 hover:text-foreground',
          )}
        >
          <Settings className="h-4 w-4 shrink-0" />
          {!collapsed ? <span>설정</span> : null}
        </Link>

        {/* 다크/라이트 모드 토글 */}
        <button
          type="button"
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
          aria-label={isDark ? '라이트 모드로 전환' : '다크 모드로 전환'}
          title={isDark ? '라이트 모드로 전환' : '다크 모드로 전환'}
          className={cn(
            'flex w-full items-center rounded-lg py-2.5 text-sm transition-colors',
            collapsed ? 'justify-center px-2' : 'justify-between px-3',
            'text-muted-foreground hover:bg-white/5 hover:text-foreground dark:hover:bg-white/5',
          )}
        >
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {isDark ? (
              <Moon className="h-3.5 w-3.5" />
            ) : (
              <Sun className="h-3.5 w-3.5" />
            )}
            {!collapsed ? <span>{isDark ? '다크 모드' : '라이트 모드'}</span> : null}
          </div>
          {!collapsed ? (
            <span className="text-[11px] text-muted-foreground/80">
              {isDark ? 'ON' : 'OFF'}
            </span>
          ) : null}
        </button>
      </div>
    </aside>
  );
}
