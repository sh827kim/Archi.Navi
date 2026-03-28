import { getDb } from '@archi-navi/db';
import { type NextRequest, NextResponse } from 'next/server';
import {
  getWorkspaceRollupChangeCursor,
  type WorkspaceRollupChangeCursor,
} from '@/lib/rollup-change-events';

const encoder = new TextEncoder();
const CURSOR_POLL_INTERVAL_MS = 1_000;

function encodeSse(event: string, data: object): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
  }

  const db = await getDb();

  let closeStream: (() => void) | undefined;
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let lastCursorToken: string | null = null;

      const close = () => {
        if (closed) return;
        closed = true;
        if (keepAliveTimer) clearInterval(keepAliveTimer);
        if (pollTimer) clearInterval(pollTimer);
        req.signal.removeEventListener('abort', close);
        try {
          controller.close();
        } catch (error) {
          if (!(error instanceof TypeError)) {
            throw error;
          }
        }
      };
      closeStream = close;

      const send = (event: string, data: object) => {
        if (closed) return;
        controller.enqueue(encodeSse(event, data));
      };

      const syncCursor = async () => {
        const cursor = await getWorkspaceRollupChangeCursor(db, workspaceId);
        if (!cursor || closed) return;

        if (lastCursorToken === null) {
          lastCursorToken = cursor.changeToken;
          return;
        }

        if (cursor.changeToken === lastCursorToken) {
          return;
        }

        lastCursorToken = cursor.changeToken;
        sendRollupChanged(cursor);
      };

      const sendRollupChanged = (cursor: WorkspaceRollupChangeCursor) => {
        send('rollup-change', {
          type: 'ROLLUP_CHANGED',
          workspaceId,
          eventCount: 0,
          events: [],
          emittedAt: new Date().toISOString(),
          generationVersion: cursor.generationVersion,
          builtAt: cursor.builtAt,
          changeToken: cursor.changeToken,
        });
      };

      send('connected', {
        type: 'ROLLUP_EVENTS_CONNECTED',
        workspaceId,
        connectedAt: new Date().toISOString(),
      });

      void syncCursor().catch((error) => {
        console.error('[rollup-events.syncCursor.initial]', error);
      });

      pollTimer = setInterval(() => {
        void syncCursor().catch((error) => {
          console.error('[rollup-events.syncCursor.poll]', error);
        });
      }, CURSOR_POLL_INTERVAL_MS);

      keepAliveTimer = setInterval(() => {
        if (closed) return;
        controller.enqueue(encoder.encode(': keep-alive\n\n'));
      }, 15_000);

      req.signal.addEventListener('abort', close, { once: true });
    },
    cancel() {
      closeStream?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
