import { prisma } from "@/lib/prisma";
import { Alert } from "@prisma/client";
import { postToX, isXApiConfigured } from "./xApiClient";

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Determines if a route is a tramway (lines 1-5) or bus
 * @param routeId The route ID to check
 * @returns True if the route is a tramway
 */
const isTramway = (routeId: string): boolean => {
  // Remove any prefix (like "T-" or "X-")
  const numericPart = routeId.split("-").pop() || routeId;
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
export const formatTweetFromAlertGroup = (alerts: Alert[]): string => {
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
      alert.routeIds.split(",").forEach((route) => {
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

    // Extract numeric parts for comparison
    const aNumeric = parseInt(a.replace(/^[A-Za-z\-]+/, ""), 10);
    const bNumeric = parseInt(b.replace(/^[A-Za-z\-]+/, ""), 10);

    return aNumeric - bNumeric;
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
 * Se connecte à X via l'API officielle et publie les alertes non postées du
 * jour, en regroupant celles qui partagent le même en-tête.
 *
 * Remplace l'ancien flux Puppeteer (login navigateur + cookies). Aucune
 * session n'est nécessaire : l'authentification se fait par OAuth 1.0a.
 *
 * Tant que les variables X_API_* ne sont pas définies, cette fonction ne fait
 * RIEN (retourne "X API non configurée") : la migration peut donc être
 * déployée sans rien activer.
 * @returns Résumé du processus de publication
 */
export const postToTwitter = async (): Promise<{
  success: boolean;
  loginMessage: string;
  processed: number;
  failed: number;
  messages: string[];
}> => {
  console.log("Starting postToTwitter process (X API)");

  if (!isXApiConfigured()) {
    console.log("X API non configurée — aucune publication.");
    return {
      success: false,
      loginMessage: "X API non configurée",
      processed: 0,
      failed: 0,
      messages: [
        "Identifiants X API manquants (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET)",
      ],
    };
  }

  const messages: string[] = [];
  let processed = 0;
  let failed = 0;
  let alertIds: string[] = [];

  try {
    // Récupérer les alertes non postées d'aujourd'hui
    const unpostedAlerts = await prisma.alert.findMany({
      where: {
        isPosted: false,
        isProcessing: false,
        timeStart: {
          gte: new Date(new Date().setHours(0, 0, 0, 0)),
          lte: new Date(new Date().setHours(23, 59, 59, 999)),
        },
      },
      orderBy: { timeStart: "asc" },
      take: 20,
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

    // Marquer les alertes comme en cours de traitement (verrou anti-doublon)
    alertIds = unpostedAlerts.map((alert) => alert.id);
    await prisma.alert.updateMany({
      where: { id: { in: alertIds } },
      data: { isProcessing: true, inProcessSince: new Date() },
    });

    // Regrouper par en-tête
    const groupedAlerts = groupAlertsByHeader(unpostedAlerts);
    console.log(
      `Grouped into ${Object.keys(groupedAlerts).length} distinct alert headers`
    );

    // Publier chaque groupe
    for (const [headerText, alertGroup] of Object.entries(groupedAlerts)) {
      const groupAlertIds = alertGroup.map((alert) => alert.id);

      try {
        const tweetContent = formatTweetFromAlertGroup(alertGroup);
        const result = await postToX(tweetContent);

        if (result.success) {
          await prisma.alert.updateMany({
            where: { id: { in: groupAlertIds } },
            data: { isPosted: true, isProcessing: false },
          });
          processed += alertGroup.length;
          messages.push(
            `Posté ${alertGroup.length} alerte(s) "${headerText}" (tweet ${
              result.id ?? "?"
            })`
          );
        } else {
          // Échec : libérer le verrou pour réessai au prochain cron
          await prisma.alert.updateMany({
            where: { id: { in: groupAlertIds }, isPosted: false },
            data: { isProcessing: false },
          });
          failed += alertGroup.length;
          messages.push(`Échec "${headerText}": ${result.message}`);
        }
      } catch (error) {
        await prisma.alert.updateMany({
          where: { id: { in: groupAlertIds }, isPosted: false },
          data: { isProcessing: false },
        });
        failed += alertGroup.length;
        messages.push(
          `Erreur "${headerText}": ${
            error instanceof Error ? error.message : String(error)
          }`
        );
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
    };
  } catch (error) {
    console.error("Error in postToTwitter:", error);
    // Libérer le verrou sur toutes les alertes non encore postées
    if (alertIds.length > 0) {
      await prisma.alert.updateMany({
        where: { id: { in: alertIds }, isPosted: false },
        data: { isProcessing: false },
      });
    }
    return {
      success: false,
      loginMessage: "Erreur",
      processed,
      failed,
      messages: [
        `Erreur postToTwitter: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
};
