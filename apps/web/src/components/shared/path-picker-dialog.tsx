'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowUp, FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@archi-navi/ui';
import { isAbsoluteScanPathPrefix } from '@/lib/scanPathPrefix';

interface BrowseDir {
  name: string;
  path: string;
}

interface BrowseResponse {
  dirs?: BrowseDir[];
  parent?: string;
  error?: string;
}

interface PathPickerDialogProps {
  value: string;
  onSelect: (path: string) => void;
  disabled?: boolean;
  fallbackPath?: string;
  triggerLabel?: string;
  title?: string;
  description?: string;
}

function normalizeSeedPath(value: string, fallbackPath?: string): string | null {
  const trimmed = value.trim();
  if (trimmed && isAbsoluteScanPathPrefix(trimmed)) {
    return trimmed;
  }

  const fallback = fallbackPath?.trim();
  if (fallback && isAbsoluteScanPathPrefix(fallback)) {
    return fallback;
  }

  return null;
}

function getParentPath(path: string): string {
  if (/^[A-Za-z]:[\\/]*$/.test(path)) {
    return path.slice(0, 3);
  }

  const normalizedWindows = path.replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(normalizedWindows)) {
    return `${normalizedWindows}\\`;
  }

  if (/^[A-Za-z]:[\\/]?$/.test(normalizedWindows)) {
    return `${normalizedWindows[0]}:\\`;
  }

  if (normalizedWindows.startsWith('/')) {
    if (normalizedWindows === '/') return '/';
    const parts = normalizedWindows.split('/').filter(Boolean);
    if (parts.length <= 1) return '/';
    return `/${parts.slice(0, -1).join('/')}`;
  }

  if (/^[A-Za-z]:[\\/]/.test(normalizedWindows)) {
    const parts = normalizedWindows.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 1) return `${normalizedWindows[0]}:\\`;
    return `${parts[0]}\\${parts.slice(1, -1).join('\\')}`.replace(/^([A-Za-z]:)\\?$/, '$1\\');
  }

  return path;
}

export function PathPickerDialog({
  value,
  onSelect,
  disabled,
  fallbackPath,
  triggerLabel = '폴더 선택',
  title = '폴더 선택',
  description = '현재 경로를 이동하며 원하는 폴더를 선택합니다.',
}: PathPickerDialogProps) {
  const [open, setOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [dirs, setDirs] = useState<BrowseDir[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const seedPath = useMemo(() => normalizeSeedPath(value, fallbackPath), [fallbackPath, value]);

  const browse = async (prefix?: string | null) => {
    setLoading(true);
    setError('');
    try {
      const url =
        prefix && prefix.trim()
          ? `/api/fs/browse?prefix=${encodeURIComponent(prefix.trim())}`
          : '/api/fs/browse';
      const res = await fetch(url);
      const data = (await res.json()) as BrowseResponse;
      if (!res.ok) {
        throw new Error(data.error ?? '폴더 목록을 불러오지 못했습니다.');
      }
      setCurrentPath(data.parent ?? prefix?.trim() ?? '');
      setDirs(data.dirs ?? []);
    } catch (browseError) {
      setDirs([]);
      setError(
        browseError instanceof Error ? browseError.message : '폴더 목록을 불러오지 못했습니다.',
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void browse(seedPath);
  }, [open, seedPath]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setError('');
    }
  };

  const handleBrowseCurrent = () => {
    const trimmed = currentPath.trim();
    if (!trimmed) {
      void browse(null);
      return;
    }

    if (!isAbsoluteScanPathPrefix(trimmed)) {
      setError('절대 경로를 입력하세요.');
      return;
    }

    void browse(trimmed);
  };

  const handleSelect = () => {
    const trimmed = currentPath.trim();
    if (!trimmed || !isAbsoluteScanPathPrefix(trimmed)) {
      setError('선택할 절대 경로를 입력하세요.');
      return;
    }

    onSelect(trimmed);
    setOpen(false);
  };

  const parentPath = currentPath ? getParentPath(currentPath) : '';
  const canGoUp = Boolean(currentPath) && parentPath !== currentPath;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Button type="button" variant="outline" onClick={() => setOpen(true)} disabled={disabled}>
        <FolderOpen className="mr-2 h-4 w-4" />
        {triggerLabel}
      </Button>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={currentPath}
              onChange={(event) => setCurrentPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handleBrowseCurrent();
                }
              }}
              placeholder="절대 경로를 입력하거나 폴더를 탐색하세요"
            />
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={handleBrowseCurrent}>
                <RefreshCw className="mr-2 h-4 w-4" />
                이동
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void browse(parentPath)}
                disabled={!canGoUp}
              >
                <ArrowUp className="mr-2 h-4 w-4" />
                상위 폴더
              </Button>
            </div>
          </div>

          <div className="rounded-lg border border-border">
            <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
              현재 경로: {currentPath || '기본 시작 경로'}
            </div>
            <div className="max-h-80 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  폴더 목록을 불러오는 중...
                </div>
              ) : dirs.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  표시할 하위 폴더가 없습니다.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {dirs.map((dir) => (
                    <button
                      key={dir.path}
                      type="button"
                      className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-accent/50"
                      onClick={() => void browse(dir.path)}
                    >
                      <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="truncate font-medium text-foreground">{dir.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{dir.path}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            취소
          </Button>
          <Button type="button" onClick={handleSelect}>
            현재 경로 선택
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
