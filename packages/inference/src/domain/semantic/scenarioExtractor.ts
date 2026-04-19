/**
 * 시나리오 진입점 추출기 (순수 함수)
 * CollectedSemanticSignals 의 actions/events 중 외부 트리거에 해당하는 것을
 * "후보 시나리오 진입점" 으로 변환한다. 각 시나리오의 단계 묘사는 LLM 합성 단계에서 이뤄지며
 * 여기서는 LLM 입력으로 줄 후보 셋을 만든다.
 */
import type { ActionCandidate, CollectedSemanticSignals, EventCandidate } from './types';

export interface ScenarioCandidate {
    /** 사람이 읽을 한 줄 제목 (예: "POST /api/v1/orders 요청 처리") */
    title: string;
    /** 진입 트리거 종류 */
    trigger: 'http' | 'message';
    /** 진입점이 속한 도메인 멤버 객체 id */
    entryPointObjectId: string;
    /** 후보의 한 줄 설명 (LLM 단계 입력 컨텍스트로 그대로 사용) */
    description: string;
    /** 같은 후보가 반복돼도 누적되는 evidence id 목록 */
    evidenceIds: string[];
}

export interface ScenarioExtractorOptions {
    /** 최대 후보 수 (기본 5) */
    maxScenarios?: number;
}

const DEFAULT_MAX = 5;

function httpScenarioKey(action: ActionCandidate): string {
    return `http|${action.method ?? ''}|${action.path ?? ''}|${action.sourceObjectId}`;
}

function messageScenarioKey(event: EventCandidate): string {
    return `message|${event.channel}|${event.sourceObjectId}`;
}

function buildHttpScenario(action: ActionCandidate): ScenarioCandidate {
    const method = action.method ?? 'HTTP';
    const path = action.path ?? '(unknown path)';
    return {
        title: `${method} ${path} 요청 처리`,
        trigger: 'http',
        entryPointObjectId: action.sourceObjectId,
        description: `HTTP ${method} ${path} 진입점에서 시작되는 시나리오`,
        evidenceIds: [...action.evidenceIds],
    };
}

function buildMessageScenario(event: EventCandidate): ScenarioCandidate {
    return {
        title: `${event.channel} 메시지 수신 처리`,
        trigger: 'message',
        entryPointObjectId: event.sourceObjectId,
        description: `${event.channel} 채널에서 메시지를 수신해 처리하는 시나리오`,
        evidenceIds: [...event.evidenceIds],
    };
}

function mergeEvidenceIds(target: ScenarioCandidate, additions: string[]): void {
    const merged = new Set([...target.evidenceIds, ...additions]);
    target.evidenceIds = [...merged];
}

export function extractScenarioCandidates(
    signals: CollectedSemanticSignals,
    options: ScenarioExtractorOptions = {},
): ScenarioCandidate[] {
    const max = options.maxScenarios ?? DEFAULT_MAX;
    const bucket = new Map<string, ScenarioCandidate>();

    for (const action of signals.actions) {
        if (action.trigger !== 'http') continue;
        const key = httpScenarioKey(action);
        const existing = bucket.get(key);
        if (existing) {
            mergeEvidenceIds(existing, action.evidenceIds);
        } else {
            bucket.set(key, buildHttpScenario(action));
        }
    }

    for (const event of signals.events) {
        // 외부에서 들어오는 트리거(consume) 만 시나리오 진입점으로 본다.
        if (event.direction !== 'consume') continue;
        const key = messageScenarioKey(event);
        const existing = bucket.get(key);
        if (existing) {
            mergeEvidenceIds(existing, event.evidenceIds);
        } else {
            bucket.set(key, buildMessageScenario(event));
        }
    }

    return [...bucket.values()].slice(0, max);
}
