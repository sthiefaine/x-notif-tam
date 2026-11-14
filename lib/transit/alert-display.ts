import type { LiveAlert, LiveStopImpact } from "./live-types";

const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])].sort();
function mergeImpacts(impacts: readonly LiveStopImpact[]): LiveStopImpact[] {
  const result = new Map<string, LiveStopImpact>();
  for (const impact of impacts) {
    const key = `${impact.stopId}:${impact.directionId ?? "*"}:${impact.serviceStatus}:${impact.evidence}`;
    const previous = result.get(key);
    result.set(key, { ...impact, routeIds: previous ? !previous.routeIds.length || !impact.routeIds.length ? [] : union(previous.routeIds, impact.routeIds) : [...impact.routeIds] });
  }
  return [...result.values()];
}

/** Group display copies only. Raw feed identities and differential deletions stay intact. */
export function groupDisplayAlerts(alerts: readonly LiveAlert[]): LiveAlert[] {
  const groups = new Map<string, LiveAlert>();
  const text = (value: string) => value.trim().replace(/\s+/g, " ");
  for (const alert of [...alerts].sort((a, b) => a.id.localeCompare(b.id))) {
    // Located sections can differ between routes even when their source prose agrees.
    const key = !alert.routeIds.length || alert.routeAssociation === "unresolved" ? `id:${alert.id}`
      : JSON.stringify([text(alert.header), text(alert.description), [...alert.periods].sort((a, b) => (a.start || "").localeCompare(b.start || "")),
        alert.timingUncertain || false, alert.category, alert.scope, alert.effect, alert.cause, alert.classificationSource, alert.confidence,
        alert.geometry || alert.interruption || alert.detour ? [alert.routeIds, alert.geometry, alert.interruption, alert.detour] : null]);
    const previous = groups.get(key);
    if (!previous) {
      groups.set(key, { ...alert, sourceIds: [...(alert.sourceIds || [alert.id])], routeIds: [...alert.routeIds], stopIds: [...alert.stopIds], stopImpacts: mergeImpacts(alert.stopImpacts || []) });
      continue;
    }
    const sourceIds = union(previous.sourceIds || [previous.id], alert.sourceIds || [alert.id]);
    const anchors = [...new Map([...(previous.mapAnchors || []), ...(alert.mapAnchors || [])].map((anchor) => [`${anchor.kind}:${anchor.routeId || ""}:${anchor.stopId}`, anchor])).values()];
    let interpretation = previous.interpretation;
    if (interpretation && alert.interpretation) {
      const unresolvedStops = [...new Map([...interpretation.unresolvedStops, ...alert.interpretation.unresolvedStops].map((stop) => [`${stop.routeId}:${stop.name}:${stop.reason}`, stop])).values()];
      const matchedStopNames = union(interpretation.matchedStopNames, alert.interpretation.matchedStopNames);
      const reasons = [...new Set([...interpretation.reasons, ...alert.interpretation.reasons])];
      const located = Boolean(previous.geometry || previous.interruption?.extent === "line");
      const unresolved = unresolvedStops.length || reasons.some((reason) => reason !== "replacement_route_unavailable");
      interpretation = { ...interpretation, matchedStopNames, unresolvedStops,
        status: unresolved ? located || matchedStopNames.length ? "partial" : "unresolved" : located ? "located" : matchedStopNames.length ? "stops_located" : interpretation.status,
        reasons };
    }
    groups.set(key, { ...previous, id: sourceIds[0], sourceIds, routeIds: union(previous.routeIds, alert.routeIds),
      rawRouteIds: union(previous.rawRouteIds || previous.routeIds, alert.rawRouteIds || alert.routeIds),
      stopIds: union(previous.stopIds, alert.stopIds), stopImpacts: mergeImpacts([...(previous.stopImpacts || []), ...(alert.stopImpacts || [])]), mapAnchors: anchors, interpretation });
  }
  return [...groups.values()];
}
