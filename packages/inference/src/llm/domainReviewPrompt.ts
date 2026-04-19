/**
 * Phase 1 도메인 발견 — LLM 검토 단계 프롬프트 빌더.
 * 결정적 클러스터링이 산출한 후보의 "도메인 일관성" 만 검수한다.
 * 응답 zod 스키마는 호출 측(adapter) 에서 강제한다.
 */

export interface DomainReviewPromptInputs {
    candidateId: string;
    /** 자동 라벨 슬러그 — 사용자가 인라인 편집할 가능성을 안내 */
    autoName: string;
    /** 멤버 객체 이름 5~10개 (서비스/엔터티 우선) */
    memberNames: string[];
    /** 강한 신호 3종 (path/route/topic prefix 각 1개) */
    signals: {
        topPathPrefix: string | null;
        topRoutePrefix: string | null;
        topTopicPrefix: string | null;
    };
    /** 함께 검토되는 다른 후보들의 슬러그 — 병합 권장 시 mergeWithCandidateId 로 참조 */
    siblingCandidateIds: string[];
}

function formatSignals(signals: DomainReviewPromptInputs['signals']): string {
    const lines: string[] = [];
    if (signals.topPathPrefix) lines.push(`- path prefix: ${signals.topPathPrefix}`);
    if (signals.topRoutePrefix) lines.push(`- route prefix: ${signals.topRoutePrefix}`);
    if (signals.topTopicPrefix) lines.push(`- topic prefix: ${signals.topTopicPrefix}`);
    if (lines.length === 0) lines.push('(강한 신호 없음 — 멤버 이름만 참고)');
    return lines.join('\n');
}

function formatMembers(names: string[]): string {
    if (names.length === 0) return '(멤버 없음)';
    return names.slice(0, 10).map((n) => `- ${n}`).join('\n');
}

function formatSiblings(ids: string[]): string {
    if (ids.length === 0) return '(없음)';
    return ids.map((id) => `- ${id}`).join('\n');
}

export function buildDomainReviewPrompt(inputs: DomainReviewPromptInputs): string {
    return [
        `당신은 소프트웨어 아키텍트다. 결정적 신호로 묶인 도메인 후보 그룹이 일관된 도메인인지 짧게 검토한다.`,
        ``,
        `# 후보`,
        `- id: ${inputs.candidateId}`,
        `- 자동 라벨: ${inputs.autoName}`,
        ``,
        `# 강한 신호`,
        formatSignals(inputs.signals),
        ``,
        `# 멤버 객체 (최대 10개)`,
        formatMembers(inputs.memberNames),
        ``,
        `# 함께 검토된 다른 후보 id`,
        formatSiblings(inputs.siblingCandidateIds),
        ``,
        `# 출력 규칙`,
        `1. 응답은 제공된 JSON 스키마를 엄격히 준수한다.`,
        `2. coherent 는 멤버들이 한 도메인 책임으로 묶일 수 있을 때 true.`,
        `3. suggestedName 은 한국어 권장 (영문도 허용). 자동 라벨이 충분히 좋다면 그대로 사용.`,
        `4. responsibilityHint 는 1문장 한국어. "이 도메인이 무엇을 책임지는지"의 가설.`,
        `5. 다른 후보와 사실상 동일하다면 mergeWithCandidateId 에 그 id 를 넣는다. 확실하지 않으면 생략.`,
    ].join('\n');
}
