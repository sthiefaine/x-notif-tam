import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { postToTwitter, groupAlertsByHeader, formatTweetFromAlertGroup } from './postTweet';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Fonction pour créer une alerte de test
async function createTestAlert(headerText: string, description: string, routes: string, cause: string = "MAINTENANCE", effect: string = "DETOUR") {
  const alert = await prisma.alert.create({
    data: {
      id: `test-${Date.now()}-${Math.floor(Math.random() * 1000)}`, // Ensure unique IDs
      timeStart: new Date(),
      headerText,
      descriptionText: description,
      routeIds: routes,
      cause,
      effect,
      isPosted: false,
    },
  });

  return alert;
}

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
    // Lire les paramètres de requête
    const searchParams = request.nextUrl.searchParams;
    const createTests = true;
    const debug = searchParams.get("debug") === "true";
    const dryRun = searchParams.get("dryRun") === "true";

    // Créer des alertes de test si demandé
    let testAlerts: any[] = [];
    if (createTests) {
      console.log("Creating test alerts...");
      
      // Premier test: Deux alertes pour les trams 1 et 2 avec le même header
      const headerForTrams = "Perturbation réseau tramway";
      const descForTrams = "En raison de travaux sur les voies, trafic perturbé jusqu'à 18h.";
      
      const tramAlert1 = await createTestAlert(
        headerForTrams,
        descForTrams,
        "T1",
        "MAINTENANCE",
        "DETOUR"
      );
      
      const tramAlert2 = await createTestAlert(
        headerForTrams,
        descForTrams,
        "T2",
        "MAINTENANCE",
        "DETOUR"
      );
      
      // Troisième test: Une alerte pour le bus 24
      const busAlert = await createTestAlert(
        "Déviation ligne de bus",
        "En raison d'un accident, la ligne est déviée par le boulevard central.",
        "24",
        "ACCIDENT",
        "DETOUR"
      );
      
      testAlerts = [tramAlert1, tramAlert2, busAlert];
      console.log(`Created ${testAlerts.length} test alerts`);
    }

    // Récupérer le nombre d'alertes non postées
    const unpostedCount = await prisma.alert.count({
      where: {
        isPosted: false,
        timeStart: {
          gte: new Date(new Date().setHours(0, 0, 0, 0)), // Aujourd'hui
        }
      }
    });

    // Tester le formatage des tweets si demandé
    let formattedTweets = null;
    if (dryRun && unpostedCount > 0) {
      const alerts = await prisma.alert.findMany({
        where: {
          isPosted: false,
          timeStart: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          }
        },
        orderBy: [
          { headerText: 'asc' },
          { timeStart: 'asc' },
        ],
      });
      
      const groupedAlerts = groupAlertsByHeader(alerts);
      formattedTweets = Object.entries(groupedAlerts).map(([header, group]) => ({
        header,
        alertCount: group.length,
        tweet: formatTweetFromAlertGroup(group),
        routes: group.map(alert => alert.routeIds).join(', ')
      }));
    }

    // Poster les tweets si demandé
    let postResult = null;
    if (unpostedCount > 0 && !dryRun) {
      console.log("Posting tweets for unposted alerts...");
      postResult = await postToTwitter();
      console.log("Post result:", postResult);
    }

    console.log("================================");

    // Construire la réponse
    const response = {
      success: true,
      testAlertsCreated: createTests ? testAlerts.length : 0,
      testAlertDetails: createTests ? testAlerts.map(alert => ({
        id: alert.id,
        header: alert.headerText,
        routes: alert.routeIds
      })) : null,
      unpostedAlerts: unpostedCount,
      dryRun: dryRun || false,
      formattedTweets: formattedTweets,
      postingResult: postResult,
      debug: debug ? {
        environment: process.env.NODE_ENV,
        timestamp: new Date().toISOString(),
        userHandle: process.env.USER_HANDLE,
      } : undefined
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Erreur lors du test de tweet:", error);
    
    return NextResponse.json(
      {
        success: false,
        error: "Erreur lors du test",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    );
  }
}

export { GET as POST };