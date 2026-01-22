import { NextRequest } from 'next/server';
import { realtimeEvents, type RealtimeEvent } from '../../../lib/realtimeEvents';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const resource = url.searchParams.get('resource');

  if (!resource) {
    return new Response('Missing resource parameter', { status: 400 });
  }

  // Create a readable stream for SSE
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      // Send initial connection message
      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(data));
        } catch (err) {
          // Connection closed
          console.error('Failed to send SSE data', err);
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
      const cleanup = () => {
        clearInterval(heartbeatInterval);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed
        }
      };

      req.signal.addEventListener('abort', cleanup);

      // Also handle client disconnect
      if (typeof req.signal === 'object' && req.signal) {
        req.signal.addEventListener('abort', cleanup);
      }
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
