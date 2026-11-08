import { requireTransitAdmin } from "@/lib/transit/auth";
import { runTransitMaintenance, transitStorageEnabled } from "@/lib/transit/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 65;

export async function POST(request: Request) {
  const denied = requireTransitAdmin(request);
  if (denied) return denied;
  if (!transitStorageEnabled()) return Response.json({ success: false, message: "Le stockage transport est désactivé." }, { status: 503 });
  const params = new URL(request.url).searchParams;
  try {
    return Response.json(await runTransitMaintenance({ dryRun: params.get("dryRun") === "true", purge: params.get("purge") === "true" }),
      { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ success: false, message: "Maintenance interrompue ; les données non agrégées sont conservées." }, { status: 503 });
  }
}
