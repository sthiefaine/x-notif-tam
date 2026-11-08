import { getWeeklyTransitStats } from "@/lib/transit/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Cached = { at: number; result: ReturnType<typeof getWeeklyTransitStats> };
const shared = globalThis as typeof globalThis & { __tamWeeklyStatsCache?: Cached };

export async function GET() {
  if (!shared.__tamWeeklyStatsCache || Date.now() - shared.__tamWeeklyStatsCache.at > 30_000) {
    shared.__tamWeeklyStatsCache = { at: Date.now(), result: getWeeklyTransitStats() };
  }
  const result = await shared.__tamWeeklyStatsCache.result;
  return Response.json(result, { headers: { "Cache-Control": "public, max-age=15, stale-while-revalidate=30" } });
}
