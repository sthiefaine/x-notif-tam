import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  postToTwitter,
  groupAlertsByHeader,
  formatTweetFromAlertGroup,
} from "./postTweet";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");

    if (
      process.env.CRON_SECRET &&
      authHeader !== `Bearer ${process.env.CRON_SECRET}`
    ) {
      return new Response(JSON.stringify({ error: "Non autorisé" }), {
        status: 401,
      });
    }

    const fewMinutesAgo = new Date(Date.now() - 4 * 60 * 1000);
    console.log('Heure actuelle (UTC):', new Date().toISOString());
    console.log('Heure actuelle (FR):', new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }));
    console.log('Heure limite (UTC, 4 minutes avant):', fewMinutesAgo.toISOString());
    console.log('Heure limite (FR, 4 minutes avant):', fewMinutesAgo.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }));

    // Vérifier les alertes bloquées avant le nettoyage
    const stuckAlertsBefore = await prisma.alert.findMany({
      where: {
        isProcessing: true,
        isPosted: false,
      },
      select: {
        id: true,
        timeStart: true,
        inProcessSince: true,
        isProcessing: true,
        isPosted: true
      }
    });
    console.log('Alertes bloquées avant nettoyage:', JSON.stringify(stuckAlertsBefore, null, 2));

    const stuckAlerts = await prisma.alert.updateMany({
      where: {
        isProcessing: true,
        isPosted: false,
        inProcessSince: {
          lte: fewMinutesAgo.toISOString()
        }
      },
      data: {
        isProcessing: false,
        inProcessSince: null
      }
    });

    console.log(`Nettoyage de ${stuckAlerts.count} alertes bloquées`);

    // Lire les paramètres de requête
    const searchParams = request.nextUrl.searchParams;
    const debug = searchParams.get("debug") === "true";
    const dryRun = searchParams.get("dryRun") === "true";

    // Récupérer le nombre d'alertes non postées
    const unpostedCount = await prisma.alert.count({
      where: {
        isPosted: false,
        isProcessing: false,
        timeStart: {
          gte: new Date(new Date().setHours(0, 0, 0, 0)),
          lte: new Date(new Date().setHours(23, 59, 59, 999)),
        },
      },
    });
    console.log('unpostedCount', unpostedCount);

    // Tester le formatage des tweets si demandé
    let formattedTweets = null;
    if (dryRun && unpostedCount > 0) {
      const alerts = await prisma.alert.findMany({
        where: {
          isPosted: false,
          isProcessing: false,
          timeStart: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          },
        },
        orderBy: [{ headerText: "asc" }, { timeStart: "asc" }],
      });

      const groupedAlerts = groupAlertsByHeader(alerts);
      formattedTweets = Object.entries(groupedAlerts).map(
        ([header, group]) => ({
          header,
          alertCount: group.length,
          tweet: formatTweetFromAlertGroup(group),
          routes: group.map((alert) => alert.routeIds).join(", "),
        })
      );
    }

    // Poster les tweets si demandé
    let postResult = null;
    if (unpostedCount > 0 && !dryRun) {
      console.log("Posting tweets for unposted alerts...");
      postResult = await postToTwitter();
      console.log("Post result:", postResult);
    }

    const response = {
      success: true,
      unpostedAlerts: unpostedCount,
      dryRun: dryRun || false,
      formattedTweets: formattedTweets || null,
      postingResult: postResult || null,
      debug: debug
        ? {
            environment: process.env.NODE_ENV,
            timestamp: new Date().toISOString(),
            userHandle: process.env.USER_HANDLE,
          }
        : undefined,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Erreur lors du test de tweet:", error);

    return NextResponse.json(
      {
        success: false,
        error: "Erreur lors du test",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      { status: 500 }
    );
  }
}

export { GET as POST };
