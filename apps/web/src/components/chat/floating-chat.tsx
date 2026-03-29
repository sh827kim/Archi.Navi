/**
 * 플로팅 AI 채팅 패널
 * FAB 버튼(우하단) → 클릭 시 슬라이드 업 채팅 창
 * AI SDK v6 호환: sendMessage, status, DefaultChatTransport, parts 기반 렌더링
 */
'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { AnimatePresence, motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  MessageSquare,
  X,
  Send,
  Bot,
  User,
  Loader2,
  Sparkles,
  ArrowUpRight,
} from 'lucide-react';
import { cn, Button, Input } from '@archi-navi/ui';
import { useWorkspace } from '@/contexts/workspace-context';
import { getClientAiRequestHeaders } from '@/lib/client-ai-settings';

/** 예시 질문 목록 */
const EXAMPLE_QUESTIONS = [
  'author-service 는 어떤 api 가 있지?',
  'payment-service 서비스 개요를 알려줘',
  'order-service가 의존하는 서비스는?',
  'payment-service 수정 시 영향받는 서비스는?',
  'user-service에서 DB까지 경로는?',
  '주문 도메인에 속하는 서비스 목록은?',
];

/** 메시지에서 텍스트를 추출하는 헬퍼 */
function getMessageText(msg: { parts?: Array<{ type: string; text?: string }>; content?: string }): string {
  // v6: parts 기반 렌더링 우선
  if (msg.parts) {
    return msg.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
  }
  // 하위 호환: content 필드
  if (typeof msg.content === 'string') return msg.content;
  return '';
}

// ─── Answer Composer 파싱 및 카드 렌더링 ─────────────────────────────────────

/** Answer Composer 형식으로 파싱된 섹션 */
interface AnswerSections {
  conclusion: string;
  confidence: string;
  evidenceList: string[];
  summary: string;
  deepLink: string;
}

/**
 * AI 응답 텍스트에서 Answer Composer 구조를 파싱한다.
 * 공통 섹션(결론/신뢰도/요약/딥링크) + 목록 섹션(증거 목록 | 도메인 목록 | 멤버 목록) 인식.
 * 형식이 맞지 않으면 null 반환.
 */
function parseAnswerText(text: string): AnswerSections | null {
  // 필수 공통 섹션 확인
  if (
    !text.includes('**결론:**') ||
    !text.includes('**신뢰도:**') ||
    !text.includes('**요약:**') ||
    !text.includes('**딥링크:**')
  ) {
    return null;
  }

  // 목록 섹션: 증거 목록, 도메인 목록, 멤버 목록 중 하나 이상 존재해야 함
  const hasListSection =
    text.includes('**증거 목록:**') ||
    text.includes('**도메인 목록:**') ||
    text.includes('**멤버 목록:**');
  if (!hasListSection) {
    return null;
  }

  const conclusionMatch = text.match(/\*\*결론:\*\*\s*([^\n]+)/);
  const confidenceMatch = text.match(/\*\*신뢰도:\*\*\s*([^\n]+)/);
  // 증거 목록 | 도메인 목록 | 멤버 목록 통합 파싱
  const evidenceBlockMatch = text.match(
    /\*\*(?:증거 목록|도메인 목록|멤버 목록):\*\*\s*\n((?:- [^\n]+\n?)*)/,
  );
  const summaryMatch = text.match(/\*\*요약:\*\*\s*([\s\S]+?)(?=\n\*\*|$)/);
  const deepLinkMatch = text.match(/\*\*딥링크:\*\*\s*([^\n]+)/);

  if (!conclusionMatch || !confidenceMatch || !evidenceBlockMatch || !summaryMatch || !deepLinkMatch) {
    return null;
  }

  const evidenceList = (evidenceBlockMatch[1] ?? '')
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());

  return {
    conclusion: conclusionMatch[1]?.trim() ?? '',
    confidence: confidenceMatch[1]?.trim() ?? '',
    evidenceList,
    summary: summaryMatch[1]?.trim() ?? '',
    deepLink: deepLinkMatch[1]?.trim() ?? '',
  };
}

/** Evidence 카드 — Answer Composer 구조화 응답을 시각적으로 표현 */
function AnswerCard({ sections }: { sections: AnswerSections }) {
  const confidenceNum = parseFloat(sections.confidence);
  const confidencePct = isNaN(confidenceNum)
    ? sections.confidence
    : `${(confidenceNum * 100).toFixed(0)}%`;
  const confidenceColor =
    confidenceNum >= 0.9 ? 'text-emerald-500' : confidenceNum >= 0.7 ? 'text-yellow-500' : 'text-red-400';

  return (
    <div className="max-w-[320px] overflow-hidden rounded-xl border border-border/70 bg-background text-sm shadow-sm">
      {/* 결론 */}
      <div className="border-b border-border/60 bg-primary/10 px-3 py-2">
        <p className="text-[10px] font-semibold text-primary uppercase tracking-wide mb-1">결론</p>
        <p className="text-foreground leading-snug">{sections.conclusion}</p>
      </div>

      {/* 신뢰도 */}
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="text-xs text-muted-foreground">신뢰도</span>
        <span className={cn('text-xs font-bold', confidenceColor)}>{confidencePct}</span>
        <span className="text-xs text-muted-foreground">({sections.confidence})</span>
      </div>

      {/* 증거 목록 */}
      {sections.evidenceList.length > 0 && (
        <div className="border-b border-border/60 px-3 py-2">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">증거</p>
          <ul className="space-y-0.5">
            {sections.evidenceList.map((ev, idx) => (
              <li key={idx} className="text-xs text-foreground/80 leading-relaxed">
                • {ev}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 요약 */}
      {sections.summary && (
        <div className="border-b border-border/60 px-3 py-2">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">요약</p>
          <p className="text-xs text-foreground/80 leading-relaxed">{sections.summary}</p>
        </div>
      )}

      {/* 딥링크 */}
      {sections.deepLink && (
        <div className="px-3 py-2">
          <a
            href={sections.deepLink}
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            <ArrowUpRight className="h-3 w-3" />
            아키텍처 맵에서 보기
          </a>
        </div>
      )}
    </div>
  );
}

export function FloatingChat() {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const { workspaceId } = useWorkspace();

  // AI SDK v6: DefaultChatTransport + sendMessage 패턴
  const {
    messages,
    sendMessage,
    status,
    error,
  } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
      headers: getClientAiRequestHeaders,
      body: () => (workspaceId ? { workspaceId } : {}),
    }),
  });

  // 스트리밍 중인지 체크 (로딩 상태)
  const isStreaming = status === 'submitted' || status === 'streaming';

  // 새 메시지 → 스크롤 하단 이동
  useEffect(() => {
    if (isOpen) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen]);

  // Cmd+J 토글 단축키
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

  /** 폼 제출 핸들러 */
  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = input.trim();
      if (!trimmed || !workspaceId) return;
      sendMessage({ text: trimmed });
      setInput('');
    },
    [input, sendMessage, workspaceId],
  );

  /** 예시 질문 클릭 → 바로 전송 */
  const handleExampleClick = useCallback(
    (question: string) => {
      if (!workspaceId) return;
      sendMessage({ text: question });
    },
    [sendMessage, workspaceId],
  );

  return (
    <>
      {/* FAB 버튼 */}
      <AnimatePresence>
        {!isOpen && (
          <motion.button
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 20 }}
            onClick={toggle}
            className={cn(
              'fixed bottom-6 right-6 z-50',
              'flex h-14 w-14 items-center justify-center rounded-full',
              'bg-primary text-primary-foreground shadow-lg',
              'hover:scale-110 active:scale-95 transition-transform',
              'glow-primary',
            )}
            title="AI 채팅 (⌘J)"
          >
            <MessageSquare className="h-6 w-6" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* 채팅 패널 */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className={cn(
              'fixed bottom-6 right-6 z-50',
              'flex w-[400px] h-[600px] flex-col',
              'rounded-2xl shadow-2xl overflow-hidden',
              'border border-border/70 bg-background/100 backdrop-blur-none',
            )}
          >
            {/* 헤더 */}
            <div className="flex items-center justify-between border-b border-border/60 bg-background px-4 py-3">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold text-foreground">
                  AI 아키텍처 어시스턴트
                </span>
              </div>
              <button
                onClick={toggle}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* 메시지 영역 */}
            <div className="flex-1 space-y-3 overflow-y-auto bg-background px-4 py-4">
              {messages.length === 0 ? (
                /* 빈 상태 — 예시 질문 */
                <div className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground">
                  <Bot className="h-10 w-10 text-primary/60" />
                  <div className="text-center">
                    <p className="text-sm font-medium text-foreground">
                      아키텍처에 대해 질문하세요
                    </p>
                    <p className="text-xs mt-1 text-muted-foreground">
                      서비스 개요, API 목록, 의존 관계, 영향 분석 등
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-1.5 w-full px-2">
                    {EXAMPLE_QUESTIONS.map((q) => (
                      <button
                        key={q}
                        onClick={() => handleExampleClick(q)}
                        className={cn(
                          'rounded-lg px-3 py-2 text-left text-xs',
                          'border border-border/60 bg-muted text-foreground',
                          'hover:text-foreground transition-colors',
                        )}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                /* 메시지 목록 */
                messages.map((msg) => {
                  const text = getMessageText(msg);
                  if (!text) return null;

                  // Assistant 메시지: Answer Composer 형식 감지 후 카드 렌더링
                  if (msg.role !== 'user') {
                    const parsed = parseAnswerText(text);
                    if (parsed) {
                      return (
                        <div key={msg.id} className="flex gap-2 justify-start">
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary">
                            <Bot className="h-3.5 w-3.5" />
                          </div>
                          <AnswerCard sections={parsed} />
                        </div>
                      );
                    }
                  }

                  return (
                    <div
                      key={msg.id}
                      className={cn(
                        'flex gap-2',
                        msg.role === 'user' ? 'justify-end' : 'justify-start',
                      )}
                    >
                      {/* Bot 아이콘 */}
                      {msg.role !== 'user' && (
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary">
                          <Bot className="h-3.5 w-3.5" />
                        </div>
                      )}

                      {/* 메시지 버블 */}
                      <div
                        className={cn(
                          'max-w-[280px] rounded-xl px-3 py-2 text-sm leading-relaxed',
                          msg.role === 'user'
                            ? 'bg-primary text-primary-foreground'
                            : 'border border-border/60 bg-muted text-foreground',
                        )}
                      >
                        {/* 사용자 메시지: plain text / AI 메시지: 마크다운 렌더링 */}
                        {msg.role === 'user' ? (
                          text
                        ) : (
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              // 단락 — 기본 margin 제거해 버블 내 여백 통일
                              p: ({ children }) => (
                                <p className="mb-1.5 last:mb-0">{children}</p>
                              ),
                              // 굵은 글씨
                              strong: ({ children }) => (
                                <strong className="font-semibold text-foreground">{children}</strong>
                              ),
                              // 순서 없는 목록
                              ul: ({ children }) => (
                                <ul className="my-1 ml-3 list-disc space-y-0.5">{children}</ul>
                              ),
                              // 순서 있는 목록
                              ol: ({ children }) => (
                                <ol className="my-1 ml-3 list-decimal space-y-0.5">{children}</ol>
                              ),
                              // 목록 항목
                              li: ({ children }) => (
                                <li className="leading-relaxed">{children}</li>
                              ),
                              // 인라인 코드
                              code: ({ children }) => (
                                <code className="rounded bg-muted-foreground/15 px-1 py-0.5 font-mono text-xs">
                                  {children}
                                </code>
                              ),
                              // 코드 블록
                              pre: ({ children }) => (
                                <pre className="my-1.5 overflow-x-auto rounded border border-border/60 bg-muted p-2 font-mono text-xs">
                                  {children}
                                </pre>
                              ),
                              // 수평선 — 섹션 구분
                              hr: () => <hr className="my-2 border-border/60" />,
                              // 헤딩 (h1~h3)
                              h1: ({ children }) => (
                                <h1 className="mb-1 text-sm font-bold">{children}</h1>
                              ),
                              h2: ({ children }) => (
                                <h2 className="mb-1 text-sm font-semibold">{children}</h2>
                              ),
                              h3: ({ children }) => (
                                <h3 className="mb-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                  {children}
                                </h3>
                              ),
                            }}
                          >
                            {text}
                          </ReactMarkdown>
                        )}
                      </div>

                      {/* User 아이콘 */}
                      {msg.role === 'user' && (
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                          <User className="h-3.5 w-3.5" />
                        </div>
                      )}
                    </div>
                  );
                })
              )}

              {/* 로딩 인디케이터 */}
              {isStreaming && (
                <div className="flex gap-2">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary">
                    <Bot className="h-3.5 w-3.5" />
                  </div>
                  <div className="flex items-center rounded-xl border border-border/60 bg-muted px-3 py-2">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                </div>
              )}

              {/* 에러 */}
              {error && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
                  오류: {error.message}
                </div>
              )}

              <div ref={bottomRef} />
            </div>

            {/* 입력 영역 */}
            <div className="border-t border-border/60 bg-background px-3 py-3">
              <form
                onSubmit={handleSubmit}
                className="flex gap-2"
              >
                <Input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="질문을 입력하세요..."
                  disabled={status !== 'ready'}
                  className="h-9 flex-1 border-border/60 bg-muted text-sm"
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={status !== 'ready' || !input.trim()}
                  className="h-9 w-9 p-0"
                >
                  {isStreaming ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </form>
              <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
                ⌘J로 토글
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
