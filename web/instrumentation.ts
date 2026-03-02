export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.WTT_PIPELINE_ENABLED === "true") {
      try {
        const { startWTTPipeline } = await import(
          "@/lib/pipeline/wtt-detector"
        );
        startWTTPipeline();
      } catch (error) {
        console.error(
          "[WTT-PIPELINE] Failed to start pipeline:",
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
}
