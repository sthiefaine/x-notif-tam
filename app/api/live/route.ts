import { NextRequest, NextResponse } from "next/server";
import { ensureLiveCollector, getLiveSnapshot, liveSnapshotEtag } from "@/lib/transit/live";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  ensureLiveCollector();
  const snapshot = getLiveSnapshot();
  const etag = liveSnapshotEtag(snapshot);
  const headers = { "ETag": etag, "Cache-Control": "public, max-age=0, must-revalidate", "X-Transit-Status": snapshot.meta.status };
  if (request.headers.get("if-none-match")?.split(",").map((value) => value.trim()).includes(etag)) {
    return new Response(null, { status: 304, headers });
  }
  return NextResponse.json(snapshot, { headers });
}
