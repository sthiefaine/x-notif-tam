import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";
import path from "path";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const resolvedParams = await params;
    const filePath = resolvedParams.path.join("/");
    const screenshotPath = path.join(process.cwd(), "public", "screenshots", filePath);

    if (!existsSync(screenshotPath)) {
      return new NextResponse("Screenshot not found", { status: 404 });
    }

    const fileBuffer = readFileSync(screenshotPath);
    
    return new NextResponse(fileBuffer, {
      headers: {
        "Content-Type": "image/png",
        "Content-Disposition": `inline; filename="${path.basename(filePath)}"`,
      },
    });
  } catch (error) {
    console.error("Error serving screenshot:", error);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}