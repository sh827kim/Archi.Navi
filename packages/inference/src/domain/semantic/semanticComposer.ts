/**
 * 도메인 의미 프로파일 합성기
 * 신호 수집 결과 + 시나리오 진입점 후보 + LLM draft 를 합쳐 최종 DomainSemanticProfile 로 만든다.
 * LLM 호출은 DI(generate) 로 주입받아 테스트/프로바이더 교체가 쉽게.
 */
import type {
    DomainSemanticAction,
    DomainSemanticCollaborator,
    DomainSemanticEvent,
    DomainSemanticInvariant,
    DomainSemanticProfile,
    DomainSemanticScenario,
    DomainSemanticState,
} from '@archi-navi/shared';
import { buildSemanticPrompt } from '../../llm/semanticPrompt';
import type { ScenarioCandidate } from './scenarioExtractor';
import type { CollectedSemanticSignals } from './types';

export interface SemanticComposerInputs {
    workspaceId: string;
    signals: CollectedSemanticSignals;
    scenarios: ScenarioCandidate[];
    llmModel: string;
}

/** LLM 이 반환한 원시 draft (evidenceIds 검증 전) */
export interface SemanticLlmDraft {
    responsibility: string;
    state: DomainSemanticState[];
    actions: DomainSemanticAction[];
    invariants: DomainSemanticInvariant[];
    events: DomainSemanticEvent[];
    collaborators: DomainSemanticCollaborator[];
    scenarios: DomainSemanticScenario[];
}

/** LLM 호출 추상화 — prompt + inputs → draft */
export type GenerateSemanticProfileFn = (
    prompt: string,
    inputs: SemanticComposerInputs,
) => Promise<SemanticLlmDraft>;

function sanitizeEvidenceIds<T extends { evidenceIds: string[] }>(item: T, valid: Set<string>): T {
    return { ...item, evidenceIds: item.evidenceIds.filter((id) => valid.has(id)) };
}

export async function composeDomainSemanticProfile(
    inputs: SemanticComposerInputs,
    generate: GenerateSemanticProfileFn,
): Promise<DomainSemanticProfile> {
    const prompt = buildSemanticPrompt({ signals: inputs.signals, scenarios: inputs.scenarios });
    const draft = await generate(prompt, inputs);
    const validEvidenceIds = new Set(inputs.signals.evidence.map((e) => e.id));

    return {
        schemaVersion: '1.0',
        workspaceId: inputs.workspaceId,
        domainId: inputs.signals.domainId,
        domainName: inputs.signals.domainName,
        responsibility: draft.responsibility,
        state: draft.state.map((s) => sanitizeEvidenceIds(s, validEvidenceIds)),
        actions: draft.actions.map((a) => sanitizeEvidenceIds(a, validEvidenceIds)),
        invariants: draft.invariants.map((i) => sanitizeEvidenceIds(i, validEvidenceIds)),
        events: draft.events.map((e) => sanitizeEvidenceIds(e, validEvidenceIds)),
        collaborators: draft.collaborators.map((c) => sanitizeEvidenceIds(c, validEvidenceIds)),
        scenarios: draft.scenarios.map((s) => sanitizeEvidenceIds(s, validEvidenceIds)),
        evidence: inputs.signals.evidence,
        status: 'DRAFT',
        generatedAt: new Date().toISOString(),
        llmModel: inputs.llmModel,
    };
}
