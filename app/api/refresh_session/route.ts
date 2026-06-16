import { NextRequest, NextResponse } from "next/server";
import { isXApiConfigured } from "../post_tweets/xApiClient";

export const dynamic = "force-dynamic";

/**
 * OBSOLÈTE depuis la migration vers l'API X officielle.
 *
 * Il n'y a plus de session navigateur (cookies Puppeteer) à rafraîchir :
 * l'authentification se fait par OAuth 1.0a à chaque appel. Cet endpoint est
 * conservé pour ne pas casser un éventuel cron existant, mais ne fait plus
 * que renvoyer l'état de configuration de l'API. Il NE tente plus aucun login.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }

  return NextResponse.json({
    success: true,
    deprecated: true,
    message:
      "Plus de session à rafraîchir : publication via l'API X officielle (OAuth 1.0a).",
    xApiConfigured: isXApiConfigured(),
    timestamp: new Date().toISOString(),
  });
}

export { GET as POST };
