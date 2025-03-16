import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { RateLimiterMemory, IRateLimiterRes } from "rate-limiter-flexible";

const rateLimiter = new RateLimiterMemory({
  points: 10, // requêtes autorisées
  duration: 60, // Par minute
});

function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const realIp = request.headers.get("x-real-ip");
  return forwardedFor?.split(",")[0] || realIp || "127.0.0.1";
}

function extractRouteNumber(routeId: string): string {
  return routeId.split("-").pop() || routeId;
}

async function checkRateLimit(ip: string): Promise<{
  allowed: boolean;
  resetInSeconds: number;
  remaining: number;
}> {
  try {
    const rateLimiterRes = await rateLimiter.consume(ip);
    return {
      allowed: true,
      resetInSeconds: Math.ceil(rateLimiterRes.msBeforeNext / 1000),
      remaining: rateLimiterRes.remainingPoints,
    };
  } catch (rejRes) {
    const resetInSeconds = Math.ceil(
      (rejRes as IRateLimiterRes).msBeforeNext ?? 0 / 1000
    );
    return {
      allowed: false,
      resetInSeconds,
      remaining: 0,
    };
  }
}

export async function GET(request: NextRequest) {
  const clientIp = getClientIp(request);
  const rateLimitResult = await checkRateLimit(clientIp);

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
          "X-RateLimit-Limit": "6",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(
            Math.floor(Date.now() / 1000) + rateLimitResult.resetInSeconds
          ),
        },
      }
    );
  }

  try {
    const searchParams = request.nextUrl.searchParams;

    const active = searchParams.get("active");
    const completed = searchParams.get("completed");
    const upcoming = searchParams.get("upcoming");

    const route = searchParams.get("route");
    const stop = searchParams.get("stop");

    const timeFrame = searchParams.get("timeFrame");

    const page = parseInt(searchParams.get("page") || "1");
    const pageSize = parseInt(searchParams.get("pageSize") || "20");
    const skip = (page - 1) * pageSize;

    const sortBy = searchParams.get("sortBy") || "timeStart";
    const sortOrder = searchParams.get("sortOrder") || "desc";

    let whereClause: Prisma.AlertWhereInput = {};
    const now = new Date();

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

    if (route) {
      whereClause = {
        ...whereClause,
        routeIds: route.includes("-")
          ? `7-${route.split("-")[1]}`
          : `7-${route}`,
      };
    }

    if (stop) {
      whereClause = {
        ...whereClause,
        stopIds: { contains: stop },
      };
    }

    if (timeFrame) {
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);

      if (timeFrame === "today") {
        whereClause.timeStart = { gte: startOfDay };
      } else if (timeFrame === "week") {
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - now.getDay());
        startOfWeek.setHours(0, 0, 0, 0);
        whereClause.timeStart = { gte: startOfWeek };
      } else if (timeFrame === "month") {
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        whereClause.timeStart = { gte: startOfMonth };
      }
    }

    const totalAlerts = await prisma.alert.count({
      where: whereClause,
    });

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

          const routeInfo = await Promise.all(
            routeIds.map(async (routeId) => {
              const updatedRouteId = `8-${routeId.split("-")[1]}`;
              const lineGeometry = await prisma.lineGeometry.findFirst({
                where: { routeId: updatedRouteId },
                select: { lineType: true },
              });

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
          "Cache-Control": "public, max-age=60",
          "X-RateLimit-Limit": "6",
          "X-RateLimit-Remaining": String(rateLimitResult.remaining),
          "X-RateLimit-Reset": String(
            Math.floor(Date.now() / 1000) + rateLimitResult.resetInSeconds
          ),
          "X-Data-Source":
            "Donnees issues de Montpellier Mediterranee Metropole - Offre de transport TAM en temps reel",
          "X-Data-License": "ODbL",
        },
      }
    );
  } catch (error) {
    console.error("Erreur lors de la récupération des alertes:", error);

    return NextResponse.json(
      {
        error: "Erreur lors de la récupération des alertes",
        message: error instanceof Error ? error.message : String(error),
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
