'use client';

export const ROLLUP_EVENT_FALLBACK_INTERVAL_MS = 5_000;

export interface RollupEventSubscriptionOptions {
  workspaceId: string;
  onRollupChange: () => void;
  onError?: () => void;
  fallbackIntervalMs?: number;
  skipInitialChangeEvent?: boolean;
}

export interface RollupEventSubscription {
  isSupported: boolean;
  close: () => void;
}

export function subscribeToRollupEvents(
  options: RollupEventSubscriptionOptions,
): RollupEventSubscription {
  if (typeof window === 'undefined') {
    return {
      isSupported: false,
      close: () => {},
    };
  }

  const fallbackIntervalMs = options.fallbackIntervalMs ?? ROLLUP_EVENT_FALLBACK_INTERVAL_MS;

  const createPollingSubscription = (triggerImmediately: boolean): RollupEventSubscription => {
    if (triggerImmediately) {
      options.onRollupChange();
    }

    const intervalId = window.setInterval(() => {
      options.onRollupChange();
    }, fallbackIntervalMs);

    return {
      isSupported: false,
      close: () => {
        window.clearInterval(intervalId);
      },
    };
  };

  if (typeof window.EventSource !== 'function') {
    return createPollingSubscription(false);
  }

  let eventSource: EventSource;
  try {
    const params = new URLSearchParams({ workspaceId: options.workspaceId });
    eventSource = new window.EventSource(`/api/rollup-events?${params.toString()}`);
  } catch {
    return createPollingSubscription(false);
  }

  let fallbackSubscription: RollupEventSubscription | null = null;
  let closed = false;
  let hasSeenFirstChangeEvent = false;

  const handleRollupChange = () => {
    if (options.skipInitialChangeEvent && !hasSeenFirstChangeEvent) {
      hasSeenFirstChangeEvent = true;
      return;
    }
    hasSeenFirstChangeEvent = true;
    options.onRollupChange();
  };

  const handleError = () => {
    if (closed || fallbackSubscription) return;
    eventSource.removeEventListener('rollup-change', handleRollupChange);
    eventSource.removeEventListener('error', handleError);
    eventSource.close();
    options.onError?.();
    fallbackSubscription = createPollingSubscription(!options.skipInitialChangeEvent);
  };

  eventSource.addEventListener('rollup-change', handleRollupChange);
  eventSource.addEventListener('error', handleError);

  return {
    isSupported: true,
    close: () => {
      closed = true;
      fallbackSubscription?.close();
      fallbackSubscription = null;
      eventSource.removeEventListener('rollup-change', handleRollupChange);
      eventSource.removeEventListener('error', handleError);
      eventSource.close();
    },
  };
}
