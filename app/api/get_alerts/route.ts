import { NextRequest } from "next/server";
import { fetchAndProcessAlerts } from "@/tasks/fetchAlerts";
import { connectionManager } from "@/lib/connection-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    if (!process.env.CRON_SECRET) {
      return Response.json(
        { success: false, error: "CRON_SECRET doit être configuré pour exécuter cette tâche" },
        { status: 503 }
      );
    }

    const authHeader = request.headers.get("authorization");

    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return new Response(JSON.stringify({ error: "Non autorisé" }), {
        status: 401,
      });
    }

    // Ensure connection before processing
    await connectionManager.connect();
    
    const result = await fetchAndProcessAlerts();

    return Response.json(
      {
        ...result,
        message: result.success
          ? "Alertes mises à jour avec succès"
          : "La collecte des alertes a rencontré des erreurs",
        connectionHealthy: connectionManager.isHealthy(),
      },
      { status: result.success ? 200 : 502 }
    );
  } catch (error) {
    console.error("Erreur lors de l'exécution de la tâche CRON:", error);
    return new Response(
      JSON.stringify({ 
        error: "Erreur lors de la mise à jour des alertes",
        connectionHealthy: connectionManager.isHealthy(),
        details: error instanceof Error ? error.message : String(error)
      }),
      { status: 500 }
    );
  }
}

// Coolify appelle les tâches en POST ; Vercel Cron les appelle en GET.
export { GET as POST };
