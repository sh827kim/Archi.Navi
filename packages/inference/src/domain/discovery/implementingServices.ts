/**
 * 도메인 발견/승인 공용 유틸 — 멤버 집합을 기준으로 각 부모 서비스의
 * "얼마나 이 도메인을 구현하는가" 를 집계한다.
 *
 * 규칙 (설계 §4.3):
 *  - "자식" 은 objectType IN ('function', 'api_endpoint') 로 제한
 *  - childInDomain = 멤버 집합 ∩ (해당 service 의 코드 자식)
 *  - childTotal = 해당 service 의 코드 자식 총수 (워크스페이스 한정)
 *  - childTotal = 0 이면 결과에서 제외
 *  - confidence = childInDomain / childTotal
 *  - 결과는 confidence 내림차순, tie-break 는 serviceObjectId 사전순
 */
export interface ImplementingServiceRow {
    serviceObjectId: string;
    serviceName: string;
    childInDomain: number;
    childTotal: number;
    confidence: number;
}

export interface ComputeImplementingServicesInput {
    /** 대상 워크스페이스의 객체 전량 — id/parentId/objectType/name 만 필요 */
    objects: Array<{
        id: string;
        parentId: string | null;
        objectType: string;
        name: string;
    }>;
    /** "이 도메인에 속한다" 로 간주할 객체 id 집합 */
    memberIds: Set<string>;
}

const CODE_CHILD_TYPES = new Set(['function', 'api_endpoint']);

export function computeImplementingServices(
    input: ComputeImplementingServicesInput,
): ImplementingServiceRow[] {
    const serviceById = new Map<string, { id: string; name: string }>();
    for (const obj of input.objects) {
        if (obj.objectType === 'service') {
            serviceById.set(obj.id, { id: obj.id, name: obj.name });
        }
    }

    const childTotalByService = new Map<string, number>();
    const childInDomainByService = new Map<string, number>();

    for (const obj of input.objects) {
        if (!CODE_CHILD_TYPES.has(obj.objectType)) continue;
        if (!obj.parentId) continue;
        if (!serviceById.has(obj.parentId)) continue; // parent 가 service 인 자식만

        childTotalByService.set(
            obj.parentId,
            (childTotalByService.get(obj.parentId) ?? 0) + 1,
        );
        if (input.memberIds.has(obj.id)) {
            childInDomainByService.set(
                obj.parentId,
                (childInDomainByService.get(obj.parentId) ?? 0) + 1,
            );
        }
    }

    const rows: ImplementingServiceRow[] = [];
    for (const [serviceId, childTotal] of childTotalByService) {
        const childInDomain = childInDomainByService.get(serviceId) ?? 0;
        if (childInDomain === 0) continue; // 기여 없음은 행 생성 안 함
        const service = serviceById.get(serviceId)!;
        rows.push({
            serviceObjectId: serviceId,
            serviceName: service.name,
            childInDomain,
            childTotal,
            confidence: childInDomain / childTotal,
        });
    }

    rows.sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return a.serviceObjectId.localeCompare(b.serviceObjectId);
    });

    return rows;
}
