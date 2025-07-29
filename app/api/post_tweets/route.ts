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

    // Vérifier l'authentification seulement si CRON_SECRET est défini
    if (process.env.CRON_SECRET) {
      if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return new Response(JSON.stringify({ error: "Non autorisé" }), {
          status: 401,
        });
      }
    } else {
      console.warn("authentification désactivée");
    }

    const fewMinutesAgo = new Date(Date.now() - 4 * 60 * 1000);
    // Lire les paramètres de requête AVANT la transaction
    const searchParams = request.nextUrl.searchParams;
    const debug = searchParams.get("debug") === "true";
    const dryRun = searchParams.get("dryRun") === "true";

    // Optimisation : Combiner toutes les requêtes en une seule transaction
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
          isPosted: true
        }
      });

      // 2. Nettoyer les alertes bloquées
      const stuckAlerts = await tx.alert.updateMany({
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

      // 4. Récupérer les alertes pour dryRun si nécessaire
      let alertsForDryRun = null;
      if (dryRun && unpostedCount > 0) {
        alertsForDryRun = await tx.alert.findMany({
          where: {
            isPosted: false,
            isProcessing: false,
            timeStart: {
              gte: new Date(new Date().setHours(0, 0, 0, 0)),
            },
          },
          orderBy: [{ headerText: "asc" }, { timeStart: "asc" }],
        });
      }

      return { stuckAlertsBefore, stuckAlerts, unpostedCount, alertsForDryRun };
    });

    console.log('Alertes bloquées avant nettoyage:', JSON.stringify(dbResults.stuckAlertsBefore, null, 2));
    console.log(`Nettoyage de ${dbResults.stuckAlerts.count} alertes bloquées`);

    console.log('unpostedCount', dbResults.unpostedCount);

    // Tester le formatage des tweets si demandé
    let formattedTweets = null;
    if (dryRun && dbResults.unpostedCount > 0 && dbResults.alertsForDryRun) {
      const groupedAlerts = groupAlertsByHeader(dbResults.alertsForDryRun);
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
    if (dbResults.unpostedCount > 0 && !dryRun) {
      console.log("Posting tweets for unposted alerts...");
      postResult = await postToTwitter();
      console.log("Post result:", postResult);
    }

    const response = {
      success: true,
      unpostedAlerts: dbResults.unpostedCount,
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
