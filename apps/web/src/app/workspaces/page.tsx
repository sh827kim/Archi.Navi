import type { Metadata } from 'next';
import { WorkspacesPageClient } from '@/components/workspace/workspaces-page-client';

export const metadata: Metadata = {
  title: '워크스페이스',
};

export default function WorkspacesPage() {
  return <WorkspacesPageClient />;
}
