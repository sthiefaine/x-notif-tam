import { NextRequest } from "next/server";
import { fetchAndProcessAlerts } from "@/tasks/fetchAlerts";
import { revalidatePath, revalidateTag } from "next/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");

    if (
      process.env.CRON_SECRET &&
      authHeader !== `Bearer ${process.env.CRON_SECRET}`
    ) {
      return new Response(JSON.stringify({ error: "Non autorisé" }), {
        status: 401,
      });
    }

    await fetchAndProcessAlerts();

    revalidatePath("/");
    revalidateTag("alerts");

    return new Response(
      JSON.stringify({
        success: true,
        message: "Alertes mises à jour avec succès",
      })
    );
  } catch (error) {
    console.error("Erreur lors de l'exécution de la tâche CRON:", error);
    return new Response(
      JSON.stringify({ error: "Erreur lors de la mise à jour des alertes" }),
      { status: 500 }
    );
  }
}
