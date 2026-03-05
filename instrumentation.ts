export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.WTT_PIPELINE_ENABLED === "true") {
      try {
        const { startWTTPipeline } = await import(
          "@/lib/pipeline/wtt-detector"
        );
        startWTTPipeline();
      } catch (error) {
        const { logServerEvent } = await import("@/lib/server/logger");
        logServerEvent({
          level: "error",
          scope: "instrumentation",
          event: "wtt_pipeline_start_failed",
          message: "Failed to start WTT pipeline.",
          error,
        });
      }
    }

    if (process.env.TTBL_PIPELINE_ENABLED === "true") {
      try {
        const { startTTBLPipeline } = await import(
          "@/lib/pipeline/ttbl-detector"
        );
        startTTBLPipeline();
      } catch (error) {
        console.error(
          "[TTBL-PIPELINE] Failed to start pipeline:",
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
}
