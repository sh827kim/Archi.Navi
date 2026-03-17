/**
 * 추론 이력 페이지
 * inference_runs 실행 이력/상태를 조회하고 cancel/retry 수행
 */
import type { Metadata } from 'next';
import { InferenceRunList } from '@/components/inference/inference-run-list';

export const metadata: Metadata = {
  title: '추론 이력',
};

export default function InferenceRunsPage() {
  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-foreground">추론 이력</h2>
        <p className="text-sm text-muted-foreground">
          추론 실행 이력을 확인하고, 실패한 실행을 재시도하거나 진행 중인 실행을 취소합니다
        </p>
      </div>
      <InferenceRunList />
    </div>
  );
}
