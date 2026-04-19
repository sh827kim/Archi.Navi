import { describe, expect, it } from 'vitest';
import { computeRelationCohesion } from '@/domain/discovery/relationCohesion';
import type { CandidateMemberScore } from '@/domain/discovery/types';

function member(objectId: string, overrides: Partial<CandidateMemberScore> = {}): CandidateMemberScore {
    return {
        objectId,
        pathPrefixMatch: 1,
        routePrefixMatch: 0,
        topicPrefixMatch: 0,
        nameTokenJaccard: 0,
        affinity: 0.25,
        relationCohesion: 0,
        ...overrides,
    };
}

describe('computeRelationCohesion', () => {
    it('T1: 관계 0건 → cohesion 0, 평균 0', () => {
        const result = computeRelationCohesion({
            members: [member('a'), member('b')],
            relations: [],
        });
        expect(result.members.every((m) => m.relationCohesion === 0)).toBe(true);
        expect(result.candidateConfidence).toBe(0);
    });

    it('T2: 모든 관계가 후보 내부 → cohesion 1', () => {
        const result = computeRelationCohesion({
            members: [member('a'), member('b'), member('c')],
            relations: [
                { subjectObjectId: 'a', objectId: 'b', relationType: 'call' },
                { subjectObjectId: 'b', objectId: 'c', relationType: 'call' },
            ],
        });
        expect(result.members.find((m) => m.objectId === 'a')!.relationCohesion).toBe(1);
        expect(result.members.find((m) => m.objectId === 'b')!.relationCohesion).toBe(1);
        expect(result.members.find((m) => m.objectId === 'c')!.relationCohesion).toBe(1);
        expect(result.candidateConfidence).toBe(1);
    });

    it('T3: 절반은 외부 → cohesion 0.5', () => {
        const result = computeRelationCohesion({
            members: [member('a')],
            relations: [
                { subjectObjectId: 'a', objectId: 'b', relationType: 'call' },
                { subjectObjectId: 'a', objectId: 'c', relationType: 'call' },
            ],
        });
        // a 는 b/c 두 외부 객체로 향함 → cohesion 0
        expect(result.members[0]!.relationCohesion).toBe(0);
    });

    it('T4: incoming 관계도 카운트', () => {
        const result = computeRelationCohesion({
            members: [member('a'), member('b')],
            relations: [
                // a → b : 내부
                { subjectObjectId: 'a', objectId: 'b', relationType: 'call' },
                // c → a : 외부 (c 는 멤버 아님)
                { subjectObjectId: 'c', objectId: 'a', relationType: 'call' },
            ],
        });
        // a 의 관계 2건 중 1건만 내부 → 0.5
        expect(result.members.find((m) => m.objectId === 'a')!.relationCohesion).toBe(0.5);
        // b 의 관계 1건 (a→b) 내부 → 1
        expect(result.members.find((m) => m.objectId === 'b')!.relationCohesion).toBe(1);
    });

    it('T5: candidateConfidence 는 멤버 cohesion 평균', () => {
        const result = computeRelationCohesion({
            members: [member('a'), member('b')],
            relations: [
                { subjectObjectId: 'a', objectId: 'b', relationType: 'call' },
                { subjectObjectId: 'a', objectId: 'x', relationType: 'call' },
            ],
        });
        // a: 1/2 = 0.5, b: 1/1 = 1 → 평균 0.75
        expect(result.candidateConfidence).toBe(0.75);
    });
});
