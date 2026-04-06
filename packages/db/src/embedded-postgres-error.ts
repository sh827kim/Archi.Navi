const RECENT_LOG_LIMIT = 40;
const RECENT_LOG_SUMMARY_LINES = 8;

function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string' && error.length > 0) return new Error(error);
  return new Error(fallbackMessage);
}

function summarizeRecentLogs(recentLogs: string[]): string | null {
  if (recentLogs.length === 0) return null;
  return recentLogs
    .slice(-RECENT_LOG_SUMMARY_LINES)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' | ');
}

function detectEmbeddedPostgresHint(recentLogs: string[]): string | null {
  const haystack = recentLogs.join('\n').toLowerCase();
  if (
    !haystack.includes('could not create shared memory segment')
    && !haystack.includes('shmat(')
    && !haystack.includes('shared memory')
  ) {
    return null;
  }

  return (
    'Embedded PostgreSQL bootstrap could not allocate shared memory. '
    + '이 환경은 sysv shared memory 사용이 막혀 있을 가능성이 높습니다. '
    + '외부 PostgreSQL(DATABASE_URL)을 사용하거나, shared memory/sysctl 제한을 완화한 뒤 다시 시도하세요.'
  );
}

export function createEmbeddedPostgresLogBuffer(limit = RECENT_LOG_LIMIT): {
  append(message: unknown): void;
  getRecentLogs(): string[];
} {
  const recentLogs: string[] = [];

  return {
    append(message: unknown) {
      const text =
        typeof message === 'string'
          ? message
          : message instanceof Error
            ? message.message
            : String(message ?? '');

      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        recentLogs.push(line);
        if (recentLogs.length > limit) {
          recentLogs.splice(0, recentLogs.length - limit);
        }
      }
    },
    getRecentLogs() {
      return [...recentLogs];
    },
  };
}

export function formatEmbeddedPostgresError(
  error: unknown,
  input: { fallbackMessage: string; recentLogs?: string[] },
): Error {
  const baseError = toError(error, input.fallbackMessage);
  const recentLogs = input.recentLogs ?? [];
  const hint = detectEmbeddedPostgresHint(recentLogs);
  const recentSummary = summarizeRecentLogs(recentLogs);
  const parts = [baseError.message];

  if (hint) parts.push(hint);
  if (recentSummary) parts.push(`Recent embedded Postgres logs: ${recentSummary}`);

  return new Error(parts.join(' '));
}
