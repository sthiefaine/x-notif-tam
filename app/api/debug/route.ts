import { NextRequest, NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";

export async function GET(request: NextRequest) {
  try {
    const screenshotPath = "/tmp/login-debug.png";
    
    if (!existsSync(screenshotPath)) {
      return NextResponse.json(
        { error: "No debug screenshot found" },
        { status: 404 }
      );
    }

    const imageBuffer = readFileSync(screenshotPath);
    
    return new NextResponse(imageBuffer, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": imageBuffer.length.toString(),
      },
    });
  } catch (error) {
    console.error("Error serving debug screenshot:", error);
    return NextResponse.json(
      { error: "Failed to serve debug screenshot" },
      { status: 500 }
    );
  }
}