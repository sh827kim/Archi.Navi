/**
 * Domain Summary Formatter (Phase 2, 2-4)
 *
 * DOMAIN_SUMMARY 쿼리 결과를 LLM 시스템 프롬프트 주입용 텍스트로 변환한다.
 *
 * 설계 참조: docs/04-query-engine.md §5.4 DOMAIN_SUMMARY
 * 로드맵: docs/08-roadmap.md §2-4
 *
 * 출력 형식:
 *   [도메인 요약 — 주문 도메인]
 *   멤버 수: 5개
 *   타입별: service: 3, db_table: 2
 *   평균 소속도: 0.85
 *   평균 순도: 0.78
 *   관계 밀도: 0.167
 *
 *   주요 멤버:
 *     - order-service (service, affinity: 0.95)
 *   ...
 */
import type { DomainSummaryData } from '../query-engine/domainSummary';

/** 도메인 목록 요약 구조 */
interface DomainListSummary {
    type: 'DOMAIN_LIST';
    domainCount: number;
    domains: Array<{ id: string; name: string; displayName?: string | null }>;
}

// ─── 텍스트 포맷터 ────────────────────────────────────────────────────────────

/**
 * DOMAIN_SUMMARY 집계 결과 → LLM 컨텍스트 텍스트 변환
 *
 * domainId가 없는 경우(전체 도메인 목록)와
 * 특정 도메인 상세 집계 두 가지 형식을 처리한다.
 */
export function formatDomainSummary(summary: Record<string, unknown>): string {
    if (!summary || typeof summary !== 'object') return '';

    // 전체 도메인 목록 케이스
    if (summary['type'] === 'DOMAIN_LIST') {
        return formatDomainList(summary as unknown as DomainListSummary);
    }

    // 단일 도메인 상세 집계 케이스
    const data = summary as unknown as DomainSummaryData;
    if (!data.domainId || data.memberCount === undefined) return '';

    return formatSingleDomain(data);
}

/**
 * DOMAIN_SUMMARY 응답에 대한 Answer Composer 형식 지침 생성
 *
 * route.ts 시스템 프롬프트 말미에 추가되어 LLM 출력 형식을 강제한다.
 * 빈 summary면 빈 문자열 반환.
 */
export function buildDomainAnswerComposerPrompt(summary: Record<string, unknown>): string {
    if (!summary || typeof summary !== 'object') return '';

    if (summary['type'] === 'DOMAIN_LIST') {
        const data = summary as unknown as DomainListSummary;
        return `

## Answer Composer 응답 형식 (도메인 목록)

위 도메인 목록을 바탕으로 반드시 아래 형식으로 답변하세요:

**결론:** [워크스페이스 내 도메인 구성 한 문장 요약]
**신뢰도:** [데이터 충분도 기반 0.0~1.0]
**도메인 목록:**
- [도메인 1 이름과 특성]
- [도메인 2 이름과 특성]
**요약:** [전체 도메인 구조 요약 (2-3 문장)]
**딥링크:** /mapping?level=DOMAIN_TO_DOMAIN

규칙:
- 이 형식을 반드시 유지하세요
- 목록에 없는 도메인은 언급하지 마세요
- 총 ${data.domainCount}개 도메인을 참고하세요`;
    }

    const data = summary as unknown as DomainSummaryData;
    if (!data.domainId) return '';

    const confidence = data.avgAffinity?.toFixed(2) ?? '0.00';
    const deepLink = `/mapping?highlight=${data.domainId}`;

    return `

## Answer Composer 응답 형식 (도메인 요약)

위 집계 결과를 바탕으로 반드시 아래 형식으로 답변하세요:

**결론:** [${data.domainName} 도메인의 역할과 특성 한 문장]
**신뢰도:** [평균 소속도 기반, 예: ${confidence}]
**멤버 목록:**
- [주요 멤버와 역할]
- [추가 멤버...]
**요약:** [도메인 구조 요약 (2-3 문장): 멤버 수, 관계 밀도, 외부 의존도 포함]
**딥링크:** ${deepLink}

규칙:
- 이 형식을 반드시 유지하세요
- 집계 데이터에 없는 사실은 추가하지 마세요`;
}

// ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────

function formatDomainList(data: DomainListSummary): string {
    if (data.domainCount === 0) return '';

    const lines: string[] = [];
    lines.push(`[도메인 목록]`);
    lines.push(`총 ${data.domainCount}개 도메인:`);

    for (const d of data.domains) {
        lines.push(`- ${d.displayName ?? d.name} (id: ${d.id})`);
    }

    return lines.join('\n');
}

function formatSingleDomain(data: DomainSummaryData): string {
    const lines: string[] = [];

    lines.push(`[도메인 요약 — ${data.domainName}]`);
    lines.push(`멤버 수: ${data.memberCount}개`);

    if (data.membersByType && Object.keys(data.membersByType).length > 0) {
        const typeBreakdown = Object.entries(data.membersByType)
            .map(([type, count]) => `${type}: ${count}`)
            .join(', ');
        lines.push(`타입별: ${typeBreakdown}`);
    }

    lines.push(`평균 소속도(affinity): ${data.avgAffinity.toFixed(2)}`);

    if (data.avgPurity !== null && data.avgPurity !== undefined) {
        lines.push(`평균 순도(purity): ${data.avgPurity.toFixed(2)}`);
    }

    lines.push(`관계 밀도: ${data.relationDensity.toFixed(3)}`);

    if (data.topMembers.length > 0) {
        lines.push('');
        lines.push('주요 멤버:');
        for (const member of data.topMembers) {
            lines.push(`  - ${member.name} (${member.objectType}, affinity: ${member.affinity.toFixed(2)})`);
        }
    }

    if (data.externalDependencies.length > 0) {
        lines.push('');
        lines.push('외부 의존 도메인:');
        for (const dep of data.externalDependencies) {
            lines.push(`  - ${dep.domainId} (${dep.relationType}, weight: ${dep.edgeWeight}, confidence: ${dep.confidence.toFixed(2)})`);
        }
    }

    return lines.join('\n');
}
