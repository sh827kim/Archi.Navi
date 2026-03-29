/**
 * 쿼리 엔진 페이지 (/query)
 * POST /api/query 를 직접 호출하는 UI
 */
import type { Metadata } from 'next';
import { QueryClient } from '@/components/query/query-client';

export const metadata: Metadata = { title: '쿼리 엔진' };

export default function QueryPage() {
  return <QueryClient />;
}
