export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs"
    && process.env.TRANSIT_LIVE_ENABLED === "true"
    && process.env.NEXT_PHASE !== "phase-production-build") {
    const { ensureLiveCollector } = await import("./lib/transit/live");
    ensureLiveCollector();
  }
}
