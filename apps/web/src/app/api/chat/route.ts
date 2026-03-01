/**
 * POST /api/chat — AI 질의 스트리밍 응답
 * Vercel AI SDK 기반, 다중 AI 제공자 지원
 * - OPENAI_API_KEY → OpenAI GPT-4o
 * - ANTHROPIC_API_KEY → Claude Sonnet
 * - GOOGLE_GENERATIVE_AI_API_KEY → Gemini Pro
 */
import {
  streamText,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from 'ai';
import type { UIMessage } from 'ai';
import { openai, createOpenAI } from '@ai-sdk/openai';
import { anthropic, createAnthropic } from '@ai-sdk/anthropic';
import { google, createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { getDb, objects, objectRelations } from '@archi-navi/db';
import { eq, and, ilike, or, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
  executeQuery,
  assembleEvidenceChain,
  formatEvidenceChain,
  buildAnswerComposerSystemPrompt,
  formatDomainSummary,
  buildDomainAnswerComposerPrompt,
} from '@archi-navi/core';
import type { QueryScope } from '@archi-navi/shared';
import { DEFAULT_WORKSPACE_ID } from '@archi-navi/shared';

/** AI 제공자 선택 (헤더 오버라이드 → 환경변수 fallback) */
function getModel(req: Request): LanguageModel {
  // 설정 화면에서 전달한 헤더 우선 적용
  const headerProvider = req.headers.get('x-ai-provider');
  const headerApiKey = req.headers.get('x-ai-api-key');
  const headerModel = req.headers.get('x-ai-model');

  const provider = headerProvider ?? process.env['AI_PROVIDER'] ?? 'openai';

  // W-8.2: process.env 동적 덮어쓰기 대신 SDK factory로 인스턴스 생성
  // → 동시 요청 시 API 키 race condition 해소
  switch (provider) {
    case 'anthropic': {
      const modelName = headerModel ?? 'claude-3-5-sonnet-20241022';
      const sdk = headerApiKey ? createAnthropic({ apiKey: headerApiKey }) : anthropic;
      return sdk(modelName);
    }
    case 'google': {
      const modelName = headerModel ?? 'gemini-1.5-pro';
      const sdk = headerApiKey ? createGoogleGenerativeAI({ apiKey: headerApiKey }) : google;
      return sdk(modelName);
    }
    default: {
      const modelName = headerModel ?? 'gpt-4o';
      const sdk = headerApiKey ? createOpenAI({ apiKey: headerApiKey }) : openai;
      return sdk(modelName);
    }
  }
}

/**
 * LIKE/ILIKE 패턴에서 특수문자를 이스케이프한다.
 * 사용자 입력이 `%`, `_`, `\` 를 포함할 경우 와일드카드로 해석되는 것을 방지.
 */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

/**
 * 메시지에서 서비스/오브젝트 이름 후보를 순서대로 추출
 * 우선순위: xxx-service > xxx-db > xxx-gateway > 일반 kebab-case
 */
function extractMentionedNames(message: string): string[] {
  // 하이픈 포함 영문 식별자 전체 추출 (캡처 그룹 m[1] 보장)
  const allTokens = [...message.matchAll(/\b([a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)+)\b/g)]
    .map((m) => m[1])
    .filter((t): t is string => t !== undefined)
    .map((t) => t.toLowerCase());

  // known suffix 우선 정렬
  const priority = ['service', 'db', 'database', 'gateway', 'cluster', 'broker', 'server'];
  const high = allTokens.filter((t) => priority.some((s) => t.endsWith(s) || t.endsWith(`-${s}`)));
  const rest = allTokens.filter((t) => !high.includes(t));

  // 중복 제거 유지
  return [...new Set([...high, ...rest])];
}

/**
 * DB에서 이름으로 Object ID 조회 (부분 일치, 대소문자 무시)
 * 여러 이름 후보를 순서대로 시도해 첫 번째 매칭 반환
 */
async function resolveObjectId(
  db: DbClient,
  workspaceId: string,
  names: string[],
): Promise<string | null> {
  if (names.length === 0) return null;

  // 각 이름 후보를 OR 조건으로 한 번에 조회 (LIKE 특수문자 이스케이프 적용)
  const conditions = names.map((name) => ilike(objects.name, `%${escapeLike(name)}%`));
  const rows = await db
    .select({ id: objects.id, name: objects.name })
    .from(objects)
    .where(and(eq(objects.workspaceId, workspaceId), or(...conditions)))
    .limit(names.length);

  if (rows.length === 0) return null;

  // 우선순위 높은 이름부터 매칭되는 row 반환
  for (const name of names) {
    const matched = rows.find((r) => r.name.toLowerCase().includes(name));
    if (matched) return matched.id;
  }
  return rows[0]?.id ?? null;
}

/**
 * 메시지에서 도메인 이름을 추출하고 DB에서 domain Object ID를 조회한다.
 * "주문 도메인", "결제 도메인" 등 한국어/영어 도메인 이름 패턴 인식.
 * W-8.3: DOMAIN_SUMMARY 쿼리에 특정 domainId를 전달하기 위해 사용.
 */
async function resolveDomainId(
  db: DbClient,
  workspaceId: string,
  message: string,
): Promise<string | null> {
  // "XXX 도메인" 또는 "domain XXX" 패턴에서 도메인명 추출
  const patterns = [
    /(\S+)\s*도메인/g, // 한국어: "주문 도메인", "결제 도메인"
    /domain\s+(\S+)/gi, // 영어: "domain order", "domain payment"
  ];

  const candidates: string[] = [];
  for (const pattern of patterns) {
    for (const match of message.matchAll(pattern)) {
      const name = match[1]?.trim();
      if (name && name.length > 1) {
        candidates.push(name.toLowerCase());
      }
    }
  }

  // kebab-case 토큰(하이픈 포함 식별자만) 추가 — 단일 영단어는 false positive가 높으므로 제외
  const kebabTokens = [...message.matchAll(/\b([a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)+)\b/g)]
    .map((m) => m[1]?.toLowerCase())
    .filter((t): t is string => !!t);
  for (const token of kebabTokens) {
    if (!candidates.includes(token)) {
      candidates.push(token);
    }
  }

  if (candidates.length === 0) return null;

  // domain objectType인 것만 조회 (LIKE 특수문자 이스케이프 적용)
  const conditions = candidates.map((name) => {
    const escaped = escapeLike(name);
    return or(ilike(objects.name, `%${escaped}%`), ilike(objects.displayName, `%${escaped}%`));
  });
  const rows = await db
    .select({ id: objects.id, name: objects.name, displayName: objects.displayName })
    .from(objects)
    .where(
      and(
        eq(objects.workspaceId, workspaceId),
        eq(objects.objectType, 'domain'),
        or(...conditions),
      ),
    )
    .limit(candidates.length);

  if (rows.length === 0) return null;

  // 후보 이름 순서대로 매칭
  for (const name of candidates) {
    const matched = rows.find(
      (r) =>
        r.name.toLowerCase().includes(name) ||
        (r.displayName?.toLowerCase().includes(name) ?? false),
    );
    if (matched) return matched.id;
  }
  return rows[0]?.id ?? null;
}

/**
 * objectRelations 테이블 직접 조회 → LLM용 텍스트 컨텍스트 생성
 * rollup 데이터(inference 실행)가 없어도 동작하는 fallback
 *
 * @param direction  OUTBOUND: 이 서비스가 의존하는 것(발신)
 *                   INBOUND:  이 서비스에 의존하는 것(수신)
 *                   BOTH:     양방향
 */
async function buildRawRelationContext(
  db: DbClient,
  workspaceId: string,
  serviceId: string,
  direction: 'OUTBOUND' | 'INBOUND' | 'BOTH',
): Promise<string> {
  // 방향에 따라 조건 결정
  const condition =
    direction === 'OUTBOUND'
      ? eq(objectRelations.subjectObjectId, serviceId)
      : direction === 'INBOUND'
        ? eq(objectRelations.objectId, serviceId)
        : or(
            eq(objectRelations.subjectObjectId, serviceId),
            eq(objectRelations.objectId, serviceId),
          );

  const rows = await db
    .select({
      subjectId: objectRelations.subjectObjectId,
      targetId: objectRelations.objectId,
      relationType: objectRelations.relationType,
      confidence: objectRelations.confidence,
    })
    .from(objectRelations)
    .where(and(eq(objectRelations.workspaceId, workspaceId), condition));

  if (rows.length === 0) return '';

  // 관련 오브젝트 이름 일괄 조회
  const ids = [...new Set(rows.flatMap((r) => [r.subjectId, r.targetId]))];
  const nameRows = await db
    .select({ id: objects.id, name: objects.name })
    .from(objects)
    .where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, ids)));
  const nameMap = Object.fromEntries(nameRows.map((o) => [o.id, o.name]));

  const lines = rows.map(
    (r) =>
      `- ${nameMap[r.subjectId] ?? r.subjectId} --[${r.relationType}]--> ${nameMap[r.targetId] ?? r.targetId} (confidence: ${r.confidence ?? 0})`,
  );

  return `[관계 데이터 — objectRelations 직접 조회]\n총 ${rows.length}개의 관계:\n${lines.join('\n')}`;
}

/** 아키텍처 컨텍스트 시스템 프롬프트 */
const SYSTEM_PROMPT = `당신은 MSA 아키텍처 전문가 어시스턴트 'Archi.Navi'입니다.
사용자의 마이크로서비스 아키텍처에 대한 질문에 답하는 역할을 합니다.

주요 역할:
- 서비스 간 의존 관계 분석 (call, read, write, produce, consume)
- 영향 분석: 특정 서비스 변경 시 영향받는 서비스 파악
- 경로 탐색: A 서비스에서 B 서비스까지의 의존 경로
- 도메인 요약: 특정 도메인에 속하는 서비스 목록

답변 원칙:
- Evidence 기반으로만 답변합니다
- 불확실한 정보는 추측임을 명시합니다
- 구체적인 서비스 이름과 관계 타입을 포함합니다
- 한국어로 답변합니다`;

function createMockChatResponse(content: string): Response {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: 'start' });
      writer.write({ type: 'text-start', id: 'mock-text-0' });
      writer.write({ type: 'text-delta', id: 'mock-text-0', delta: content });
      writer.write({ type: 'text-end', id: 'mock-text-0' });
      writer.write({ type: 'finish', finishReason: 'stop' });
    },
  });

  return createUIMessageStreamResponse({ stream });
}

export async function POST(req: Request) {
  try {
    // useChat hook은 UIMessage[] 형식으로 전송 — ModelMessage[]로 변환 필요
    const { messages, workspaceId = DEFAULT_WORKSPACE_ID } = (await req.json()) as {
      messages: UIMessage[];
      workspaceId?: string;
    };

    // 마지막 사용자 메시지 텍스트 추출 (UIMessage의 parts 배열에서)
    const lastUserMessage = [...messages]
      .reverse()
      .find((m) => m.role === 'user')
      ?.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { type: 'text'; text: string }).text)
      .join('') ?? '';

    // 테스트/로컬 검증용 mock 응답 (외부 LLM API 키 없이 Chat 카드 렌더링 검증 가능)
    if (process.env['ARCHI_NAVI_CHAT_MOCK'] === '1') {
      const mockText = [
        '**결론:** order-service는 payment-service에 의존합니다.',
        '**신뢰도:** 0.91',
        '**증거 목록:**',
        '- order-service --[depend_on]--> payment-service',
        '**요약:** 설정 파일 기반 추론 결과를 승인 후 rollup과 query에서 동일 경로를 확인했습니다.',
        '**딥링크:** /mapping-graph',
      ].join('\n');
      return createMockChatResponse(mockText);
    }

    // 결정론적 쿼리로 Evidence Chain 수집 (Best-effort)
    let queryContext = '';
    try {
      const db = await getDb();
      const defaultScope: QueryScope = {
        level: 'SERVICE_TO_SERVICE',
        visibility: 'VISIBLE_ONLY',
      };

      // 메시지에서 서비스명 추출 → Object ID 해석
      const mentionedNames = extractMentionedNames(lastUserMessage);
      const primaryId = await resolveObjectId(db, workspaceId, mentionedNames);

      // 경로 탐색용 두 번째 서비스: 첫 번째와 다른 ID가 나오는 이름 탐색
      let secondaryId: string | null = null;
      for (let i = 1; i < mentionedNames.length; i++) {
        const name = mentionedNames[i];
        if (!name) continue;
        const candidate = await resolveObjectId(db, workspaceId, [name]);
        if (candidate && candidate !== primaryId) {
          secondaryId = candidate;
          break;
        }
      }

      // 쿼리 타입 자동 감지 (키워드 기반)
      let queryResponse = null;

      if (
        lastUserMessage.includes('영향') ||
        lastUserMessage.includes('impact') ||
        lastUserMessage.includes('의존')
      ) {
        // "영향받는" → 이 서비스에 의존하는 것 탐색 (UPSTREAM)
        // "의존하는" → 이 서비스가 의존하는 것 탐색 (DOWNSTREAM)
        const direction =
          lastUserMessage.includes('영향') && !lastUserMessage.includes('의존')
            ? 'UPSTREAM'
            : 'DOWNSTREAM';

        queryResponse = await executeQuery(db, {
          queryType: 'IMPACT_ANALYSIS',
          workspaceId,
          scope: defaultScope,
          // exactOptionalPropertyTypes: undefined를 직접 전달 불가 → 조건부 spread
          params: {
            ...(primaryId ? { targetObjectId: primaryId } : {}),
            direction,
          },
        });
      } else if (
        lastUserMessage.includes('경로') ||
        lastUserMessage.includes('path') ||
        lastUserMessage.includes('어떻게 연결')
      ) {
        queryResponse = await executeQuery(db, {
          queryType: 'PATH_DISCOVERY',
          workspaceId,
          scope: defaultScope,
          params: {
            ...(primaryId ? { fromObjectId: primaryId } : {}),
            ...(secondaryId ? { toObjectId: secondaryId } : {}),
          },
        });
      } else if (
        lastUserMessage.includes('사용') ||
        lastUserMessage.includes('usage') ||
        lastUserMessage.includes('호출')
      ) {
        queryResponse = await executeQuery(db, {
          queryType: 'USAGE_DISCOVERY',
          workspaceId,
          scope: defaultScope,
          params: {
            ...(primaryId ? { objectId: primaryId } : {}),
          },
        });
      } else if (
        lastUserMessage.includes('도메인') ||
        lastUserMessage.includes('domain') ||
        lastUserMessage.includes('도메인 요약')
      ) {
        // W-8.3: 메시지에서 도메인명 추출 → domainId 파라미터 전달
        const domainId = await resolveDomainId(db, workspaceId, lastUserMessage);
        queryResponse = await executeQuery(db, {
          queryType: 'DOMAIN_SUMMARY',
          workspaceId,
          scope: { ...defaultScope, level: 'DOMAIN_TO_DOMAIN' },
          params: {
            ...(domainId ? { domainId } : {}),
          },
        });
      }

      if (queryResponse) {
        if (queryResponse.queryType === 'DOMAIN_SUMMARY') {
          // DOMAIN_SUMMARY: 집계 결과 포맷 + Answer Composer 형식 지침
          const summaryText = formatDomainSummary(queryResponse.result.summary ?? {});
          const composerPrompt = buildDomainAnswerComposerPrompt(queryResponse.result.summary ?? {});
          if (summaryText) {
            queryContext = `\n\n${summaryText}${composerPrompt}`;
          }
        } else {
          // 그 외: Evidence Chain 조립 → 구조화된 텍스트 + Answer Composer 형식 지침 주입
          const chain = await assembleEvidenceChain(db, queryResponse);
          const formatted = formatEvidenceChain(chain);
          const composerPrompt = buildAnswerComposerSystemPrompt(chain);
          if (formatted) {
            queryContext = `\n\n${formatted}${composerPrompt}`;
          }
        }
      }

      // Rollup 데이터가 없어 queryContext가 비어있으면 objectRelations 직접 조회로 fallback
      // (inference 미실행 환경에서도 채팅이 동작하도록 보장)
      if (!queryContext && primaryId) {
        const direction =
          lastUserMessage.includes('영향') && !lastUserMessage.includes('의존')
            ? 'INBOUND'
            : lastUserMessage.includes('호출') && lastUserMessage.includes('누가')
              ? 'INBOUND'
              : 'OUTBOUND';

        const raw = await buildRawRelationContext(db, workspaceId, primaryId, direction);
        if (raw) {
          queryContext = `\n\n${raw}\n\n위 데이터를 바탕으로 질문에 답변해주세요. 관계 타입: call(API 호출), read(DB 읽기), write(DB 쓰기), produce(메시지 발행), consume(메시지 구독).`;
        }
      }
    } catch {
      // DB 미연결 또는 쿼리 실패 시 무시 — LLM이 일반 답변
    }

    const model = getModel(req);

    const result = streamText({
      model,
      system: SYSTEM_PROMPT + queryContext,
      // UIMessage[] → ModelMessage[] 변환 (AI SDK v6 요구사항, async 함수)
      messages: await convertToModelMessages(messages),
      maxOutputTokens: 2048,
      temperature: 0.3,
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    console.error('[POST /api/chat]', error);
    return new Response('AI 서비스 오류', { status: 500 });
  }
}
