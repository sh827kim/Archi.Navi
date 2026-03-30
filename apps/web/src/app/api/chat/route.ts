/**
 * POST /api/chat — AI 질의 스트리밍 응답
 * Vercel AI SDK 기반, 다중 AI 제공자 지원
 * - OPENAI_API_KEY → OpenAI GPT-4o
 * - ANTHROPIC_API_KEY → Claude Sonnet
 * - GOOGLE_GENERATIVE_AI_API_KEY → Gemini Pro
 */
import {
  streamText,
  generateObject,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from 'ai';
import type { UIMessage } from 'ai';
import { NextResponse } from 'next/server';
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
import type { EvidenceChain } from '@archi-navi/core';
import { z } from 'zod';

type ChatIntent =
  | 'SERVICE_ENDPOINTS'
  | 'SERVICE_OVERVIEW'
  | 'IMPACT_ANALYSIS'
  | 'PATH_DISCOVERY'
  | 'USAGE_DISCOVERY'
  | 'DOMAIN_SUMMARY'
  | 'GENERAL';

const CHAT_INTENT_VALUES = [
  'SERVICE_ENDPOINTS',
  'SERVICE_OVERVIEW',
  'IMPACT_ANALYSIS',
  'PATH_DISCOVERY',
  'USAGE_DISCOVERY',
  'DOMAIN_SUMMARY',
  'GENERAL',
] as const;

const chatIntentSchema = z.object({
  intent: z.enum(CHAT_INTENT_VALUES),
});

const EVIDENCE_CONTEXT_POOL_SIZE = 48;
const EVIDENCE_CONTEXT_MAX_ITEMS = 8;
const EVIDENCE_MIN_CONFIDENCE = 0.35;
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

function resolveProviderApiKey(provider: string, headerApiKey: string | null): string | null {
  if (headerApiKey) return headerApiKey;

  switch (provider) {
    case 'anthropic':
      return process.env['ANTHROPIC_API_KEY'] ?? null;
    case 'google':
      return process.env['GOOGLE_GENERATIVE_AI_API_KEY'] ?? null;
    default:
      return process.env['OPENAI_API_KEY'] ?? null;
  }
}

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
 * Intent Router 전용 소형 모델 선택.
 * 본 응답 모델과 분리해 비용을 줄이고, 실패 시 키워드 fallback을 사용한다.
 */
function getIntentRouterModel(req: Request): LanguageModel | null {
  const headerProvider = req.headers.get('x-ai-provider');
  const headerApiKey = req.headers.get('x-ai-api-key');
  const provider = headerProvider ?? process.env['AI_PROVIDER'] ?? 'openai';
  const apiKey = resolveProviderApiKey(provider, headerApiKey);
  if (!apiKey) return null;

  switch (provider) {
    case 'anthropic': {
      const sdk = headerApiKey ? createAnthropic({ apiKey }) : anthropic;
      return sdk('claude-3-5-haiku-20241022');
    }
    case 'google': {
      const sdk = headerApiKey ? createGoogleGenerativeAI({ apiKey }) : google;
      return sdk('gemini-1.5-flash');
    }
    default: {
      const sdk = headerApiKey ? createOpenAI({ apiKey }) : openai;
      return sdk('gpt-4o-mini');
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
  const phraseTokens = [...message.matchAll(/([가-힣A-Za-z0-9_-]+(?:\s+[가-힣A-Za-z0-9_-]+){0,2}\s*(?:서비스|service|도메인|domain))/gi)]
    .flatMap((m) => {
      const raw = m[1]?.trim();
      if (!raw) return [];
      const cleaned = raw.replace(/\s+(서비스|service|도메인|domain)$/i, '').trim();
      return cleaned && cleaned !== raw ? [cleaned, raw] : [raw];
    })
    .filter((t): t is string => !!t)
    .map((t) => t.toLowerCase());

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
  return [...new Set([...phraseTokens, ...high, ...rest])];
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
  const conditions = names.map((name) => {
    const escaped = escapeLike(name);
    return or(ilike(objects.name, `%${escaped}%`), ilike(objects.displayName, `%${escaped}%`));
  });
  const rows = await db
    .select({ id: objects.id, name: objects.name, displayName: objects.displayName })
    .from(objects)
    .where(and(eq(objects.workspaceId, workspaceId), or(...conditions)))
    .limit(names.length * 2);

  if (rows.length === 0) return null;

  // 우선순위 높은 이름부터 매칭되는 row 반환
  for (const name of names) {
    const normalizedName = name.toLowerCase();
    const exact = rows.find(
      (r) =>
        r.name.toLowerCase() === normalizedName ||
        (r.displayName?.toLowerCase() ?? '') === normalizedName,
    );
    if (exact) return exact.id;

    const matched = rows.find(
      (r) =>
        r.name.toLowerCase().includes(normalizedName) ||
        (r.displayName?.toLowerCase().includes(normalizedName) ?? false),
    );
    if (matched) return matched.id;
  }
  return rows[0]?.id ?? null;
}

function formatObjectLabel(object: {
  name: string;
  displayName: string | null;
}): string {
  return object.displayName ? `${object.displayName} (${object.name})` : object.name;
}

function detectChatIntentByKeyword(message: string): ChatIntent {
  const normalized = message.toLowerCase();
  const asksServiceEndpoints =
    /(api|endpoint|엔드포인트)/i.test(message)
    && /(어떤|뭐|무엇|목록|리스트|있지|있어|보여|알려|종류|제공)/i.test(message);

  if (asksServiceEndpoints) return 'SERVICE_ENDPOINTS';

  if (
    /개요|요약|설명|역할|overview|summary/i.test(message)
    && /(service|서비스)/i.test(message)
  ) {
    return 'SERVICE_OVERVIEW';
  }

  if (normalized.includes('영향') || normalized.includes('impact') || normalized.includes('의존')) {
    return 'IMPACT_ANALYSIS';
  }
  if (normalized.includes('경로') || normalized.includes('path') || normalized.includes('어떻게 연결')) {
    return 'PATH_DISCOVERY';
  }
  if (normalized.includes('사용') || normalized.includes('usage') || normalized.includes('호출')) {
    return 'USAGE_DISCOVERY';
  }
  if (normalized.includes('도메인') || normalized.includes('domain')) {
    return 'DOMAIN_SUMMARY';
  }
  return 'GENERAL';
}

async function detectChatIntentByLlm(req: Request, message: string): Promise<ChatIntent | null> {
  const model = getIntentRouterModel(req);
  if (!model) return null;
  if (message.trim().length === 0) return null;

  const prompt = [
    '너는 Archi.Navi chat intent router다.',
    '아래 사용자 질문을 정확히 하나의 intent로만 분류한다.',
    'intent 후보:',
    '- SERVICE_ENDPOINTS: 서비스가 제공하는 API/엔드포인트 목록 질문',
    '- SERVICE_OVERVIEW: 서비스 역할/개요/설명 질문',
    '- IMPACT_ANALYSIS: 변경 영향/의존 영향 범위 질문',
    '- PATH_DISCOVERY: A에서 B까지 연결 경로/흐름 질문',
    '- USAGE_DISCOVERY: 누가 사용/호출하는지 질문',
    '- DOMAIN_SUMMARY: 도메인 구성/요약 질문',
    '- GENERAL: 위 범주에 없는 일반 질문',
    '',
    `질문: ${message}`,
  ].join('\n');

  try {
    const result = await generateObject({
      model,
      schema: chatIntentSchema,
      prompt,
      temperature: 0,
    });
    return result.object.intent;
  } catch {
    return null;
  }
}

async function detectChatIntent(req: Request, message: string): Promise<ChatIntent> {
  const routed = await detectChatIntentByLlm(req, message);
  if (routed) return routed;
  return detectChatIntentByKeyword(message);
}

async function buildServiceContext(
  db: DbClient,
  workspaceId: string,
  serviceId: string,
  mode: 'SERVICE_OVERVIEW' | 'SERVICE_ENDPOINTS',
): Promise<string> {
  const [service] = await db
    .select({
      id: objects.id,
      name: objects.name,
      displayName: objects.displayName,
      description: objects.description,
      metadata: objects.metadata,
    })
    .from(objects)
    .where(and(eq(objects.workspaceId, workspaceId), eq(objects.id, serviceId)))
    .limit(1);

  if (!service) return '';

  const endpointRows = await db
    .select({
      id: objects.id,
      name: objects.name,
      displayName: objects.displayName,
      metadata: objects.metadata,
    })
    .from(objects)
    .where(
      and(
        eq(objects.workspaceId, workspaceId),
        eq(objects.objectType, 'api_endpoint'),
        eq(objects.parentId, serviceId),
      ),
    );

  const endpoints = endpointRows
    .map((endpoint) => {
      const metadata = (endpoint.metadata ?? {}) as Record<string, unknown>;
      const methodValue =
        typeof metadata['method'] === 'string'
          ? metadata['method']
          : typeof metadata['httpMethod'] === 'string'
            ? metadata['httpMethod']
            : null;
      const pathValue = typeof metadata['path'] === 'string' ? metadata['path'] : null;
      const label = endpoint.displayName ?? endpoint.name;

      return {
        label,
        method: methodValue?.trim().toUpperCase() ?? null,
        path: pathValue?.trim() ?? null,
      };
    })
    .sort((a, b) => (a.path ?? a.label).localeCompare(b.path ?? b.label));

  const metadata = (service.metadata ?? {}) as Record<string, unknown>;
  const serviceLines = [
    `[서비스 정보]`,
    `- 서비스: ${formatObjectLabel(service)}`,
    service.description ? `- 설명: ${service.description}` : null,
    typeof metadata['scanPath'] === 'string' ? `- scanPath: ${metadata['scanPath']}` : null,
  ].filter((line): line is string => !!line);

  const endpointLines =
    endpoints.length === 0
      ? ['- 등록된 api_endpoint object가 없습니다.']
      : endpoints.map((endpoint) => {
          const main = endpoint.method && endpoint.path
            ? `${endpoint.method} ${endpoint.path}`
            : endpoint.path ?? endpoint.label;
          return `- ${main}${endpoint.label !== main ? ` (${endpoint.label})` : ''}`;
        });

  const instruction =
    mode === 'SERVICE_ENDPOINTS'
      ? '아래 서비스의 child api_endpoint object 목록만을 근거로, 이 서비스가 제공하는 API를 정리해 답변하세요. 목록에 없는 API는 있다고 단정하지 마세요.'
      : '아래 서비스 정보와 child api_endpoint object를 근거로, 서비스 개요를 간단히 설명하고 제공 API를 함께 정리하세요. 없는 정보는 없다고 답변하세요.';

  return [
    serviceLines.join('\n'),
    '',
    `[서비스 API 목록]`,
    `총 ${endpoints.length}개`,
    ...endpointLines,
    '',
    instruction,
  ].join('\n');
}

function normalizeTokenBoundary(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]/g, ' ')
    .replace(/[^a-z0-9가-힣\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeTokenBoundary(value: string): string[] {
  const normalized = normalizeTokenBoundary(value);
  if (!normalized) return [];
  return normalized.split(' ').filter(Boolean);
}

function extractDomainCandidates(message: string): string[] {
  const candidates: string[] = [];
  const patterns = [
    /([가-힣A-Za-z0-9_-]+)\s*도메인/gi,
    /domain\s+([가-힣A-Za-z0-9_-]+)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of message.matchAll(pattern)) {
      const raw = match[1]?.trim();
      if (raw && raw.length > 1) {
        candidates.push(raw.toLowerCase());
      }
    }
  }

  const kebabTokens = [...message.matchAll(/\b([a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)+)\b/g)]
    .map((m) => m[1]?.toLowerCase())
    .filter((token): token is string => !!token);
  for (const token of kebabTokens) {
    candidates.push(token);
  }

  return [...new Set(candidates)];
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[i]![0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0]![j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + cost,
      );
    }
  }

  return matrix[a.length]![b.length]!;
}

function scoreDomainNameMatch(candidate: string, domainName: string): number {
  const candidateNormalized = normalizeTokenBoundary(candidate);
  const domainNormalized = normalizeTokenBoundary(domainName);
  if (!candidateNormalized || !domainNormalized) return 0;

  if (domainNormalized === candidateNormalized) return 100;

  const tokens = tokenizeTokenBoundary(domainName);
  if (tokens.includes(candidateNormalized)) return 85;

  // 오타 허용: 1~2자 이내 편집 거리만 허용해 substring false positive를 막는다.
  if (candidateNormalized.length >= 4) {
    const distance = levenshteinDistance(candidateNormalized, domainNormalized);
    if (distance <= 1) return 70;
    if (candidateNormalized.length >= 7 && distance <= 2) return 60;
  }

  return 0;
}

/**
 * 메시지에서 도메인 이름을 추출하고 token-boundary + edit-distance 점수로 domain Object ID를 조회한다.
 * substring 포함 매칭("order" → "reorder-service")으로 인한 false positive를 줄이기 위한 로직.
 */
async function resolveDomainId(
  db: DbClient,
  workspaceId: string,
  message: string,
): Promise<string | null> {
  const candidates = extractDomainCandidates(message);
  if (candidates.length === 0) return null;

  const rows = await db
    .select({ id: objects.id, name: objects.name, displayName: objects.displayName })
    .from(objects)
    .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'domain')));
  if (rows.length === 0) return null;

  for (const candidate of candidates) {
    let bestMatch: { id: string; score: number } | null = null;
    for (const row of rows) {
      const score = Math.max(
        scoreDomainNameMatch(candidate, row.name),
        row.displayName ? scoreDomainNameMatch(candidate, row.displayName) : 0,
      );
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { id: row.id, score };
      }
    }

    if (bestMatch && bestMatch.score >= 60) {
      return bestMatch.id;
    }
  }

  return null;
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
- 서비스 개요 요약 및 제공 API 목록 정리

답변 원칙:
- Evidence 기반으로만 답변합니다
- 불확실한 정보는 추측임을 명시합니다
- 구체적인 서비스 이름과 관계 타입을 포함합니다
- 한국어로 답변합니다`;

function truncateEvidenceChainForContext(
  chain: EvidenceChain,
  maxCount: number,
  minConfidence: number,
): EvidenceChain {
  const filtered = chain.items
    .filter((item) => item.confidence >= minConfidence)
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      if (b.score !== a.score) return b.score - a.score;
      if (b.edgeWeight !== a.edgeWeight) return b.edgeWeight - a.edgeWeight;
      return a.hop - b.hop;
    });
  const items = filtered.slice(0, maxCount);
  return {
    ...chain,
    items,
    totalCount: filtered.length,
    truncated: filtered.length > maxCount,
  };
}

function buildEvidenceTruncationSummary(chain: EvidenceChain): string {
  if (!chain.truncated) return '';
  const omittedCount = Math.max(chain.totalCount - chain.items.length, 0);
  if (omittedCount <= 0) return '';
  return `\n\n[증거 축약]\nconfidence 상위 ${chain.items.length}개만 컨텍스트에 포함했고, 추가 ${omittedCount}개 증거는 요약으로 생략했습니다.`;
}

function resolveChatMaxOutputTokens(queryContext: string): number {
  const contextLength = queryContext.length;
  if (contextLength >= 12000) return 1024;
  if (contextLength >= 7000) return 1536;
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

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
    const { messages, workspaceId } = (await req.json()) as {
      messages: UIMessage[];
      workspaceId?: string;
    };
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

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

      const intent = await detectChatIntent(req, lastUserMessage);

      // 메시지에서 서비스명 추출 → Object ID 해석
      const mentionedNames = extractMentionedNames(lastUserMessage);
      const primaryId = await resolveObjectId(db, workspaceId, mentionedNames);

      let secondaryId: string | null = null;
      if (intent === 'PATH_DISCOVERY') {
        // 경로 탐색용 두 번째 서비스: 첫 번째와 다른 ID가 나오는 이름 탐색
        for (let i = 1; i < mentionedNames.length; i++) {
          const name = mentionedNames[i];
          if (!name) continue;
          const candidate = await resolveObjectId(db, workspaceId, [name]);
          if (candidate && candidate !== primaryId) {
            secondaryId = candidate;
            break;
          }
        }
      }
      let queryResponse = null;

      if ((intent === 'SERVICE_ENDPOINTS' || intent === 'SERVICE_OVERVIEW') && primaryId) {
        const serviceContext = await buildServiceContext(db, workspaceId, primaryId, intent);
        if (serviceContext) {
          queryContext = `\n\n${serviceContext}`;
        }
      } else if (intent === 'IMPACT_ANALYSIS') {
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
      } else if (intent === 'PATH_DISCOVERY') {
        queryResponse = await executeQuery(db, {
          queryType: 'PATH_DISCOVERY',
          workspaceId,
          scope: defaultScope,
          params: {
            ...(primaryId ? { fromObjectId: primaryId } : {}),
            ...(secondaryId ? { toObjectId: secondaryId } : {}),
          },
        });
      } else if (intent === 'USAGE_DISCOVERY') {
        queryResponse = await executeQuery(db, {
          queryType: 'USAGE_DISCOVERY',
          workspaceId,
          scope: defaultScope,
          params: {
            ...(primaryId ? { objectId: primaryId } : {}),
          },
        });
      } else if (intent === 'DOMAIN_SUMMARY') {
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
          // 그 외: Evidence Chain 조립 후 confidence 상위 N개만 컨텍스트에 주입
          const rawChain = await assembleEvidenceChain(db, queryResponse, {
            maxCount: EVIDENCE_CONTEXT_POOL_SIZE,
          });
          const chain = truncateEvidenceChainForContext(
            rawChain,
            EVIDENCE_CONTEXT_MAX_ITEMS,
            EVIDENCE_MIN_CONFIDENCE,
          );
          const formatted = formatEvidenceChain(chain);
          const truncationSummary = buildEvidenceTruncationSummary(chain);
          const composerPrompt = buildAnswerComposerSystemPrompt(chain);
          if (formatted) {
            queryContext = `\n\n${formatted}${truncationSummary}${composerPrompt}`;
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
      maxOutputTokens: resolveChatMaxOutputTokens(queryContext),
      temperature: 0.3,
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    console.error('[POST /api/chat]', error);
    return new Response('AI 서비스 오류', { status: 500 });
  }
}
