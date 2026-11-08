import { getHeadwayStatistics } from "@/lib/transit/headways-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Cache = { at: number; result: ReturnType<typeof getHeadwayStatistics> };
const shared = globalThis as typeof globalThis & { __tamHeadwayCache?: Cache };
export async function GET() {
  try {
    if (!shared.__tamHeadwayCache || Date.now() - shared.__tamHeadwayCache.at > 30_000) {
      shared.__tamHeadwayCache = { at: Date.now(), result: getHeadwayStatistics() };
    }
    return Response.json(await shared.__tamHeadwayCache.result, { headers: { "Cache-Control": "public, max-age=15, stale-while-revalidate=30" } });
  } catch {
    shared.__tamHeadwayCache = undefined;
    return Response.json({ success: false, message: "Les fréquences de passage sont momentanément indisponibles." }, { status: 503 });
  }
}
