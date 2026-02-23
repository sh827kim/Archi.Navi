/**
 * POST /api/chat — AI 질의 스트리밍 응답
 * Vercel AI SDK 기반, 다중 AI 제공자 지원
 * - OPENAI_API_KEY → OpenAI GPT-4o
 * - ANTHROPIC_API_KEY → Claude Sonnet
 * - GOOGLE_GENERATIVE_AI_API_KEY → Gemini Pro
 */
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { getDb } from '@archi-navi/db';
import { executeQuery, assembleEvidenceChain, formatEvidenceChain } from '@archi-navi/core';
import type { QueryScope } from '@archi-navi/shared';
import { DEFAULT_WORKSPACE_ID } from '@archi-navi/shared';

/** AI 제공자 선택 (헤더 오버라이드 → 환경변수 fallback) */
function getModel(req: Request): LanguageModel {
  // 설정 화면에서 전달한 헤더 우선 적용
  const headerProvider = req.headers.get('x-ai-provider');
  const headerApiKey = req.headers.get('x-ai-api-key');
  const headerModel = req.headers.get('x-ai-model');

  const provider = headerProvider ?? process.env['AI_PROVIDER'] ?? 'openai';

  switch (provider) {
    case 'anthropic': {
      const modelName = headerModel ?? 'claude-3-5-sonnet-20241022';
      // 헤더로 API 키가 전달된 경우 환경변수 임시 적용 (Vercel AI SDK는 env var 자동 읽음)
      if (headerApiKey) process.env['ANTHROPIC_API_KEY'] = headerApiKey;
      return anthropic(modelName);
    }
    case 'google': {
      const modelName = headerModel ?? 'gemini-1.5-pro';
      return google(modelName);
    }
    default: {
      const modelName = headerModel ?? 'gpt-4o';
      if (headerApiKey) process.env['OPENAI_API_KEY'] = headerApiKey;
      return openai(modelName);
    }
  }
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

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function POST(req: Request) {
  try {
    const { messages, workspaceId = DEFAULT_WORKSPACE_ID } = (await req.json()) as {
      messages: ChatMessage[];
      workspaceId?: string;
    };

    // findLast 대신 Array.from().reverse() 사용 (ES2022 호환)
    const lastUserMessage =
      [...messages].reverse().find((m: ChatMessage) => m.role === 'user')?.content ?? '';

    // 결정론적 쿼리로 Evidence Chain 수집 (Best-effort)
    let queryContext = '';
    try {
      const db = await getDb();
      const defaultScope: QueryScope = {
        level: 'SERVICE_TO_SERVICE',
        visibility: 'VISIBLE_ONLY',
      };

      // 쿼리 타입 자동 감지 (키워드 기반)
      let queryResponse = null;

      if (
        lastUserMessage.includes('영향') ||
        lastUserMessage.includes('impact') ||
        lastUserMessage.includes('의존')
      ) {
        queryResponse = await executeQuery(db, {
          queryType: 'IMPACT_ANALYSIS',
          workspaceId,
          scope: defaultScope,
          params: { direction: 'DOWNSTREAM' },
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
          params: {},
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
          params: {},
        });
      }

      if (queryResponse) {
        // Evidence Chain 조립 → 구조화된 텍스트로 변환
        const chain = await assembleEvidenceChain(db, queryResponse);
        const formatted = formatEvidenceChain(chain);
        if (formatted) {
          queryContext = `\n\n${formatted}`;
        }
      }
    } catch {
      // DB 미연결 또는 쿼리 실패 시 무시 — LLM이 일반 답변
    }

    const model = getModel(req);

    const result = streamText({
      model,
      system: SYSTEM_PROMPT + queryContext,
      messages,
      maxOutputTokens: 2048,
      temperature: 0.3,
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    console.error('[POST /api/chat]', error);
    return new Response('AI 서비스 오류', { status: 500 });
  }
}
