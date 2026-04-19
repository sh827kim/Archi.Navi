/**
 * 도메인 관리 페이지 — 승인된 도메인 목록 + Phase 1 발견 트리거
 */
import type { Metadata } from 'next';
import { DomainListClient } from '@/components/domains/domain-list-client';

export const metadata: Metadata = {
  title: '도메인 관리',
};

export default function DomainsPage() {
  return <DomainListClient />;
}
