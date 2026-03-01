import type { Metadata } from 'next';
import { WorkspaceOnboardingWizard } from '@/components/workspace/workspace-onboarding-wizard';

export const metadata: Metadata = {
  title: '워크스페이스 생성',
};

export default function WorkspaceNewPage() {
  return <WorkspaceOnboardingWizard />;
}
