import { randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createBrowserPublisher, normalizeBrowserFailure } from "@/app/api/post_tweets/browserClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

const MAX_BODY_BYTES = 128 * 1024;
type JsonRecord = Record<string, unknown>;
type SessionCookie = {
  name: string; value: string; domain: string; path: string; expires: number;
  httpOnly: boolean; secure: boolean; sameSite: "Strict" | "Lax" | "None";
  partitionKey?: string;
};
type SessionState = {
  cookies: SessionCookie[];
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
};

class SessionRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const json = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

function authorize(request: Request): Response | undefined {
  const secret = process.env.CRON_SECRET;
  if (!secret?.trim()) {
    return json({ success: false, code: "CRON_NOT_CONFIGURED", detail: "CRON_SECRET doit être configuré." }, 503);
  }
  const actual = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return json({ success: false, code: "UNAUTHORIZED", detail: "Non autorisé." }, 401);
  }
}

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isXHost = (hostname: string) => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*x\.com$/i.test(hostname);
const isXOrigin = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && url.origin === value && isXHost(url.hostname);
  } catch {
    return false;
  }
};
const invalidSession = (): never => {
  throw new SessionRequestError(400, "INVALID_SESSION", "Le fichier doit contenir uniquement une session Playwright X valide et non expirée.");
};

function validateSession(value: unknown): SessionState {
  if (!isRecord(value) || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) return invalidSession();
  const cookies: SessionCookie[] = value.cookies.map((cookie: unknown) => {
    if (!isRecord(cookie)
      || typeof cookie.name !== "string" || !cookie.name
      || typeof cookie.value !== "string"
      || typeof cookie.domain !== "string" || !isXHost(cookie.domain.replace(/^\./, ""))
      || typeof cookie.path !== "string" || !cookie.path.startsWith("/")
      || typeof cookie.expires !== "number" || !Number.isFinite(cookie.expires)
      || (cookie.expires !== -1 && cookie.expires <= 0)
      || typeof cookie.httpOnly !== "boolean" || typeof cookie.secure !== "boolean"
      || typeof cookie.sameSite !== "string" || !["Strict", "Lax", "None"].includes(cookie.sameSite)
      || (cookie.partitionKey !== undefined && !isXOrigin(cookie.partitionKey))) return invalidSession();
    return {
      name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
      expires: cookie.expires, httpOnly: cookie.httpOnly, secure: cookie.secure,
      sameSite: cookie.sameSite as SessionCookie["sameSite"],
      ...(typeof cookie.partitionKey === "string" ? { partitionKey: cookie.partitionKey } : {}),
    };
  });
  const origins = value.origins.map((entry: unknown) => {
    if (!isRecord(entry) || !isXOrigin(entry.origin) || !Array.isArray(entry.localStorage)) return invalidSession();
    return {
      origin: entry.origin,
      localStorage: entry.localStorage.map((item: unknown) => {
        if (!isRecord(item) || typeof item.name !== "string" || typeof item.value !== "string") return invalidSession();
        return { name: item.name, value: item.value };
      }),
    };
  });
  if (!cookies.some((cookie) => cookie.name === "auth_token" && cookie.value.trim()
    && (cookie.expires === -1 || cookie.expires > Date.now() / 1000))) return invalidSession();
  return { cookies, origins };
}

async function readSessionBody(request: Request): Promise<SessionState> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) {
    throw new SessionRequestError(415, "JSON_REQUIRED", "Un fichier JSON est requis.");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    throw new SessionRequestError(413, "SESSION_TOO_LARGE", "Le fichier de session dépasse la limite autorisée.");
  }
  const reader = request.body?.getReader();
  if (!reader) return invalidSession();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new SessionRequestError(413, "SESSION_TOO_LARGE", "Le fichier de session dépasse la limite autorisée.");
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } catch {
    return invalidSession();
  }
  return validateSession(value);
}

async function writeSession(filename: string, state: SessionState): Promise<void> {
  const directory = path.dirname(filename);
  const root = path.parse(directory).root;
  let current = root;
  // Check each ancestor rather than following a symlink outside the configured
  // storage directory. Only newly created directories and the leaf are private.
  for (const component of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const entry = await fs.lstat(current);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Unsafe session directory");
  }
  if (directory !== root) await fs.chmod(directory, 0o700);
  try {
    const entry = await fs.lstat(filename);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Unsafe session file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(directory, `.${path.basename(filename)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(state), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function POST(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;
  const configuredPath = process.env.X_BROWSER_SESSION_PATH?.trim();
  if (!configuredPath) return json({ success: false, code: "SESSION_PATH_NOT_CONFIGURED", detail: "X_BROWSER_SESSION_PATH doit être configuré." }, 503);
  try {
    const state = await readSessionBody(request);
    await writeSession(path.resolve(configuredPath), state);
    return json({ success: true, cookieCount: state.cookies.length });
  } catch (error) {
    if (error instanceof SessionRequestError) return json({ success: false, code: error.code, detail: error.message }, error.status);
    return json({ success: false, code: "SESSION_IMPORT_FAILED", detail: "La session n'a pas pu être enregistrée." }, 503);
  }
}

export async function GET(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;
  const handle = (process.env.X_ACCOUNT_HANDLE?.trim() || process.env.USER_HANDLE?.trim() || "").replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    return json({ success: false, ready: false, code: "ACCOUNT_NOT_CONFIGURED", detail: "X_ACCOUNT_HANDLE doit être configuré." }, 503);
  }
  let publisher: Awaited<ReturnType<typeof createBrowserPublisher>> | undefined;
  try {
    publisher = await createBrowserPublisher();
    return json({ success: true, ready: true, handle });
  } catch (error) {
    const failure = normalizeBrowserFailure(error).error;
    const status = failure.status && failure.status >= 400 && failure.status <= 599 ? failure.status : 503;
    return json({ success: false, ready: false, status, code: failure.code, detail: failure.detail }, status);
  } finally {
    await publisher?.close().catch(() => {});
  }
}
