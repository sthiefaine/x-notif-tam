import { prisma } from "@/lib/prisma";
import { Alert } from "@prisma/client";
import type { XApiError } from "./xApiClient";
import { getPublisherConfiguration, createTextPublisher } from "./publisher";
import { restorePublicationStates, preparePublicationGroup, confirmPublicationGroup, releaseRejectedGroup } from "@/lib/transit/publication-ledger";
import { getKnownAlertRouteIds, normalizeBotRouteIds } from "./alertRoutes";

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const getPublicationWindow = (now = new Date()) => {
  const start = new Date(now);
  const end = new Date(now);
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  return { gte: start, lte: end };
};

export type PostingResult = {
  success: boolean;
  loginMessage: string;
  processed: number;
  failed: number;
  messages: string[];
  httpStatus?: number;
  errors?: XApiError[];
};

/**
 * Determines if a route is a tramway (lines 1-5) or bus
 * @param routeId The route ID to check
 * @returns True if the route is a tramway
 */
const isTramway = (routeId: string): boolean => {
  // Remove any prefix (like "T-" or "X-")
  const numericPart = routeId.split("-").pop() || routeId;
  if (!/^\d+$/.test(numericPart)) return false;
  const lineNumber = parseInt(numericPart, 10);
  return !isNaN(lineNumber) && lineNumber >= 1 && lineNumber <= 5;
};

/**
 * Gets an emoji for the given alert cause
 * @param cause The alert cause
 * @param isResolution Whether this is an incident resolution
 * @returns Appropriate emoji for the cause
 */
const getCauseEmoji = (
  cause: string,
  isResolution: boolean = false
): string => {
  if (isResolution) return "🟢";

  switch (cause) {
    case "TECHNICAL_PROBLEM":
      return "🔧";
    case "STRIKE":
      return "🪧";
    case "DEMONSTRATION":
      return "📢";
    case "ACCIDENT":
      return "🚨";
    case "HOLIDAY":
      return "🎉";
    case "WEATHER":
      return "⛈";
    case "MAINTENANCE":
      return "🛠️";
    case "CONSTRUCTION":
      return "🚧";
    case "POLICE_ACTIVITY":
      return "👮";
    case "MEDICAL_EMERGENCY":
      return "🚑";
    case "TRAFFIC_JAM":
      return "🚏";
    default:
      return "⚠️";
  }
};

/**
 * Formats a date to HH:MM format in Paris timezone
 * @param date The date to format
 * @returns Formatted time string in Paris timezone
 */
const formatTimeInParis = (date: Date): string => {
  const formatter = new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Paris",
  });

  const parts = formatter.formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value || "00";
  const minute = parts.find((part) => part.type === "minute")?.value || "00";

  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
};

/**
 * Groups alerts by their header text
 * @param alerts Array of alerts to group
 * @returns Grouped alerts by header text
 */
export const groupAlertsByHeader = (
  alerts: Alert[]
): Record<string, Alert[]> => {
  const grouped: Record<string, Alert[]> = {};

  for (const alert of alerts) {
    if (!grouped[alert.headerText]) {
      grouped[alert.headerText] = [];
    }
    grouped[alert.headerText].push(alert);
  }

  return grouped;
};

/**
 * Formats a group of alerts with the same header into a tweet
 * @param alerts Alerts with the same header text
 * @returns Formatted tweet text
 */
export const formatTweetFromAlertGroup = (alerts: Alert[], knownRouteIds?: ReadonlySet<string>): string => {
  if (alerts.length === 0) return "";

  const headerText = alerts[0].headerText;
  const isResolution =
    headerText.toLowerCase().includes("reprise") ||
    headerText.toLowerCase().includes("résolution") ||
    headerText.toLowerCase().includes("fin d'incident") ||
    headerText.toLowerCase().includes("fin alerte");

  // Get all unique route IDs from the group
  const allRouteIds = new Set<string>();
  let hasTramway = false;

  alerts.forEach((alert) => {
    if (alert.routeIds) {
      normalizeBotRouteIds(alert.routeIds.split(","), `${alert.headerText} ${alert.descriptionText}`, knownRouteIds).forEach((route) => {
        const trimmedRoute = (route.split("-").pop() || route).trim();
        allRouteIds.add(trimmedRoute);
        if (isTramway(trimmedRoute)) {
          hasTramway = true;
        }
      });
    }
  });

  // Sort routes by type (tramway first) and then by number
  const sortedRoutes = Array.from(allRouteIds).sort((a, b) => {
    const aIsTram = isTramway(a);
    const bIsTram = isTramway(b);

    if (aIsTram && !bIsTram) return -1;
    if (!aIsTram && bIsTram) return 1;

    // Lettered routes are valid; comparing NaN left their order arbitrary.
    return a.localeCompare(b, "fr", { numeric: true, sensitivity: "base" });
  });

  // Get start time from the first alert (they should be sorted by time)
  const startTime = formatTimeInParis(alerts[0].timeStart);

  // Build the tweet
  let tweet = "";

  // Add cause emoji and tramway emoji if applicable
  const causeEmoji = getCauseEmoji(alerts[0].cause, isResolution);
  if (causeEmoji) tweet += `${causeEmoji} `;
  if (hasTramway) tweet += Math.random() < 0.5 ? "🚊 " : "🚋 ";

  // Add header and time
  tweet += `${startTime}\n`;
  if (sortedRoutes.length > 0) {
    tweet +=
      sortedRoutes.length > 1
        ? `Lignes: ${sortedRoutes.join("-")}\n`
        : `Ligne: ${sortedRoutes[0]}\n`;
  }

  tweet += `${alerts[0].descriptionText}\n`;
  if (sortedRoutes.length > 1) {
    tweet += "#Montpellier";
  } else if (sortedRoutes.length === 1) {
    tweet += `#L${sortedRoutes[0]}TaM #Montpellier`;
  } else {
    tweet += "#Montpellier";
  }

  // Twitter has a 280 character limit
  if (tweet.length > 280) {
    // Truncate if needed
    tweet = tweet.substring(0, 277) + "...";
  }

  return tweet;
};

/**
 * Publie les alertes du jour avec le mode explicitement choisi (navigateur
 * ou API). Une configuration manquante ne déclenche aucune publication.
 * @returns Résumé du processus de publication
 */
export const postToTwitter = async (): Promise<PostingResult> => {
  const configuration = getPublisherConfiguration();
  console.log(`Starting postToTwitter process (${configuration.mode})`);

  if (!configuration.configured) {
    return {
      success: false,
      loginMessage: configuration.message,
      processed: 0,
      failed: 0,
      httpStatus: 503,
      messages: [configuration.message],
    };
  }

  const messages: string[] = [];
  const errors: XApiError[] = [];
  let processed = 0;
  let failed = 0;
  let alertIds: string[] = [];
  const heldIds = new Set<string>();
  const claimedAt = new Date();
  let publisher: ReturnType<typeof createTextPublisher> | undefined;

  try {
    // Acquisition atomique du lot. Le verrou ne couvre que les requêtes DB,
    // jamais les appels réseau à X, et fonctionne entre plusieurs instances.
    const unpostedAlerts = await prisma.$transaction(async (tx) => {
      const locks = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(727043, 1) AS locked
      `;
      if (!locks[0]?.locked) return [];

      const candidates = await tx.alert.findMany({
        where: {
          isPosted: false,
          isProcessing: false,
          timeStart: getPublicationWindow(),
        },
        orderBy: { timeStart: "asc" },
        take: 20,
      });
      const alerts = await restorePublicationStates(tx, candidates);
      if (alerts.length > 0) {
        await tx.alert.updateMany({
          where: { id: { in: alerts.map((alert) => alert.id) } },
          data: { isProcessing: true, inProcessSince: claimedAt },
        });
      }
      return alerts;
    });

    console.log(`Found ${unpostedAlerts.length} unposted alerts`);

    if (unpostedAlerts.length === 0) {
      return {
        success: true,
        loginMessage: "OK",
        processed: 0,
        failed: 0,
        messages: ["Aucune alerte non postée à traiter"],
      };
    }

    alertIds = unpostedAlerts.map((alert) => alert.id);
    const pendingIds = new Set(alertIds);

    // Regrouper par en-tête
    const groupedAlerts = groupAlertsByHeader(unpostedAlerts);
    const knownRouteIds = await getKnownAlertRouteIds();
    publisher = createTextPublisher();
    console.log(
      `Grouped into ${Object.keys(groupedAlerts).length} distinct alert headers`
    );

    // Publier chaque groupe
    for (const [headerText, alertGroup] of Object.entries(groupedAlerts)) {
      const groupAlertIds = alertGroup.map((alert) => alert.id);
      groupAlertIds.forEach((id) => pendingIds.delete(id));
      let stopBatch = false;

      try {
        const tweetContent = formatTweetFromAlertGroup(alertGroup, knownRouteIds);
        // Persister le marqueur AVANT l'envoi : un crash ou une panne DB après
        // acceptation par X ne doit jamais libérer automatiquement ce groupe.
        const prepared = await preparePublicationGroup(prisma, groupAlertIds, claimedAt);
        groupAlertIds.forEach((id) => heldIds.add(id));
        if (prepared.count !== groupAlertIds.length) {
          throw new Error("Le lot a changé avant la publication");
        }
        const result = await publisher.postText(tweetContent);

        if (result.success) {
          await confirmPublicationGroup(prisma, groupAlertIds, result.id);
          groupAlertIds.forEach((id) => heldIds.delete(id));
          processed += alertGroup.length;
          messages.push(
            `Posté ${alertGroup.length} alerte(s) "${headerText}" (tweet ${
              result.id ?? "?"
            })`
          );
        } else {
          // Sans confirmation après envoi, conserver l'alerte pour contrôle
          // manuel. Un réessai automatique pourrait publier un doublon.
          if (!result.error.uncertain) {
            await releaseRejectedGroup(prisma, groupAlertIds);
            groupAlertIds.forEach((id) => heldIds.delete(id));
          }
          failed += alertGroup.length;
          messages.push(`Échec "${headerText}": ${result.message}`);
          if (result.error.uncertain) {
            messages.push("Publication incertaine : vérifier le compte avant de libérer cette alerte en base.");
          }
          errors.push(result.error);
          console.warn("Publication X interrompue:", {
            code: result.error.code, status: result.error.status,
            stage: result.error.stage, uncertain: result.error.uncertain === true,
          });

          // Une limite de quota ou un problème d'authentification concerne
          // tout le compte : ne pas multiplier les appels refusés dans ce lot.
          stopBatch = configuration.mode === "browser"
            || [401, 402, 403, 429].includes(result.error.status ?? 0);
        }
      } catch (error) {
        const needsReview = groupAlertIds.some((id) => heldIds.has(id));
        if (!needsReview) {
          await prisma.alert.updateMany({
            where: { id: { in: groupAlertIds }, isPosted: false, inProcessSince: claimedAt },
            data: { isProcessing: false, inProcessSince: null },
          });
        }
        failed += alertGroup.length;
        console.error("Échec du traitement d'un groupe:",
          error instanceof Error ? error.name : "Erreur inconnue");
        const detail = needsReview
          ? "Publication ou confirmation en base interrompue : vérifier le compte avant de libérer l'alerte."
          : "Impossible de préparer le groupe en base ; aucun envoi effectué.";
        errors.push({ status: 503, code: "POSTING_STATE_FAILED", detail, uncertain: needsReview });
        messages.push(`Erreur pour "${headerText}": ${detail}`);
        stopBatch = true;
      }

      if (stopBatch) {
        await prisma.alert.updateMany({
          where: {
            id: { in: Array.from(pendingIds) }, isPosted: false,
            inProcessSince: claimedAt,
          },
          data: { isProcessing: false, inProcessSince: null },
        });
        break;
      }
      // Petite pause entre les posts
      await wait(1000);
    }

    return {
      success: failed === 0,
      loginMessage: "OK",
      processed,
      failed,
      messages,
      httpStatus: failed === 0 ? 200 : errors.some((error) => error.status === 429) ? 429 : 502,
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (error) {
    console.error("Error in postToTwitter:",
      error instanceof Error ? error.name : "Erreur inconnue");
    // Les groupes préparés ou incertains ne passent jamais par ce nettoyage.
    const releasableIds = alertIds.filter((id) => !heldIds.has(id));
    if (releasableIds.length > 0) {
      try {
        await prisma.alert.updateMany({
          where: { id: { in: releasableIds }, isPosted: false, inProcessSince: claimedAt },
          data: { isProcessing: false, inProcessSince: null },
        });
      } catch {
        console.error("Impossible de libérer le lot d'alertes en base.");
      }
    }
    return {
      success: false,
      loginMessage: "Erreur",
      processed,
      failed,
      httpStatus: 503,
      messages: [...messages, "Impossible de terminer le traitement des alertes en base."],
      errors: errors.length > 0 ? errors : undefined,
    };
  } finally {
    try {
      await publisher?.close();
    } catch {
      console.warn("Le navigateur de publication n'a pas pu se fermer proprement.");
    }
  }
};
