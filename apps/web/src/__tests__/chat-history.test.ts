import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import {
  buildChatHistoryStorageKey,
  loadPersistedChatMessages,
  sanitizeChatMessagesForStorage,
  savePersistedChatMessages,
} from '@/lib/chat-history';

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
    removeItem(key: string) {
      map.delete(key);
    },
  };
}

describe('chat-history', () => {
  it('text part만 저장하고 최대 개수를 유지해야 한다', () => {
    const messages = [
      {
        id: '1',
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
      },
      {
        id: '2',
        role: 'assistant',
        parts: [{ type: 'tool-call', toolName: 'x' }],
      },
      {
        id: '3',
        role: 'assistant',
        parts: [{ type: 'text', text: 'world' }],
      },
    ] as unknown as UIMessage[];

    const sanitized = sanitizeChatMessagesForStorage(messages, 1);
    expect(sanitized).toHaveLength(1);
    expect(sanitized[0]?.id).toBe('3');
    expect(sanitized[0]?.parts?.[0]?.type).toBe('text');
  });

  it('workspace 키로 저장/복원해야 한다', () => {
    const storage = createMemoryStorage();
    const workspaceId = 'ws-1';
    const key = buildChatHistoryStorageKey(workspaceId);

    savePersistedChatMessages(
      workspaceId,
      [
        {
          id: 'm-1',
          role: 'user',
          parts: [{ type: 'text', text: '질문' }],
        },
      ] as unknown as UIMessage[],
      storage,
    );

    expect(storage.getItem(key)).toBeTruthy();
    const restored = loadPersistedChatMessages(workspaceId, storage);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.id).toBe('m-1');
  });

  it('잘못된 JSON이면 빈 배열을 반환해야 한다', () => {
    const storage = createMemoryStorage();
    const workspaceId = 'ws-invalid';
    storage.setItem(buildChatHistoryStorageKey(workspaceId), '{not-json');

    const restored = loadPersistedChatMessages(workspaceId, storage);
    expect(restored).toEqual([]);
  });

  it('저장할 메시지가 없으면 기존 값을 삭제해야 한다', () => {
    const storage = createMemoryStorage();
    const workspaceId = 'ws-empty';
    const key = buildChatHistoryStorageKey(workspaceId);

    storage.setItem(key, '[]');
    savePersistedChatMessages(workspaceId, [] as UIMessage[], storage);

    expect(storage.getItem(key)).toBeNull();
  });
});
