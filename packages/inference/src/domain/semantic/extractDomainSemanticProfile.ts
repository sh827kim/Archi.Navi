/**
 * 도메인 의미 프로파일 추출 오케스트레이터
 * fetch → collect → extract scenarios → compose(LLM) → persist 를 묶은 상위 함수.
 * LLM 호출은 주입된 GenerateSemanticProfileFn 에 위임.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { domainSemanticProfiles } from '@archi-navi/db';
import type { DomainSemanticProfile } from '@archi-navi/shared';
import { collectDomainSemanticSignals } from './semanticSignalCollector';
import { extractScenarioCandidates } from './scenarioExtractor';
import { composeDomainSemanticProfile, type GenerateSemanticProfileFn } from './semanticComposer';
import { fetchDomainSemanticInputs } from './fetchDomainSemanticInputs';

export interface ExtractDomainSemanticProfileArgs {
    workspaceId: string;
    domainId: string;
    llmModel: string;
    generatedBy?: string;
    /** 최대 시나리오 후보 수 (기본 5) */
    maxScenarios?: number;
    /** persist=false 로 주면 DB 저장 없이 draft 만 반환 (dry-run) */
    persist?: boolean;
}

export interface ExtractDomainSemanticProfileResult {
    profile: DomainSemanticProfile;
    persisted: boolean;
}

export async function extractDomainSemanticProfile(
    db: DbClient,
    generate: GenerateSemanticProfileFn,
    args: ExtractDomainSemanticProfileArgs,
): Promise<ExtractDomainSemanticProfileResult> {
    const persist = args.persist ?? true;
    const generatedBy = args.generatedBy ?? 'manual';

    const inputs = await fetchDomainSemanticInputs(db, {
        workspaceId: args.workspaceId,
        domainId: args.domainId,
    });

    const signals = collectDomainSemanticSignals(inputs);
    const scenarioOpts = args.maxScenarios != null ? { maxScenarios: args.maxScenarios } : {};
    const scenarios = extractScenarioCandidates(signals, scenarioOpts);
    const profile = await composeDomainSemanticProfile(
        {
            workspaceId: args.workspaceId,
            signals,
            scenarios,
            llmModel: args.llmModel,
        },
        generate,
    );

    if (!persist) return { profile, persisted: false };

    await db
        .insert(domainSemanticProfiles)
        .values({
            workspaceId: args.workspaceId,
            domainId: args.domainId,
            schemaVersion: profile.schemaVersion,
            domainName: profile.domainName,
            responsibility: profile.responsibility,
            state: profile.state,
            actions: profile.actions,
            invariants: profile.invariants,
            events: profile.events,
            collaborators: profile.collaborators,
            scenarios: profile.scenarios,
            evidence: profile.evidence,
            status: profile.status,
            generatedAt: new Date(profile.generatedAt),
            generatedBy,
            llmModel: profile.llmModel,
        })
        .onConflictDoUpdate({
            target: [domainSemanticProfiles.workspaceId, domainSemanticProfiles.domainId],
            set: {
                schemaVersion: profile.schemaVersion,
                domainName: profile.domainName,
                responsibility: profile.responsibility,
                state: profile.state,
                actions: profile.actions,
                invariants: profile.invariants,
                events: profile.events,
                collaborators: profile.collaborators,
                scenarios: profile.scenarios,
                evidence: profile.evidence,
                status: profile.status,
                generatedAt: new Date(profile.generatedAt),
                generatedBy,
                llmModel: profile.llmModel,
                updatedAt: sql`now()`,
            },
        });

    return { profile, persisted: true };
}

export async function getDomainSemanticProfile(
    db: DbClient,
    args: { workspaceId: string; domainId: string },
): Promise<DomainSemanticProfile | null> {
    const rows = await db
        .select()
        .from(domainSemanticProfiles)
        .where(
            and(
                eq(domainSemanticProfiles.workspaceId, args.workspaceId),
                eq(domainSemanticProfiles.domainId, args.domainId),
            ),
        )
        .limit(1);
    const row = rows[0];
    if (!row) return null;

    return {
        schemaVersion: '1.0',
        workspaceId: row.workspaceId,
        domainId: row.domainId,
        domainName: row.domainName,
        responsibility: row.responsibility,
        state: row.state,
        actions: row.actions,
        invariants: row.invariants,
        events: row.events,
        collaborators: row.collaborators,
        scenarios: row.scenarios,
        evidence: row.evidence,
        status: row.status,
        generatedAt: row.generatedAt.toISOString(),
        llmModel: row.llmModel,
    };
}
