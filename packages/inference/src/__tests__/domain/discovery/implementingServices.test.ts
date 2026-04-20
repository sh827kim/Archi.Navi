import { describe, expect, it } from 'vitest';
import { computeImplementingServices } from '@/domain/discovery/implementingServices';

type Obj = { id: string; parentId: string | null; objectType: string; name: string };

describe('computeImplementingServices', () => {
    it('T1: function/api_endpoint 만 분자·분모에 기여한다', () => {
        const objects: Obj[] = [
            { id: 's1', parentId: null, objectType: 'service', name: 'RobotService' },
            { id: 'f1', parentId: 's1', objectType: 'function', name: 'create' },
            { id: 'f2', parentId: 's1', objectType: 'function', name: 'update' },
            { id: 'e1', parentId: 's1', objectType: 'api_endpoint', name: 'GET /r' },
            { id: 't1', parentId: 's1', objectType: 'db_table', name: 'robots' },
        ];
        const memberIds = new Set(['f1', 'e1']);

        const result = computeImplementingServices({ objects, memberIds });

        expect(result).toEqual([
            {
                serviceObjectId: 's1',
                serviceName: 'RobotService',
                childInDomain: 2, // f1 + e1
                childTotal: 3,    // f1 + f2 + e1 (db_table 제외)
                confidence: 2 / 3,
            },
        ]);
    });

    it('T2: childTotal=0 인 서비스 (코드 자식 없음) 는 결과에서 제외된다', () => {
        const objects: Obj[] = [
            { id: 's2', parentId: null, objectType: 'service', name: 'StorageOnly' },
            { id: 't2', parentId: 's2', objectType: 'db_table', name: 'orders' },
        ];
        const memberIds = new Set(['t2']);

        const result = computeImplementingServices({ objects, memberIds });

        expect(result).toEqual([]);
    });

    it('T3: parent 가 service 가 아닌 자식은 기여하지 않는다', () => {
        const objects: Obj[] = [
            { id: 'd1', parentId: null, objectType: 'database', name: 'orders_db' },
            { id: 't1', parentId: 'd1', objectType: 'db_table', name: 'orders' },
        ];
        const memberIds = new Set(['t1']);

        const result = computeImplementingServices({ objects, memberIds });

        expect(result).toEqual([]);
    });

    it('T4: confidence 내림차순으로 정렬된다', () => {
        const objects: Obj[] = [
            { id: 'sA', parentId: null, objectType: 'service', name: 'A' },
            { id: 'sB', parentId: null, objectType: 'service', name: 'B' },
            { id: 'fa1', parentId: 'sA', objectType: 'function', name: 'a1' },
            { id: 'fa2', parentId: 'sA', objectType: 'function', name: 'a2' },
            { id: 'fb1', parentId: 'sB', objectType: 'function', name: 'b1' },
        ];
        const memberIds = new Set(['fa1', 'fb1']);

        const result = computeImplementingServices({ objects, memberIds });

        expect(result.map((r) => r.serviceObjectId)).toEqual(['sB', 'sA']);
    });
});
