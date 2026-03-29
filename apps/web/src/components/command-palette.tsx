/**
 * 커맨드 팔레트 (Cmd+K)
 * cmdk 라이브러리 기반 — 페이지 네비게이션 + Object 검색 + 액션
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { Command } from 'cmdk';
import { useRouter } from 'next/navigation';
import {
  House,
  LayoutGrid,
  GitGraph,
  Server,
  GitBranch,
  CheckCircle,
  Settings,
  FolderOpen,
  Search,
  MessageSquare,
  RefreshCw,
} from 'lucide-react';
import { cn } from '@archi-navi/ui';

/** 네비게이션 아이템 */
const NAV_ITEMS = [
  { label: '워크스페이스', href: '/workspaces', icon: FolderOpen, group: '페이지' },
  { label: '홈', href: '/home', icon: House, group: '페이지' },
  { label: '아키텍처 뷰', href: '/architecture', icon: LayoutGrid, group: '페이지' },
  { label: 'Object Mapping', href: '/mapping-graph', icon: GitGraph, group: '페이지' },
  { label: '서비스 목록', href: '/services', icon: Server, group: '페이지' },
  { label: '관계 매핑', href: '/relations', icon: GitBranch, group: '페이지' },
  { label: '승인 대기', href: '/approval', icon: CheckCircle, group: '페이지' },
  { label: '설정', href: '/settings', icon: Settings, group: '페이지' },
];

/** 액션 아이템 */
const ACTION_ITEMS = [
  { label: 'AI 채팅 열기', action: 'chat', icon: MessageSquare, group: '액션' },
  { label: 'Roll-up 재계산', action: 'rebuild', icon: RefreshCw, group: '액션' },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  // Cmd+K / Ctrl+K 바인딩
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSelect = useCallback(
    (value: string) => {
      setOpen(false);

      // 네비게이션
      const navItem = NAV_ITEMS.find((i) => i.href === value);
      if (navItem) {
        router.push(navItem.href);
        return;
      }

      // 액션
      if (value === 'chat') {
        // Cmd+J 이벤트 디스패치
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'j', metaKey: true }),
        );
      }
    },
    [router],
  );

  if (!open) return null;

  return (
    <>
      {/* 오버레이 */}
      <div
        className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />

      {/* 팔레트 */}
      <div className="fixed left-1/2 top-[20%] z-[61] w-full max-w-xl -translate-x-1/2">
        <Command
          className={cn(
            'rounded-xl shadow-2xl overflow-hidden',
            'bg-popover border border-border',
          )}
        >
          {/* 검색 입력 */}
          <div className="flex items-center border-b border-border px-4">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Command.Input
              placeholder="페이지 이동, 서비스 검색, 액션 실행..."
              className="flex-1 bg-transparent py-3 px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>

          {/* 결과 목록 */}
          <Command.List className="max-h-80 overflow-y-auto p-2">
            <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
              결과가 없습니다.
            </Command.Empty>

            {/* 페이지 그룹 */}
            <Command.Group heading="페이지" className="text-xs text-muted-foreground px-2 py-1.5">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                return (
                  <Command.Item
                    key={item.href}
                    value={item.href}
                    onSelect={handleSelect}
                    className={cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm cursor-pointer',
                      'text-foreground',
                      'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
                    )}
                  >
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    {item.label}
                  </Command.Item>
                );
              })}
            </Command.Group>

            {/* 액션 그룹 */}
            <Command.Group heading="액션" className="text-xs text-muted-foreground px-2 py-1.5">
              {ACTION_ITEMS.map((item) => {
                const Icon = item.icon;
                return (
                  <Command.Item
                    key={item.action}
                    value={item.action}
                    onSelect={handleSelect}
                    className={cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm cursor-pointer',
                      'text-foreground',
                      'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
                    )}
                  >
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    {item.label}
                  </Command.Item>
                );
              })}
            </Command.Group>
          </Command.List>

          {/* 하단 힌트 */}
          <div className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground flex gap-3">
            <span>↑↓ 이동</span>
            <span>↵ 선택</span>
            <span>esc 닫기</span>
          </div>
        </Command>
      </div>
    </>
  );
}
