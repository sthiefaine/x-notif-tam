import { timingSafeEqual } from "node:crypto";

export function requireTransitAdmin(request: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret?.trim()) return Response.json({ success: false, message: "Maintenance non configurée." }, { status: 503 });
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") || "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return Response.json({ success: false, message: "Non autorisé." }, { status: 401 });
  }
  return null;
}
