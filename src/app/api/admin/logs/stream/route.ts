import { assertAdminConsoleAccess } from "@/lib/admin/access";
import { setActionJobLogBroadcaster } from "@/lib/jobs/action-job";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// In-memory registry for active log stream connections
const activeLogStreams: Array<ReadableStreamDefaultController<Uint8Array>> = [];

// Broadcast log message to all connected clients
export function broadcastLogMessage(
  level: "info" | "warn" | "error",
  source: string,
  message: string,
  data?: unknown,
) {
  const encoder = new TextEncoder();
  const logMessage = `data: ${JSON.stringify({
    type: "log",
    level,
    source,
    message,
    data,
    timestamp: new Date().toISOString(),
  })}\n\n`;

  // Send to all connected clients
  activeLogStreams.forEach((controller, index) => {
    try {
      controller.enqueue(encoder.encode(logMessage));
    } catch {
      // Remove dead connections
      activeLogStreams.splice(index, 1);
    }
  });
}

// Register the broadcaster so action-jobs can send logs
setActionJobLogBroadcaster((source, level, message) => {
  // Filter to only show active scraping logs (not scheduled)
  const scrapingTypes = [
    "ttbl",
    "ttbl-legacy",
    "ttbl-all-time",
    "wtt",
    "wtt-all-time",
  ];
  if (scrapingTypes.some((t) => source.includes(t))) {
    broadcastLogMessage(level as "info" | "warn" | "error", source, message);
  }
});

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
              message: "Live scraping logs stream connected",
              timestamp: new Date().toISOString(),
            })}\n\n`,
          ),
        );

        // Add this stream to active list
        activeLogStreams.push(controller);

        // Clean up on request abort
        request.signal.addEventListener("abort", () => {
          const idx = activeLogStreams.indexOf(controller);
          if (idx >= 0) {
            activeLogStreams.splice(idx, 1);
          }
          controller.close();
        });

        // Send keep-alive pings every 45 seconds
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
