/**
 * 도메인 상세 페이지 — 의미 프로파일 표시 + 추출/다운로드 액션
 */
import type { Metadata } from 'next';
import { DomainSemanticClient } from '@/components/domains/domain-semantic-client';

export const metadata: Metadata = {
  title: '도메인 상세',
};

export default async function DomainDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DomainSemanticClient domainId={id} />;
}
