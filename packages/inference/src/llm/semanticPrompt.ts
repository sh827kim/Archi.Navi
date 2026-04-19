/**
 * 도메인 의미 프로파일 합성 프롬프트 빌더
 * 순수 함수: 신호 + 시나리오 후보를 한국어 프롬프트로 직렬화한다.
 * LLM 응답 스키마 강제는 provider 쪽에서 zod 로 수행하고, 여기서는 입력 포맷팅만 담당.
 */
import type { CollectedSemanticSignals } from '../domain/semantic/types';
import type { ScenarioCandidate } from '../domain/semantic/scenarioExtractor';

export interface SemanticPromptInputs {
    signals: CollectedSemanticSignals;
    scenarios: ScenarioCandidate[];
}

function formatMember(m: CollectedSemanticSignals['members'][number]): string {
    const name = m.displayName ?? m.name;
    return `- [${m.objectType}] ${name} (id: ${m.id})`;
}

function formatAction(a: CollectedSemanticSignals['actions'][number]): string {
    const parts = [a.name, `trigger=${a.trigger}`];
    if (a.method) parts.push(`method=${a.method}`);
    if (a.path) parts.push(`path=${a.path}`);
    if (a.channel) parts.push(`channel=${a.channel}`);
    parts.push(`source=${a.sourceObjectId}`);
    parts.push(`evidence=[${a.evidenceIds.join(', ')}]`);
    return `- ${parts.join(' | ')}`;
}

function formatEvent(e: CollectedSemanticSignals['events'][number]): string {
    return `- ${e.direction} ${e.channel} | source=${e.sourceObjectId} | evidence=[${e.evidenceIds.join(', ')}]`;
}

function formatDbAccess(d: CollectedSemanticSignals['dbAccesses'][number]): string {
    const tableRef = d.schema ? `${d.schema}.${d.table}` : d.table;
    return `- ${tableRef} | source=${d.sourceObjectId} | evidence=[${d.evidenceIds.join(', ')}]`;
}

function formatCollaborator(c: CollectedSemanticSignals['collaborators'][number]): string {
    const domain = c.targetDomainId ? ` (domain: ${c.targetDomainId})` : '';
    return `- ${c.relationType} → ${c.targetName}${domain} | ${c.reason}`;
}

function formatScenario(s: ScenarioCandidate): string {
    return `- [${s.trigger}] ${s.title} | entry=${s.entryPointObjectId}`;
}

function formatEvidence(ev: CollectedSemanticSignals['evidence'][number]): string {
    const range = ev.startLine != null ? `:${ev.startLine}${ev.endLine != null ? `-${ev.endLine}` : ''}` : '';
    const excerpt = ev.excerpt ? ` :: ${ev.excerpt.slice(0, 160)}` : '';
    return `- ${ev.id} → ${ev.filePath}${range}${excerpt}`;
}

function section(title: string, body: string): string {
    return `## ${title}\n${body || '(없음)'}`;
}

export function buildSemanticPrompt(inputs: SemanticPromptInputs): string {
    const { signals, scenarios } = inputs;

    const members = signals.members.map(formatMember).join('\n');
    const actions = signals.actions.map(formatAction).join('\n');
    const events = signals.events.map(formatEvent).join('\n');
    const dbAccesses = signals.dbAccesses.map(formatDbAccess).join('\n');
    const collaborators = signals.collaborators.map(formatCollaborator).join('\n');
    const scenarioList = scenarios.map(formatScenario).join('\n');
    const evidenceList = signals.evidence.map(formatEvidence).join('\n');

    return [
        `당신은 소프트웨어 아키텍트이자 도메인 전문가다.`,
        `주어진 도메인의 신호를 근거로 "도메인 의미 프로파일"을 한국어로 합성한다.`,
        ``,
        `# 도메인`,
        `- id: ${signals.domainId}`,
        `- 이름: ${signals.domainName}`,
        ``,
        `# 입력 신호`,
        section('멤버 객체', members),
        section('외부 노출 액션 (HTTP/메시지)', actions),
        section('이벤트 (publish/consume)', events),
        section('DB 접근', dbAccesses),
        section('협력 (다른 도메인/객체)', collaborators),
        section('시나리오 진입점 후보', scenarioList),
        section('Evidence 풀 (ev-id → 파일:라인 + 발췌)', evidenceList),
        ``,
        `# 출력 규칙`,
        `1. 응답은 제공된 JSON 스키마를 엄격히 준수한다.`,
        `2. 모든 항목(state/actions/invariants/events/collaborators/scenarios)은 Evidence 풀에 존재하는 id 만 evidenceIds 로 참조한다.`,
        `3. 신호에 없는 사실은 지어내지 않는다. 추론은 짧고 근거 가능한 수준으로만.`,
        `4. responsibility 는 1~3문장, 신규 입사자가 이 도메인이 무엇을 책임지는지 즉시 이해할 수 있게 작성.`,
        `5. scenarios 는 제공된 진입점 후보를 바탕으로 1~5개, 각 항목의 steps 는 1~7개의 자연어 단계.`,
    ].join('\n');
}
