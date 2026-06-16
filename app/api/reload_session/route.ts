import { NextRequest, NextResponse } from "next/server";
import { isXApiConfigured } from "../post_tweets/xApiClient";

export const dynamic = "force-dynamic";

/**
 * OBSOLÈTE depuis la migration vers l'API X officielle.
 *
 * Auparavant : supprimait les sessions Puppeteer en base et en recréait une.
 * Avec l'API officielle il n'y a plus de session/cookie à recharger. Endpoint
 * conservé pour compat cron ; ne fait plus aucun appel navigateur ni login.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return new Response(JSON.stringify({ error: "Non autorisé" }), {
      status: 401,
    });
  }

  return NextResponse.json({
    success: true,
    deprecated: true,
    message:
      "Plus de session à recharger : publication via l'API X officielle (OAuth 1.0a).",
    xApiConfigured: isXApiConfigured(),
    timestamp: new Date().toISOString(),
  });
}

export { GET as POST };
