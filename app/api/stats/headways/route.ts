import { getHeadwayStatistics } from "@/lib/transit/headways-storage";
import { normalizeHeadwayFilters, headwayFilterKey, HeadwayFilterError } from "@/lib/transit/headways-filters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Cache = { at: number; result: ReturnType<typeof getHeadwayStatistics> };
const shared = globalThis as typeof globalThis & { __tamHeadwayFilterCache?: Map<string, Cache>; __tamHeadwayRequests?: number };
export async function GET(request: Request) {
  let id: string | undefined;
  try {
    if ((request?.url.length ?? 0) > 2048) throw new HeadwayFilterError("Requête trop longue.");
    const now = new Date(), filters = normalizeHeadwayFilters(new URL(request?.url ?? "http://localhost/api/stats/headways").searchParams, now);
    id = headwayFilterKey(filters);
    const cache = shared.__tamHeadwayFilterCache ??= new Map();
    let entry = cache.get(id);
    if (!entry || Date.now() - entry.at > 30_000) {
      if ((shared.__tamHeadwayRequests ?? 0) >= 2) return Response.json({ success: false, message: "Les statistiques sont en cours de calcul. Réessayez dans quelques secondes." }, { status: 429, headers: { "Retry-After": "5" } });
      shared.__tamHeadwayRequests = (shared.__tamHeadwayRequests ?? 0) + 1;
      entry = { at: Date.now(), result: getHeadwayStatistics(now, filters).finally(() => { shared.__tamHeadwayRequests!--; }) };
      cache.delete(id); cache.set(id, entry);
      while (cache.size > 24) cache.delete(cache.keys().next().value!);
    }
    return Response.json(await entry.result, { headers: { "Cache-Control": "public, max-age=15, stale-while-revalidate=30" } });
  } catch (error) {
    if (error instanceof HeadwayFilterError) return Response.json({ success: false, message: error.message }, { status: 400 });
    if (id) shared.__tamHeadwayFilterCache?.delete(id);
    return Response.json({ success: false, message: "Les fréquences de passage sont momentanément indisponibles." }, { status: 503 });
  }
}
