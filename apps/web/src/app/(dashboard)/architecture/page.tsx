/**
 * 아키텍처 뷰 페이지
 * Cytoscape 기반 레이어드 아키텍처 시각화
 */
import type { Metadata } from 'next';
import { LayeredArchitectureView } from '@/components/architecture/layered-architecture-view';

export const metadata: Metadata = {
  title: '아키텍처 뷰',
};

export default function ArchitecturePage() {
  return (
    <div className="h-full min-h-0 w-full overflow-hidden">
      <LayeredArchitectureView />
    </div>
  );
}
