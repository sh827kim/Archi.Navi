/**
 * 대시보드 레이아웃
 * 사이드바 + 메인 콘텐츠 + 플로팅 AI 채팅
 * WorkspaceProvider로 전체 감싸서 멀티 워크스페이스 상태 공유
 */
import { Sidebar } from '@/components/layout/sidebar';
import { FloatingChat } from '@/components/chat/floating-chat';
import { WorkspaceProvider } from '@/contexts/workspace-context';
import { WorkspaceSelectionGuard } from '@/components/workspace/workspace-selection-guard';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <WorkspaceProvider>
      <WorkspaceSelectionGuard>
        <div className="flex h-screen overflow-hidden">
          {/* 사이드바 */}
          <Sidebar />

          {/* 메인 영역 */}
          <main className="relative flex-1 overflow-auto bg-background min-w-0">
            {/* subtle grid 배경 텍스처 */}
            <div
              className="pointer-events-none absolute inset-0 opacity-[0.015] dark:opacity-[0.02]"
              style={{
                backgroundImage:
                  'linear-gradient(rgba(128,128,128,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(128,128,128,0.3) 1px, transparent 1px)',
                backgroundSize: '40px 40px',
              }}
            />
            <div className="relative z-10 h-full">
              {children}
            </div>
          </main>

          {/* 플로팅 AI 채팅 */}
          <FloatingChat />
        </div>
      </WorkspaceSelectionGuard>
    </WorkspaceProvider>
  );
}
