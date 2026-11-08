import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  postToTwitter,
  groupAlertsByHeader,
  formatTweetFromAlertGroup,
  getPublicationWindow,
} from "./postTweet";
import { isXApiConfigured } from "./xApiClient";
import { getPublisherConfiguration } from "./publisher";
import { getKnownAlertRouteIds } from "./alertRoutes";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function publicationHolds(timeStart: ReturnType<typeof getPublicationWindow>) {
  const held = await prisma.alert.findMany({
    where: { isPosted: false, isProcessing: true, inProcessSince: null, timeStart },
    select: { id: true },
  });
  const ledgerEnabled = Boolean(process.env.DATABASE_URL) && process.env.TRANSIT_PUBLICATION_LEDGER !== "false";
  const heldUncertainAlerts = ledgerEnabled
    ? held.length ? await prisma.publicationLedger.count({ where: { alertId: { in: held.map((alert) => alert.id) }, status: "UNCERTAIN" } }) : 0
    : null;
  return { heldAlerts: held.length, heldUncertainAlerts };
}

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    if (!process.env.CRON_SECRET) {
      return NextResponse.json({
        success: false,
        error: "CRON_SECRET doit être configuré pour accéder à la publication.",
      }, { status: 503 });
    }
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ success: false, error: "Non autorisé" }, {
        status: 401,
      });
    }

    const searchParams = request.nextUrl.searchParams;
    const debug = searchParams.get("debug") === "true";
    const dryRun = searchParams.get("dryRun") === "true";
    const xApiConfigured = isXApiConfigured();
    const configuration = getPublisherConfiguration();
    const missingVariables = configuration.missingVariables;

    // Un défaut de configuration doit être visible même si la DB est indisponible.
    // La prévisualisation reste possible sans identifiants X.
    if (!dryRun && !configuration.configured) {
      return NextResponse.json({
        success: false,
        dryRun: false,
        xApiConfigured,
        postingMode: configuration.mode,
        publishingConfigured: configuration.configured,
        missingVariables,
        heldAlerts: null,
        heldUncertainAlerts: null,
        postingState: "unconfigured",
        postingResult: await postToTwitter(),
      }, { status: 503 });
    }

    const where = {
      isPosted: false,
      isProcessing: false,
      timeStart: getPublicationWindow(),
    };
    let unpostedCount: number;
    let formattedTweets = null;

    if (dryRun) {
      // Strictement en lecture seule : aucun nettoyage ni verrou de publication.
      const [count, alerts] = await Promise.all([
        prisma.alert.count({ where }),
        prisma.alert.findMany({
          where,
          orderBy: { timeStart: "asc" },
          take: 20,
        }),
      ]);
      unpostedCount = count;
      const groupedAlerts = groupAlertsByHeader(alerts);
      const knownRouteIds = alerts.length > 0 ? await getKnownAlertRouteIds() : undefined;
      formattedTweets = Object.entries(groupedAlerts).map(([header, group]) => ({
        header,
        alertCount: group.length,
        tweet: formatTweetFromAlertGroup(group, knownRouteIds),
        routes: group.map((alert) => alert.routeIds).join(", "),
      }));
    } else {
      unpostedCount = await prisma.$transaction(async (tx) => {
        await tx.alert.updateMany({
          where: {
            isProcessing: true,
            isPosted: false,
            inProcessSince: { lte: new Date(Date.now() - 4 * 60 * 1000) },
          },
          data: { isProcessing: false, inProcessSince: null },
        });
        return tx.alert.count({ where });
      });
    }

    const postResult = !dryRun && unpostedCount > 0
      ? await postToTwitter()
      : null;
    const holds = await publicationHolds(where.timeStart);
    const hasHeld = holds.heldAlerts > 0;
    const success = (postResult?.success ?? true) && !hasHeld;
    const postingState = hasHeld ? unpostedCount > 0 ? "partially_quarantined" : "quarantined"
      : postResult ? postResult.success ? "posted" : "failed" : dryRun ? "preview" : "idle";
    const heldStatus = hasHeld && (!postResult || postResult.success) && !dryRun ? 409 : undefined;
    const retryAfter = postResult?.errors?.find((error) => error.retryAfter)?.retryAfter;

    return NextResponse.json({
      success,
      unpostedAlerts: unpostedCount,
      dryRun,
      xApiConfigured,
      postingMode: configuration.mode,
      publishingConfigured: configuration.configured,
      missingVariables,
      formattedTweets,
      postingResult: postResult,
      ...holds,
      postingState,
      ...(hasHeld ? { message: "Des alertes ont été collectées mais restent protégées en attente de confirmation de publication. Aucun nouvel envoi automatique pour ces alertes." } : {}),
      debug: debug ? {
        environment: process.env.NODE_ENV,
        timestamp: new Date().toISOString(),
        userHandle: process.env.X_ACCOUNT_HANDLE ?? process.env.USER_HANDLE,
      } : undefined,
    }, {
      status: heldStatus ?? postResult?.httpStatus ?? (success || dryRun ? 200 : 502),
      headers: retryAfter ? { "Retry-After": String(retryAfter) } : undefined,
    });
  } catch (error) {
    console.error("Erreur lors de la préparation de la publication:",
      error instanceof Error ? error.name : "Erreur inconnue");
    return NextResponse.json({
      success: false,
      error: "Impossible de préparer la publication des alertes.",
      xApiConfigured: isXApiConfigured(),
      postingMode: getPublisherConfiguration().mode,
      publishingConfigured: getPublisherConfiguration().configured,
      missingVariables: getPublisherConfiguration().missingVariables,
    }, { status: 503 });
  }
}

export { GET as POST };
