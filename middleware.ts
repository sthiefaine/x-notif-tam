import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { LRUCache } from "lru-cache";

// Configuration des limites par route
const rateLimits: Record<string, { limit: number; window: number }> = {
  default: { limit: 60, window: 60 },
  "/api/alerts": { limit: 10, window: 60 },
};

const rateLimitCaches: Record<
  string,
  LRUCache<string, { count: number; resetTime: number }>
> = {};

Object.keys(rateLimits).forEach((path) => {
  rateLimitCaches[path] = new LRUCache({
    max: 500,
    ttl: rateLimits[path].window * 1000,
  });
});

function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const realIp = request.headers.get("x-real-ip");
  return (forwardedFor?.split(",")[0] || realIp || "127.0.0.1").trim();
}

function getRateLimitConfig(pathname: string): {
  limit: number;
  window: number;
  cachePath: string;
} {
  const matchingPath =
    Object.keys(rateLimits)
      .filter((path) => path !== "default" && pathname.startsWith(path))
      .sort((a, b) => b.length - a.length)[0] || "default";

  return {
    ...rateLimits[matchingPath],
    cachePath: matchingPath,
  };
}

// Configurer le matcher pour limiter l'application du middleware
export const config = {
  matcher: "/api/:path*",
};

export function middleware(request: NextRequest) {
  // Skip si la méthode est OPTIONS (pour CORS preflight)
  if (request.method === "OPTIONS") {
    return NextResponse.next();
  }

  const pathname = request.nextUrl.pathname;

  const clientIp = getClientIp(request);

  const { limit, window, cachePath } = getRateLimitConfig(pathname);

  const cache = rateLimitCaches[cachePath];

  const now = Date.now();

  let rateLimit = cache.get(clientIp);

  if (!rateLimit || now > rateLimit.resetTime) {
    rateLimit = {
      count: 1,
      resetTime: now + window * 1000,
    };
    cache.set(clientIp, rateLimit);

    const response = NextResponse.next();

    response.headers.set("X-RateLimit-Limit", String(limit));
    response.headers.set("X-RateLimit-Remaining", String(limit - 1));
    response.headers.set(
      "X-RateLimit-Reset",
      String(Math.ceil(rateLimit.resetTime / 1000))
    );

    return response;
  }

  rateLimit.count++;

  if (rateLimit.count > limit) {
    const resetInSeconds = Math.ceil((rateLimit.resetTime - now) / 1000);

    return new NextResponse(
      JSON.stringify({
        error: "Rate limit exceeded",
        message: `Too many requests. Please try again in ${resetInSeconds} seconds.`,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(resetInSeconds),
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(Math.ceil(rateLimit.resetTime / 1000)),
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      }
    );
  }

  cache.set(clientIp, rateLimit);

  const response = NextResponse.next();

  response.headers.set("X-RateLimit-Limit", String(limit));
  response.headers.set(
    "X-RateLimit-Remaining",
    String(limit - rateLimit.count)
  );
  response.headers.set(
    "X-RateLimit-Reset",
    String(Math.ceil(rateLimit.resetTime / 1000))
  );

  return response;
}
