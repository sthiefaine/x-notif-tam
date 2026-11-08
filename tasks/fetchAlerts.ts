import * as protobuf from "protobufjs";
import { prisma, ensurePrismaConnection } from "@/lib/prisma";
import path from "path";
import {
  determineCauseByKeywords,
  determineEffectByKeywords,
} from "@/helpers/incident";
import crypto from "crypto";
import { postToTwitter } from "@/app/api/post_tweets/postTweet";

// TaM diffuse désormais les alertes urbaines et suburbaines dans un flux commun.
// Les anciens chemins data.montpellier3m.fr/GTFS/{Urbain,Suburbain} sont retirés.
const configuredAlertUrls = process.env.ALERT_URL
  ?.split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const ALERT_URLS = configuredAlertUrls?.length
  ? configuredAlertUrls
  : ["https://gtfsproxy.e-tam.fr/COMMON/Alert.pb"];
const ALERT_FETCH_TIMEOUT_MS = 15_000;

export interface AlertFeedResult {
  url: string;
  success: boolean;
  processedEntities: number;
  error?: string;
}

export interface AlertCollectionResult {
  success: boolean;
  status: "success" | "partial" | "failed";
  totalFeeds: number;
  successfulFeeds: number;
  failedFeeds: number;
  processedEntities: number;
  feeds: AlertFeedResult[];
}

const PROTO_PATH = path.join(process.cwd(), "lib/gtfs-realtime.proto");

function isComplement(headerText: string, descriptionText: string) {
  const header = (headerText || "").toLowerCase();
  const description = (descriptionText || "").toLowerCase();

  return (
    header.includes("complement") ||
    header.includes("complément") ||
    description.includes("complément d'info") ||
    description.includes("complément d'information") ||
    description.startsWith("complément") ||
    description.includes("fin d'information") ||
    description.includes("fin de l'information") ||
    header.includes("fin d'incident") ||
    header.includes("fin alerte") ||
    header.includes("reprise") ||
    header.includes("résolution")
  );
}

function extractRouteIds(informedEntities: Array<{ routeId?: string }>) {
  if (!informedEntities || !Array.isArray(informedEntities)) return [];
  return informedEntities
    .filter((entity) => entity.routeId)
    .map((entity) => entity.routeId);
}

async function downloadAlertFile(url: string): Promise<Buffer> {
  console.log(`Téléchargement des alertes depuis ${url}`);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(ALERT_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `Erreur lors du téléchargement: ${response.status} ${response.statusText}`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    console.error("Erreur lors du téléchargement des alertes:", error);
    throw error;
  }
}

async function parseAlertFile(buffer: Buffer): Promise<any> {
  try {
    const root = await protobuf.load(PROTO_PATH);
    const FeedMessage = root.lookupType("transit_realtime.FeedMessage");
    const message = FeedMessage.decode(buffer);

    return FeedMessage.toObject(message, {
      longs: String,
      enums: String,
      bytes: String,
    });
  } catch (error) {
    console.error("Erreur lors du parsing du fichier protobuf:", error);
    throw error;
  }
}

async function saveAlerts(feedMessage: any): Promise<number> {
  try {
    if (!feedMessage.entity || !Array.isArray(feedMessage.entity)) {
      console.log(feedMessage);
      console.warn("Aucune entité trouvée dans le feed message");
      return 0;
    }

    const regularAlerts = [];
    const complementAlerts = [];

    for (const entity of feedMessage.entity) {
      if (!entity.alert) continue;

      const headerText = entity.alert.headerText?.translation?.[0]?.text || "";
      const descriptionText =
        entity.alert.descriptionText?.translation?.[0]?.text || "";

      if (isComplement(headerText, descriptionText)) {
        complementAlerts.push(entity);
      } else {
        regularAlerts.push(entity);
      }
    }

    for (const entity of regularAlerts) {
      await processAlert(entity);
    }

    for (const entity of complementAlerts) {
      await processComplement(entity);
    }

    console.log(
      `${feedMessage.entity.length} alertes traitées (dont ${complementAlerts.length} compléments)`
    );

    // Le déclenchement de la publication est fait une seule fois dans
    // fetchAndProcessAlerts après le traitement de tous les feeds.
    return feedMessage.entity.length;
  } catch (error) {
    console.error("Erreur lors de la sauvegarde des alertes:", error);
    throw error;
  }
}

function generateUniqueAlertId(entity: any): string {
  const headerText = entity.alert?.headerText?.translation?.[0]?.text || "";
  const base = headerText || new Date().toISOString();
  const hash = crypto.createHash("md5").update(base).digest("hex");
  return `${entity.id}_${hash}`;
}

async function processAlert(entity: any): Promise<void> {
  const alert = entity.alert;

  if (!alert.descriptionText?.translation?.[0]?.text) {
    console.warn(`Alerte sans description: ${entity.id}`);
    return;
  }
  console.log(alert.timeStart);

  const timeRanges = alert.activePeriod || [];
  const timeStart =
    timeRanges.length > 0 && timeRanges[0].start
      ? new Date(parseInt(timeRanges[0].start) * 1000)
      : new Date();

  const timeEnd =
    timeRanges.length > 0 && timeRanges[0].end
      ? new Date(parseInt(timeRanges[0].end) * 1000)
      : null;

  const informedEntities = alert.informedEntity || [];
  const routeIds = informedEntities
    .filter((entity: any) => entity.routeId)
    .map((entity: any) => entity.routeId)
    .join(",");

  const stopIds = informedEntities
    .filter((entity: any) => entity.stopId)
    .map((entity: any) => entity.stopId)
    .join(",");

  const headerText = alert.headerText?.translation?.[0]?.text || "";
  const descriptionText = alert.descriptionText?.translation?.[0]?.text || "";
  const url = alert.url?.translation?.[0]?.text || "";

  const cause =
    alert.cause || determineCauseByKeywords(descriptionText, headerText);
  const effect =
    alert.effect || determineEffectByKeywords(descriptionText, headerText);

  const uniqueId = generateUniqueAlertId(entity);

  await prisma.alert.upsert({
    where: { id: uniqueId },
    update: {
      timeStart,
      timeEnd,
      cause,
      effect,
      headerText,
      descriptionText,
      url,
      routeIds,
      stopIds,
      updatedAt: new Date(),
      isComplement: false,
    },
    create: {
      id: uniqueId,
      timeStart,
      timeEnd,
      cause,
      effect,
      headerText,
      descriptionText,
      url,
      routeIds,
      stopIds,
      isComplement: false,
    },
  });
}

async function processComplement(entity: {
  alert: any;
  id: any;
}): Promise<void> {
  const alert = entity.alert;

  const headerText = alert.headerText?.translation?.[0]?.text || "";
  const descriptionText = alert.descriptionText?.translation?.[0]?.text || "";
  const routeIds = extractRouteIds(alert.informedEntity);

  if (routeIds.length === 0) {
    console.warn(`Complément d'information sans route spécifiée: ${entity.id}`);
    await processAlert(entity);
    return;
  }

  const timeRanges = alert.activePeriod || [];
  const timeStart =
    timeRanges.length > 0 && timeRanges[0].start
      ? new Date(parseInt(timeRanges[0].start) * 1000)
      : new Date();

  const potentialParents = await prisma.alert.findMany({
    where: {
      AND: [
        {
          OR: routeIds.map((routeId) => ({
            routeIds: { contains: routeId },
          })),
        },
        {
          timeStart: { lte: timeStart },
          OR: [{ timeEnd: { gte: timeStart } }, { timeEnd: null }],
          isComplement: false,
        },
      ],
    },
    orderBy: { timeStart: "desc" },
  });

  if (potentialParents.length === 0) {
    console.log(
      `Aucune alerte parent trouvée pour le complément ${entity.id}, traitement comme alerte indépendante`
    );
    await processAlert(entity);
    return;
  }

  const parentAlert = potentialParents[0];

  const uniqueId = generateUniqueAlertId(entity);

  await prisma.alert.upsert({
    where: { id: uniqueId },
    update: {
      parentAlertId: parentAlert.id,
      timeStart,
      timeEnd:
        timeRanges.length > 0 && timeRanges[0].end
          ? new Date(parseInt(timeRanges[0].end) * 1000)
          : null,
      cause: parentAlert.cause,
      effect: alert.effect || parentAlert.effect || "UNKNOWN_EFFECT",
      headerText,
      descriptionText,
      url: alert.url?.translation?.[0]?.text || "",
      routeIds: routeIds.join(","),
      stopIds:
        alert.informedEntity
          ?.filter((entity: any) => entity.stopId)
          .map((entity: any) => entity.stopId)
          .join(",") || "",
      updatedAt: new Date(),
      isComplement: true,
    },
    create: {
      id: uniqueId,
      parentAlertId: parentAlert.id,
      timeStart,
      timeEnd:
        timeRanges.length > 0 && timeRanges[0].end
          ? new Date(parseInt(timeRanges[0].end) * 1000)
          : null,
      cause: parentAlert.cause,
      effect: alert.effect || parentAlert.effect || "UNKNOWN_EFFECT",
      headerText,
      descriptionText,
      url: alert.url?.translation?.[0]?.text || "",
      routeIds: routeIds.join(","),
      stopIds:
        alert.informedEntity
          ?.filter((entity: any) => entity.stopId)
          .map((entity: any) => entity.stopId)
          .join(",") || "",
      isComplement: true,
    },
  });

  await prisma.alert.update({
    where: { id: parentAlert.id },
    data: { updatedAt: new Date() },
  });

  console.log(`Complément ${uniqueId} lié à l'alerte parent ${parentAlert.id}`);
}

async function triggerTweetPosting(): Promise<void> {
  try {
    console.log("Déclenchement de la publication des tweets...");

    // Nettoyer les alertes bloquées avant de poster
    const fewMinutesAgo = new Date(Date.now() - 4 * 60 * 1000);
    console.log("Heure actuelle (UTC):", new Date().toISOString());
    console.log(
      "Heure actuelle (FR):",
      new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" })
    );
    console.log(
      "Heure limite (UTC, 4 minutes avant):",
      fewMinutesAgo.toISOString()
    );
    console.log(
      "Heure limite (FR, 4 minutes avant):",
      fewMinutesAgo.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })
    );

    // Nettoyer les alertes bloquées dans une transaction
    const dbResults = await prisma.$transaction(async (tx) => {
      // 1. Vérifier les alertes bloquées avant le nettoyage
      const stuckAlertsBefore = await tx.alert.findMany({
        where: {
          isProcessing: true,
          isPosted: false,
        },
        select: {
          id: true,
          timeStart: true,
          inProcessSince: true,
          isProcessing: true,
          isPosted: true,
        },
      });

      // 2. Nettoyer les alertes bloquées
      const stuckAlerts = await tx.alert.updateMany({
        where: {
          isProcessing: true,
          isPosted: false,
          inProcessSince: {
            lte: fewMinutesAgo.toISOString(),
          },
        },
        data: {
          isProcessing: false,
          inProcessSince: null,
        },
      });

      // 3. Compter les alertes non postées
      const unpostedCount = await tx.alert.count({
        where: {
          isPosted: false,
          isProcessing: false,
          timeStart: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
            lte: new Date(new Date().setHours(23, 59, 59, 999)),
          },
        },
      });

      return { stuckAlertsBefore, stuckAlerts, unpostedCount };
    });

    console.log(
      "Alertes bloquées avant nettoyage:",
      JSON.stringify(dbResults.stuckAlertsBefore, null, 2)
    );
    console.log(`Nettoyage de ${dbResults.stuckAlerts.count} alertes bloquées`);
    console.log("unpostedCount", dbResults.unpostedCount);

    // Poster les tweets seulement s'il y a des alertes non postées
    if (dbResults.unpostedCount > 0) {
      const result = await postToTwitter();
      console.log("Résultat de la publication des tweets:", result);
    } else {
      console.log("Aucune alerte non postée à traiter");
    }
  } catch (error) {
    console.error(
      "Erreur lors du déclenchement de la publication des tweets:",
      error
    );
  }
}

export async function fetchAndProcessAlerts(): Promise<AlertCollectionResult> {
  try {
    await ensurePrismaConnection();

    const feeds: AlertFeedResult[] = [];

    // Un flux en échec n'empêche pas le traitement des autres, mais son erreur
    // reste visible dans le bilan et dans le statut HTTP de la tâche.
    for (const url of ALERT_URLS) {
      try {
        const alertBuffer = await downloadAlertFile(url);
        const feedMessage = await parseAlertFile(alertBuffer);
        const processedEntities = await saveAlerts(feedMessage);
        feeds.push({ url, success: true, processedEntities });
      } catch (feedError) {
        console.error(`Erreur sur le feed ${url}:`, feedError);
        feeds.push({
          url,
          success: false,
          processedEntities: 0,
          error: feedError instanceof Error ? feedError.message : String(feedError),
        });
      }
    }

    const successfulFeeds = feeds.filter((feed) => feed.success).length;
    const processedEntities = feeds.reduce(
      (total, feed) => total + feed.processedEntities,
      0
    );
    const result: AlertCollectionResult = {
      success: successfulFeeds === feeds.length,
      status: successfulFeeds === feeds.length
        ? "success"
        : successfulFeeds > 0 ? "partial" : "failed",
      totalFeeds: feeds.length,
      successfulFeeds,
      failedFeeds: feeds.length - successfulFeeds,
      processedEntities,
      feeds,
    };

    // Déclencher la publication une seule fois, après tous les feeds.
    if (processedEntities > 0) {
      await triggerTweetPosting();
    }

    console.log("Bilan de collecte des alertes:", result);
    return result;
  } catch (error) {
    console.error("Erreur lors du traitement des alertes:", error);
    throw error;
  }
}

if (require.main === module) {
  fetchAndProcessAlerts()
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
