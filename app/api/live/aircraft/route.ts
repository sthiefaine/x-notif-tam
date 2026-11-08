import { NextRequest, NextResponse } from "next/server";
import { aircraftSnapshotEtag, getAircraftSnapshot } from "@/lib/aircraft/live";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;
export async function GET(request: NextRequest) {
  const snapshot = await getAircraftSnapshot();
  const etag = aircraftSnapshotEtag(snapshot);
  const seconds = Math.max(1, Math.ceil((Date.parse(snapshot.meta.nextUpdateAt) - Date.now()) / 1000));
  const headers = { ETag: etag, "Cache-Control": "public, max-age=0, must-revalidate",
    "X-Aircraft-Coverage": "incomplete", "Retry-After": String(seconds) };
  if (request.headers.get("if-none-match")?.split(",").map((value) => value.trim()).includes(etag)) {
    return new Response(null, { status: 304, headers });
  }
  return NextResponse.json(snapshot, { headers });
}
