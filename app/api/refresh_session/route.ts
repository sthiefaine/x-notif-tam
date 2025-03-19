import { NextRequest, NextResponse } from "next/server";
import { loginToTwitter } from "../post_tweets/postTweet";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * API endpoint to refresh the Twitter session
 * This will attempt to login to Twitter and update the session in the database
 * It's designed to be called by a cron job at a scheduled time (1:00 AM)
 */
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    if (
      process.env.CRON_SECRET &&
      authHeader !== `Bearer ${process.env.CRON_SECRET}`
    ) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      });
    }

    console.log("Starting Twitter session refresh process");
    
    const loginResult = await loginToTwitter();
    
    const response = {
      success: loginResult.success,
      message: loginResult.message,
      timestamp: new Date().toISOString(),
      sessionRefreshed: loginResult.success
    };
    
    console.log("Session refresh result:", response);

    if (loginResult.page) {
      await loginResult.page.close();
      console.log("Page closed");
    }

    if (loginResult.browser) {
      await loginResult.browser.close();
      console.log("Browser closed");
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error("Error refreshing Twitter session:", error);

    return NextResponse.json(
      {
        success: false,
        error: "Error refreshing session",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      { status: 500 }
    );
  }
}

export { GET as POST };