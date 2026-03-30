import type { UIMessage } from 'ai';

export const CHAT_HISTORY_STORAGE_PREFIX = 'archi-navi:chat-history:v1';
export const DEFAULT_MAX_PERSISTED_CHAT_MESSAGES = 40;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function getBrowserStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

export function buildChatHistoryStorageKey(workspaceId: string): string {
  return `${CHAT_HISTORY_STORAGE_PREFIX}:${workspaceId}`;
}

export function sanitizeChatMessagesForStorage(
  messages: UIMessage[],
  maxMessages = DEFAULT_MAX_PERSISTED_CHAT_MESSAGES,
): UIMessage[] {
  const normalized = messages.flatMap((message) => {
    if (!message || typeof message.id !== 'string' || typeof message.role !== 'string') {
      return [];
    }

    const textParts = (message.parts ?? [])
      .flatMap((part) => {
        if (!part || part.type !== 'text') return [];
        const text = typeof part.text === 'string' ? part.text.trim() : '';
        if (!text) return [];
        return [{ type: 'text' as const, text }];
      });
    if (textParts.length === 0) return [];

    return [{ id: message.id, role: message.role, parts: textParts } as UIMessage];
  });

  return normalized.slice(-maxMessages);
}

export function loadPersistedChatMessages(
  workspaceId: string,
  storage: StorageLike | null = getBrowserStorage(),
): UIMessage[] {
  if (!storage || !workspaceId) return [];

  const key = buildChatHistoryStorageKey(workspaceId);
  const raw = storage.getItem(key);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sanitizeChatMessagesForStorage(parsed as UIMessage[]);
  } catch {
    return [];
  }
}

export function savePersistedChatMessages(
  workspaceId: string,
  messages: UIMessage[],
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage || !workspaceId) return;

  const key = buildChatHistoryStorageKey(workspaceId);
  const sanitized = sanitizeChatMessagesForStorage(messages);
  if (sanitized.length === 0) {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, JSON.stringify(sanitized));
}

export function clearPersistedChatMessages(
  workspaceId: string,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage || !workspaceId) return;
  storage.removeItem(buildChatHistoryStorageKey(workspaceId));
}
