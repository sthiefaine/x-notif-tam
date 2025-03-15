// app/api/alerts/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Simple in-memory rate limiter
const RATE_LIMIT = 6; // requests per minute
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute in milliseconds
const ipRequestCounts = new Map<string, { count: number; resetTime: number }>();

function getClientIp(request: NextRequest): string {
  // Get IP from Vercel's headers or fallback to a placeholder
  const forwardedFor = request.headers.get("x-forwarded-for");
  return forwardedFor?.split(",")[0] || "127.0.0.1";
}

// Extracts route number from route ID
function extractRouteNumber(routeId: string): string {
  return routeId.split("-").pop() || routeId;
}

// Function to check and apply rate limiting
function checkRateLimit(request: NextRequest): {
  allowed: boolean;
  resetInSeconds: number;
} {
  const clientIp = getClientIp(request);
  const now = Date.now();

  // Get current state for this IP
  const currentState = ipRequestCounts.get(clientIp);

  // If no state or reset time has passed, create/reset the state
  if (!currentState || now > currentState.resetTime) {
    ipRequestCounts.set(clientIp, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW,
    });
    return { allowed: true, resetInSeconds: RATE_LIMIT_WINDOW / 1000 };
  }

  // If under limit, increment count
  if (currentState.count < RATE_LIMIT) {
    currentState.count++;
    ipRequestCounts.set(clientIp, currentState);
    const resetInSeconds = Math.ceil((currentState.resetTime - now) / 1000);
    return { allowed: true, resetInSeconds };
  }

  // Over limit
  const resetInSeconds = Math.ceil((currentState.resetTime - now) / 1000);
  return { allowed: false, resetInSeconds };
}

export async function GET(request: NextRequest) {
  // Apply rate limiting
  const rateLimitResult = checkRateLimit(request);
  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      {
        error: "Rate limit exceeded",
        message: `Too many requests. Please try again in ${rateLimitResult.resetInSeconds} seconds.`,
      },
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(rateLimitResult.resetInSeconds),
          "X-RateLimit-Limit": String(RATE_LIMIT),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(
            Math.ceil(Date.now() / 1000 + rateLimitResult.resetInSeconds)
          ),
        },
      }
    );
  }

  try {
    const searchParams = request.nextUrl.searchParams;

    // Filtres d'état
    const active = searchParams.get("active");
    const completed = searchParams.get("completed");
    const upcoming = searchParams.get("upcoming");

    // Filtres de contenu
    const route = searchParams.get("route");
    const stop = searchParams.get("stop");

    // Filtres de temps
    const timeFrame = searchParams.get("timeFrame");

    // Pagination
    const page = parseInt(searchParams.get("page") || "1");
    const pageSize = parseInt(searchParams.get("pageSize") || "20");
    const skip = (page - 1) * pageSize;

    // Tri
    const sortBy = searchParams.get("sortBy") || "timeStart";
    const sortOrder = searchParams.get("sortOrder") || "desc";

    // Construction de la clause where
    let whereClause: any = {};
    const now = new Date();

    console.log("Date actuelle pour comparaison:", now.toISOString());
    console.log("Requête d'alertes avec paramètres:", {
      active,
      completed,
      upcoming,
      route,
      stop,
      timeFrame,
      page,
      pageSize,
    });

    // Filtres par statut d'alerte
    if (active === "true") {
      whereClause = {
        ...whereClause,
        timeStart: { lte: now },
        OR: [{ timeEnd: { gte: now } }, { timeEnd: null }],
      };
    } else if (completed === "true") {
      whereClause = {
        ...whereClause,
        AND: [{ timeEnd: { not: null } }, { timeEnd: { lt: now } }],
      };
    } else if (upcoming === "true") {
      whereClause = {
        ...whereClause,
        timeStart: { gt: now },
      };
    }

    // Filtre par route
    if (route) {
      whereClause = {
        ...whereClause,
        routeIds: { contains: route },
      };
    }

    // Filtre par arrêt
    if (stop) {
      whereClause = {
        ...whereClause,
        stopIds: { contains: stop },
      };
    }

    // Filtre par période
    if (timeFrame) {
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);

      if (timeFrame === "today") {
        whereClause.timeStart = { gte: startOfDay };
      } else if (timeFrame === "week") {
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - now.getDay()); // Début de la semaine (dimanche)
        startOfWeek.setHours(0, 0, 0, 0);
        whereClause.timeStart = { gte: startOfWeek };
      } else if (timeFrame === "month") {
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        whereClause.timeStart = { gte: startOfMonth };
      }
    }

    console.log("Clause where Prisma:", JSON.stringify(whereClause, null, 2));

    // Requête pour obtenir le nombre total d'alertes (pour la pagination)
    const totalAlerts = await prisma.alert.count({
      where: whereClause,
    });

    // Requête principale - utilisation de select pour exclure isPosted
    const alerts = await prisma.alert.findMany({
      where: whereClause,
      take: pageSize,
      skip: skip,
      orderBy: {
        [sortBy]: sortOrder,
      },
      select: {
        id: true,
        timeStart: true,
        timeEnd: true,
        cause: true,
        effect: true,
        headerText: true,
        descriptionText: true,
        url: true,
        routeIds: true,
        stopIds: true,
        isComplement: true,
        parentAlertId: true,
        complements: {
          select: {
            id: true,
            headerText: true,
            descriptionText: true,
            timeStart: true,
            timeEnd: true,
          },
        },
      },
    });

    console.log(`Alertes trouvées: ${alerts.length}`);

    // Récupérer les informations de lineType pour les routes associées
    const processedAlerts = await Promise.all(
      alerts.map(async (alert) => {
        let routeDetails: {
          routeId: string;
          routeNumber: string;
          lineType: string | null;
          shortName: string | null;
          longName: string | null;
          type: number | null;
          color: string | null;
          textColor: string | null;
        }[] = [];

        if (alert.routeIds) {
          const routeIds = alert.routeIds.split(",").map((r) => r.trim());

          // Pour chaque ID de route, récupérer le lineType
          const routeInfo = await Promise.all(
            routeIds.map(async (routeId) => {
              // Recherche du lineType dans la table LineGeometry
              const lineGeometry = await prisma.lineGeometry.findFirst({
                where: { routeId },
                select: { lineType: true },
              });

              // Recherche des informations de base de la route
              const route = await prisma.route.findUnique({
                where: { id: routeId },
                select: {
                  shortName: true,
                  longName: true,
                  type: true,
                  color: true,
                  textColor: true,
                },
              });

              return {
                routeId,
                routeNumber: extractRouteNumber(routeId),
                lineType: lineGeometry?.lineType || null,
                shortName: route?.shortName || null,
                longName: route?.longName || null,
                type: route?.type || null,
                color: route?.color || null,
                textColor: route?.textColor || null,
              };
            })
          );

          routeDetails = routeInfo;
        }

        return {
          ...alert,
          routeDetails,
        };
      })
    );

    // Calcul des informations de pagination
    const totalPages = Math.ceil(totalAlerts / pageSize);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;

    return NextResponse.json(
      {
        data: processedAlerts,
        pagination: {
          totalItems: totalAlerts,
          totalPages,
          currentPage: page,
          pageSize,
          hasNextPage,
          hasPrevPage,
        },
      },
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60", // Cache de 1 minute
          "X-RateLimit-Limit": String(RATE_LIMIT),
          "X-RateLimit-Remaining": String(
            RATE_LIMIT -
              (ipRequestCounts.get(getClientIp(request))?.count || 1) +
              1
          ),
          "X-RateLimit-Reset": String(
            Math.ceil(
              ipRequestCounts.get(getClientIp(request))?.resetTime || 0
            ) / 1000
          ),
        },
      }
    );
  } catch (error) {
    console.error("Erreur lors de la récupération des alertes:", error);

    return NextResponse.json(
      {
        error: "Erreur lors de la récupération des alertes",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, max-age=0",
        },
      }
    );
  }
}
