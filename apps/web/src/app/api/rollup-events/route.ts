import { type NextRequest, NextResponse } from 'next/server';
import {
  subscribeRollupChangeEvents,
  type RollupChangeNotification,
} from '@/lib/rollup-change-events';

const encoder = new TextEncoder();

function encodeSse(event: string, data: object): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
  }

  let closeStream: (() => void) | undefined;
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: (() => void) | undefined;

      const close = () => {
        if (closed) return;
        closed = true;
        if (keepAliveTimer) clearInterval(keepAliveTimer);
        if (unsubscribe) unsubscribe();
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

      unsubscribe = subscribeRollupChangeEvents(
        workspaceId,
        (notification: RollupChangeNotification) => {
          send('rollup-change', notification);
        },
      );

      send('connected', {
        type: 'ROLLUP_EVENTS_CONNECTED',
        workspaceId,
        connectedAt: new Date().toISOString(),
      });

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
