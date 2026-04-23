export interface DomainReviewPromptInputs {
    candidateId: string;
    autoName: string;
    memberNames: string[];
    memberDetails: string[];
    signals: {
        topPathPrefix: string | null;
        topRoutePrefix: string | null;
        topTopicPrefix: string | null;
        topCodeFamily: string | null;
        topTableFamily: string | null;
        seedSourceSummary: Array<{ source: string; value: string }>;
    };
    siblingCandidateIds: string[];
}

function formatSignals(signals: DomainReviewPromptInputs['signals']): string {
    const lines: string[] = [];
    if (signals.topPathPrefix) lines.push(`- path prefix: ${signals.topPathPrefix}`);
    if (signals.topRoutePrefix) lines.push(`- route prefix: ${signals.topRoutePrefix}`);
    if (signals.topTopicPrefix) lines.push(`- topic prefix: ${signals.topTopicPrefix}`);
    if (signals.topCodeFamily) lines.push(`- code family: ${signals.topCodeFamily}`);
    if (signals.topTableFamily) lines.push(`- table family: ${signals.topTableFamily}`);
    if (signals.seedSourceSummary.length > 0) {
        lines.push(`- seed sources: ${signals.seedSourceSummary.map((s) => `${s.source}:${s.value}`).join(', ')}`);
    }
    if (lines.length === 0) lines.push('(강한 신호 없음 — 멤버 이름/세부 근거 참고)');
    return lines.join('\n');
}

function formatMembers(names: string[]): string {
    if (names.length === 0) return '(멤버 없음)';
    return names.map((n) => `- ${n}`).join('\n');
}

function formatMemberDetails(details: string[]): string {
    if (details.length === 0) return '(세부 근거 없음)';
    return details.map((line) => `- ${line}`).join('\n');
}

function formatSiblings(ids: string[]): string {
    if (ids.length === 0) return '(없음)';
    return ids.map((id) => `- ${id}`).join('\n');
}

export function buildDomainReviewPrompt(inputs: DomainReviewPromptInputs): string {
    return [
        '당신은 소프트웨어 아키텍트다. 결정적 신호로 묶인 도메인 후보 그룹이 일관된 도메인인지 검토한다.',
        '',
        '# 후보',
        `- id: ${inputs.candidateId}`,
        `- 자동 라벨: ${inputs.autoName}`,
        '',
        '# 강한 신호',
        formatSignals(inputs.signals),
        '',
        '# 멤버 객체 (전체)',
        formatMembers(inputs.memberNames),
        '',
        '# 멤버별 세부 근거 (전체)',
        formatMemberDetails(inputs.memberDetails),
        '',
        '# 함께 검토된 다른 후보 id',
        formatSiblings(inputs.siblingCandidateIds),
        '',
        '# 출력 규칙',
        '1. 응답은 제공된 JSON 스키마를 엄격히 준수한다.',
        '2. coherent 는 멤버들이 한 도메인 책임으로 묶일 수 있을 때 true.',
        '3. suggestedName 은 한국어 권장 (영문도 허용).',
        '4. responsibilityHint 는 1문장 한국어.',
        '5. mergeWithCandidateId 는 명확한 중복일 때만 설정한다.',
        '6. splitSuggestions 는 분할 후보를 실제 생성하기 위한 구조화된 제안이다. 없으면 []를 반환한다.',
        '7. splitSuggestions[].memberSelectors 는 멤버를 고를 수 있는 selector 배열이어야 한다.',
        '8. splitSuggestions 내부 모든 필드는 필수이며, confidence 는 0~1 범위여야 한다.',
    ].join('\n');
}
