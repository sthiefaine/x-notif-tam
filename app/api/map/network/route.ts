import { getTransitNetwork } from "@/lib/transit/network";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const network = await getTransitNetwork();
    const etag = `"network-${network.metadata.version}"`;
    const headers = {
      "ETag": etag,
      "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
      "X-Content-Type-Options": "nosniff",
    };
    const match = request.headers.get("if-none-match")?.split(",")
      .some((value) => value.trim().replace(/^W\//, "") === etag || value.trim() === "*");
    if (match) return new Response(null, { status: 304, headers });
    return Response.json(network, { headers });
  } catch {
    return Response.json({ error: "Le réseau de transport est temporairement indisponible." }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
