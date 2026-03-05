import { assertAdminConsoleAccess } from "@/lib/admin/access";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// In-memory registry for active connections
const activeStreams: Array<ReadableStreamDefaultController<Uint8Array>> = [];

export function broadcastLiveEvent(
  eventType: "error" | "activity",
  data: unknown,
) {
  const encoder = new TextEncoder();
  const message = `data: ${JSON.stringify({
    type: eventType,
    data,
    timestamp: new Date().toISOString(),
  })}\n\n`;

  // Send to all connected clients
  activeStreams.forEach((controller, index) => {
    try {
      controller.enqueue(encoder.encode(message));
    } catch {
      // Remove dead connections
      activeStreams.splice(index, 1);
    }
  });
}

export async function GET(request: Request) {
  const auth = assertAdminConsoleAccess(request);
  if (!auth.ok) {
    return new Response(JSON.stringify({ ok: false, error: auth.error }), {
      status: auth.status ?? 401,
      headers: { "content-type": "application/json" },
    });
  }

  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      start(controller) {
        // Initial connection message
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "connected",
              data: { message: "Live stream connected" },
              timestamp: new Date().toISOString(),
            })}\n\n`,
          ),
        );

        // Add this stream to active list
        activeStreams.push(controller);

        // Clean up on request abort
        request.signal.addEventListener("abort", () => {
          const idx = activeStreams.indexOf(controller);
          if (idx >= 0) {
            activeStreams.splice(idx, 1);
          }
          controller.close();
        });

        // Send keep-alive
        const keepAlive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(":keep-alive\n\n"));
          } catch {
            clearInterval(keepAlive);
          }
        }, 45000);
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    },
  );
}
