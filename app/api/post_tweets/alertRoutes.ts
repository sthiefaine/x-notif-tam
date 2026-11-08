import { getTransitNetwork } from "@/lib/transit/network";
import { normalizeAlertRouteId } from "@/lib/transit/live-alerts";

export async function getKnownAlertRouteIds(): Promise<ReadonlySet<string> | undefined> {
  try {
    const network = await getTransitNetwork();
    return new Set(network.routes.map((route) => route.id));
  } catch {
    // An unavailable static artifact must not stop collecting or guess a route.
    console.warn("Référentiel des lignes indisponible ; identifiants source conservés.");
    return undefined;
  }
}

export function normalizeBotRouteIds(
  routeIds: readonly (string | undefined)[], contextText: string, knownRouteIds?: ReadonlySet<string>,
): string[] {
  const ids = [...new Set(routeIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim()))];
  // One singular label cannot identify several independent route selectors.
  return ids.length === 1 ? [normalizeAlertRouteId(ids[0], contextText, knownRouteIds)] : ids;
}
