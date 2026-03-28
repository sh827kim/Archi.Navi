import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ROLLUP_EVENT_FALLBACK_INTERVAL_MS,
  subscribeToRollupEvents,
} from '@/lib/rollup-event-source';

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  closed = false;
  private listeners = new Map<string, Set<() => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string) {
    if (this.closed) return;
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }

  close() {
    this.closed = true;
  }
}

describe('subscribeToRollupEvents', () => {
  afterEach(() => {
    FakeEventSource.instances = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('EventSource가 지원되면 rollup-change를 구독하고 close 시 정리한다', () => {
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);

    const onRollupChange = vi.fn();
    const subscription = subscribeToRollupEvents({
      workspaceId: 'ws-1',
      onRollupChange,
    });

    expect(subscription.isSupported).toBe(true);
    expect(FakeEventSource.instances[0]?.url).toBe('/api/rollup-events?workspaceId=ws-1');

    FakeEventSource.instances[0]?.emit('rollup-change');
    expect(onRollupChange).toHaveBeenCalledTimes(1);

    subscription.close();
    expect(FakeEventSource.instances[0]?.closed).toBe(true);

    FakeEventSource.instances[0]?.emit('rollup-change');
    expect(onRollupChange).toHaveBeenCalledTimes(1);
  });

  it('EventSource가 없으면 polling fallback으로 rollup-change를 지속 갱신한다', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', undefined);

    const onRollupChange = vi.fn();
    const subscription = subscribeToRollupEvents({
      workspaceId: 'ws-1',
      onRollupChange,
    });

    expect(subscription.isSupported).toBe(false);

    await vi.advanceTimersByTimeAsync(ROLLUP_EVENT_FALLBACK_INTERVAL_MS * 2);
    expect(onRollupChange).toHaveBeenCalledTimes(2);

    subscription.close();
    await vi.advanceTimersByTimeAsync(ROLLUP_EVENT_FALLBACK_INTERVAL_MS);
    expect(onRollupChange).toHaveBeenCalledTimes(2);
  });

  it('EventSource 생성에 실패하면 polling fallback으로 전환한다', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'EventSource',
      class BrokenEventSource {
        constructor() {
          throw new Error('boom');
        }
      } as unknown as typeof EventSource,
    );

    const onRollupChange = vi.fn();
    const subscription = subscribeToRollupEvents({
      workspaceId: 'ws-1',
      onRollupChange,
    });

    expect(subscription.isSupported).toBe(false);
    await vi.advanceTimersByTimeAsync(ROLLUP_EVENT_FALLBACK_INTERVAL_MS);
    expect(onRollupChange).toHaveBeenCalledTimes(1);

    subscription.close();
  });

  it('SSE 연결 에러가 나면 polling fallback으로 전환하고 즉시 재조회한다', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);

    const onRollupChange = vi.fn();
    const onError = vi.fn();
    const subscription = subscribeToRollupEvents({
      workspaceId: 'ws-1',
      onRollupChange,
      onError,
    });

    FakeEventSource.instances[0]?.emit('error');

    expect(onError).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
    expect(onRollupChange).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(ROLLUP_EVENT_FALLBACK_INTERVAL_MS);
    expect(onRollupChange).toHaveBeenCalledTimes(2);

    subscription.close();
    await vi.advanceTimersByTimeAsync(ROLLUP_EVENT_FALLBACK_INTERVAL_MS);
    expect(onRollupChange).toHaveBeenCalledTimes(2);
  });
});
