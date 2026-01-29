import { NextRequest } from 'next/server';
import { realtimeEvents, type RealtimeEvent } from '../../../lib/realtimeEvents';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const resource = url.searchParams.get('resource');

  if (!resource) {
    return new Response('Missing resource parameter', { status: 400 });
  }

  // Create a readable stream for SSE
  let cleanup: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

      // Send initial connection message
      const send = (data: string) => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(data));
          return true;
        } catch (err) {
          // Connection closed
          console.error('Failed to send SSE data', err);
          cleanup?.();
          return false;
        }
      };

      send(`data: ${JSON.stringify({ type: 'connected', resource })}\n\n`);

      // Subscribe to events for this resource
      const unsubscribe = realtimeEvents.subscribe(resource, (event: RealtimeEvent) => {
        send(`data: ${JSON.stringify(event)}\n\n`);
      });

      // Keep connection alive with heartbeat
      const heartbeatInterval = setInterval(() => {
        send(`: heartbeat\n\n`);
      }, 30000); // Every 30 seconds

      // Cleanup on close
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeatInterval);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed
        }
      };

      req.signal.addEventListener('abort', cleanup, { once: true });
    },
    cancel() {
      // Called when client disconnects or stream is cancelled.
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable buffering in nginx
    },
  });
}
