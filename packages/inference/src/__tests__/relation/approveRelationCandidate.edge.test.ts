import { describe, expect, it, vi } from 'vitest';
import { approveRelationCandidate } from '../../relation/approveRelationCandidate';

describe('approveRelationCandidate edge cases', () => {
  it('insert 충돌 후 기존 relation 조회도 실패하면 오류를 던져야 한다', async () => {
    const candidate = {
      id: 'cand-1',
      workspaceId: 'ws-1',
      relationType: 'call',
      subjectObjectId: 'svc-a',
      objectId: 'svc-b',
      confidence: 0.8,
      metadata: {},
    };

    let selectStep = 0;
    const tx = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(async () => {
              selectStep += 1;
              if (selectStep === 1) return [candidate];
              if (selectStep === 2) return [];
              return [];
            }),
          }),
        }),
      })),
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      })),
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      })),
    };

    const db = {
      transaction: async (cb: (inner: typeof tx) => Promise<unknown>) => cb(tx),
    } as unknown as Parameters<typeof approveRelationCandidate>[0];

    await expect(approveRelationCandidate(db, 'cand-1', 'APPROVED')).rejects.toThrow(
      'approved relation not found',
    );
  });
});
