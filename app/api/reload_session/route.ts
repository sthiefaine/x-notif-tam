import { NextRequest, NextResponse } from "next/server";
import { loginToTwitter } from "../post_tweets/postTweet";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * API endpoint to reload the Twitter session
 * This will delete all existing sessions and create a new one
 */
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

    console.log("Début du rechargement de la session Twitter");
    
    // Supprimer toutes les sessions existantes
    const deleteResult = await prisma.xSession.deleteMany({});
    console.log(`${deleteResult.count} sessions supprimées de la base de données`);
    
    // Effectuer une nouvelle connexion
    const loginResult = await loginToTwitter();
    
    const response = {
      success: loginResult.success,
      message: loginResult.message,
      timestamp: new Date().toISOString(),
      sessionsDeleted: deleteResult.count,
      newSessionCreated: loginResult.success
    };
    
    console.log("Résultat du rechargement de session:", response);

    // Nettoyage
    if (loginResult.page) {
      await loginResult.page.close();
      console.log("Page fermée");
    }

    if (loginResult.browser) {
      await loginResult.browser.close();
      console.log("Navigateur fermé");
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error("Erreur lors du rechargement de la session Twitter:", error);

    return NextResponse.json(
      {
        success: false,
        error: "Erreur lors du rechargement de la session",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      { status: 500 }
    );
  }
}

export { GET as POST }; 