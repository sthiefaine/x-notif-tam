import type { TransitStop } from "./types";

/** Pure French source-text rules shared by the collector and browser. */
export const foldAlertText = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const numbers: Record<string, string> = { un: "1", une: "1", deux: "2", trois: "3", quatre: "4", cinq: "5", six: "6", sept: "7", huit: "8", neuf: "9", dix: "10" };
export const routeToken = (text: string) => numbers[foldAlertText(text)] || foldAlertText(text);
const auxiliaries = new Set(["est", "sont", "sera", "seront", "reste", "restera", "entiere"]);
export function normalizeStopLabel(text: string): string {
  return foldAlertText(text).split(" ").map((word) => word === "st" ? "saint" : word === "ste" ? "sainte" : word === "dr" ? "docteur" : word === "pl" ? "place" : word)
    .filter((word) => word !== "docteur" && !/^(?:18|19|20)\d{2}$/.test(word)).join(" ")
    .replace(/^place (?:de |du |des )?(?:(?:l|la|le) )?/, "place ");
}

export function alertClauses(text: string): string[] {
  return text.slice(0, 8000).replace(/\b(st|ste|dr|pl|av|bd)\.\s*/gi, "$1 ")
    .replace(/\b([A-Z])\.\s*(?=[A-ZÀ-Ý])/g, "$1 ").split(/[.!?;\n]+/).map((part) => part.trim()).filter(Boolean);
}

function lineReferences(text: string) {
  return [...text.matchAll(/\blignes?\s+([a-z0-9][a-z0-9_-]*(?:\s*(?:,|\/|&|\bet\b|\bou\b)\s*(?!lignes?\b)[a-z0-9][a-z0-9_-]*)*)/gi)]
    .flatMap((match) => {
      const ids = match[1].split(/\s*(?:,|\/|&|\bet\b|\bou\b)\s*/i).map(routeToken);
      return ids.length && !auxiliaries.has(ids[0]) ? [{ start: match.index!, end: match.index! + match[0].length, ids }] : [];
    });
}

export function mentionedLines(text: string): string[] {
  return [...new Set(lineReferences(text).flatMap((reference) => reference.ids))];
}

/** A shared sentence can apply to several selectors; a different line's sentence cannot. */
export function scopedAlertClauses(text: string, routeId: string, requireMention = false): string[] {
  const target = routeToken(routeId), result: string[] = [];
  let scope: string[] | null = null;
  for (const sentence of alertClauses(text)) {
    const references = lineReferences(sentence);
    if (!references.length) {
      if (scope ? scope.includes(target) : !requireMention) result.push(sentence);
      continue;
    }
    for (let index = 0; index < references.length; index++) {
      const reference = references[index];
      scope = reference.ids;
      if (!scope.includes(target)) continue;
      const start = index === 0 ? 0 : reference.start;
      const end = references[index + 1]?.start ?? sentence.length;
      result.push(sentence.slice(start, reference.start) + `ligne ${routeId} ` + sentence.slice(reference.end, end));
    }
  }
  return result;
}

export function uncertainServiceWording(text: string): boolean {
  const value = foldAlertText(text);
  return /\b(?:si|risques?|possibles?|possibilites?|probables?|pourrait|pourraient|serait|seraient|susceptibles?|eventuels?|eventuelles?|reprise|retablie|retabli|annulee|annulees)\b|\ben cas\b/.test(value)
    || /\b(?:pas|plus|jamais)(?: encore)? (?:interromp|devi)|\b(?:sans|aucune|fin de la|fin de l|fin d|pas d|absence d|absence de l) (?:interruption|deviation)|\b(?:interruption|deviation) (?:terminee|levee|non confirmee)\b/.test(value);
}

export function affirmativeServiceWording(text: string, kind: "interruption" | "detour"): boolean {
  if (uncertainServiceWording(text)) return false;
  const value = foldAlertText(text);
  if (kind === "detour") return /\bligne [a-z0-9_-]+(?: (?:est|sont|sera|seront|temporairement|actuellement|reste|restera|a ete))* deviees?\b|\bdeviation (?:(?:de la|sur la|des?|pour la) )?ligne [a-z0-9_-]+\b/.test(value);
  return /\b(?:ligne [a-z0-9_-]+|circulation|trafic|service(?: commercial)?)(?: (?:est|sera|sont|seront|temporairement|totalement|integralement|actuellement|reste|restera|provisoirement|a ete))* (?:interrompu|suspendu)(?:e)?s?\b|\binterruption (?:du|de la|des) (?:service|trafic|circulation)|\b(?:ligne [a-z0-9_-]+|tramways?|bus) ne circul(?:e|ent|era|eront) (?:pas|plus)\b|\bpas de service\b/.test(value);
}

export function bothDirections(text: string): boolean {
  const value = foldAlertText(text);
  return !/\b(?:pas|jamais|sans)(?: dans)? (?:les )?(?:deux|2) sens?\b|\bun seul sens\b/.test(value)
    && /\b(?:dans (?:les )?(?:deux|2) sens?|(?:les )?(?:deux|2) directions|aller retour)\b/.test(value);
}

export type StopNameResolution = { status: "matched"; stops: TransitStop[]; abbreviated: boolean } | { status: "unknown" | "ambiguous"; stops: [] };
const stopDistance = (a: Pick<TransitStop, "lat" | "lon">, b: Pick<TransitStop, "lat" | "lon">) => Math.hypot((a.lon - b.lon) * Math.cos((a.lat + b.lat) * Math.PI / 360), a.lat - b.lat) * 111195;

/** Producer shorthand must resolve to a real named station, never an arbitrary "Gare". */
function qualifiedStopAlias(key: string, candidates: readonly TransitStop[]): TransitStop[] | undefined {
  if (key === "blum") return candidates.filter((stop) => normalizeStopLabel(stop.name) === "leon blum");
  if (key !== "gare maguelone" && key !== "gare saint roch maguelone") return;
  // SNCF identifies the L1/L2 platforms on rue de Maguelone, separately from
  // the République platforms. Retain both the route and geographic guards.
  // https://www.garesetconnexions.sncf/fr/gares-services/montpellier-saint-roch/intermodalites/tam
  return candidates.filter((stop) => normalizeStopLabel(stop.name) === "gare saint roch"
    && stop.routeIds.some((id) => id === "1" || id === "2")
    && stopDistance(stop, { lat: 43.60575, lon: 3.8801 }) <= 100);
}

export function resolveStopLabel(label: string, candidates: readonly TransitStop[]): StopNameResolution {
  const key = normalizeStopLabel(label);
  const groups = new Map<string, TransitStop[]>();
  for (const stop of candidates) {
    const name = normalizeStopLabel(stop.name);
    groups.set(name, [...(groups.get(name) || []), stop]);
  }
  const exact = groups.has(key) ? [[key, groups.get(key)!] as const] : [];
  const tokens = key.split(" ");
  const alias = exact.length ? undefined : qualifiedStopAlias(key, candidates);
  const matches = exact.length ? exact : alias !== undefined ? alias.length ? [[normalizeStopLabel(alias[0].name), alias] as const] : [] : [...groups].filter(([name]) => {
    const words = name.split(" ");
    // Whole-word prefix (Peyrou), or one first-name initial (L. Blum).
    return key.length >= 4 && (name.startsWith(key + " ") || tokens.length === words.length && tokens.length >= 2
      && tokens.every((token, index) => token === words[index] || index === 0 && token.length === 1 && words[index].startsWith(token)));
  });
  if (!matches.length) return { status: "unknown", stops: [] };
  if (matches.length !== 1) return { status: "ambiguous", stops: [] };
  const stops = [...matches[0][1]];
  if (stops.some((a) => !Number.isFinite(a.lat) || !Number.isFinite(a.lon) || stops.some((b) => stopDistance(a, b) > 150))) return { status: "ambiguous", stops: [] };
  return { status: "matched", stops, abbreviated: exact.length === 0 };
}

/** Candidate subjects before a non-service predicate; never the replacement clause. */
export function closureSubjects(clause: string): { text: string; explicit: boolean }[] {
  if (uncertainServiceWording(clause)) return [];
  const prose = clause.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’‘]/g, "'").toLowerCase();
  if (/^\s*(?:report|repli|remplacement|arrets? de report)\b/.test(prose)) return [];
  if (/\b(?:pas|plus|jamais) (?:ferme|supprime)/.test(prose)) return [];
  const predicate = /\s+(?:(?:(?:ne\s+(?:sont|seront|est|sera)|n'\s*(?:est|sera))\s+(?:pas|plus)|(?:sont|seront|est|sera)\s+non|non)\s+desservi(?:e)?s?|(?:(?:sont|seront|est|sera)\s+)?(?:ferme|supprime)(?:e)?s?)\b/.exec(prose);
  if (!predicate) return [];
  const prefix = prose.slice(0, predicate.index).trim();
  const explicit = /(?:^|[:]|\s[-–—]\s)\s*(?:les\s+|l'\s*)?(?:arrets?|stations?|secteur)\s*:?\s+(.+)$/.exec(prefix);
  if (explicit) return [{ text: explicit[1].trim(), explicit: true }];
  const delimiters = [...prefix.matchAll(/:\s*|\s[-–—]\s/g)].map((match) => match.index! + match[0].length);
  return [...new Set([0, ...delimiters])].slice(-12).map((start) => ({ text: prefix.slice(start).trim(), explicit: false }));
}
