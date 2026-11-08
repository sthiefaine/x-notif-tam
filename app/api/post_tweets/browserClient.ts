import { accessSync, constants, statSync } from "node:fs";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page, Response } from "playwright-core";
import type { XApiError } from "./xApiClient";

const RUN_TIMEOUT = 30_000;
const CLOSE_TIMEOUT = 2_000;
const executableCandidates = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

const accessibleFile = (path: string | undefined, mode: number): boolean => {
  if (!path) return false;
  try {
    return statSync(path).isFile() && (accessSync(path, mode), true);
  } catch {
    return false;
  }
};

const getExecutablePath = (): string | undefined => {
  const configured = process.env.CHROMIUM_EXECUTABLE_PATH?.trim();
  if (configured) {
    return accessibleFile(configured, constants.X_OK) ? configured : undefined;
  }
  const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH?.trim(), ...executableCandidates];
  return candidates.find((path) => accessibleFile(path, constants.X_OK));
};

const getAccountHandle = (): string =>
  (process.env.X_ACCOUNT_HANDLE?.trim() || process.env.USER_HANDLE?.trim() || "").replace(/^@/, "");

export const getBrowserConfiguration = (): {
  configured: boolean;
  missingVariables: string[];
} => {
  const missingVariables: string[] = [];
  if (!accessibleFile(process.env.X_BROWSER_SESSION_PATH?.trim(), constants.R_OK)) {
    missingVariables.push("X_BROWSER_SESSION_PATH");
  }
  if (!/^[A-Za-z0-9_]{1,15}$/.test(getAccountHandle())) {
    missingVariables.push("X_ACCOUNT_HANDLE");
  }
  if (!getExecutablePath()) missingVariables.push("CHROMIUM_EXECUTABLE_PATH");
  return { configured: missingVariables.length === 0, missingVariables };
};

class BrowserPublicationError extends Error {
  constructor(readonly details: XApiError) {
    super(details.detail);
    this.name = "BrowserPublicationError";
  }
}

const fail = (status: number, code: string, detail: string): never => {
  throw new BrowserPublicationError({ status, code, detail });
};

const assertSession = async (page: Page): Promise<void> => {
  const path = new URL(page.url()).pathname;
  if (/^\/(?:i\/flow\/login|i\/jf\/onboarding\/web|login)(?:\/|$)/i.test(path)) {
    fail(401, "SESSION_REQUIRED", "La session X doit être renouvelée manuellement.");
  }
  const challenge = page.locator(
    'iframe[src*="arkoselabs"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[title*="challenge" i]'
  );
  if (
    /^\/(?:i\/flow\/|account\/(?:access|suspended|login_verification))/i.test(path) ||
    await challenge.count() > 0
  ) {
    fail(403, "ACCOUNT_CHALLENGE", "X demande une vérification manuelle du compte.");
  }
  if (await page.locator('input[name="password"], input[autocomplete="username"]').count() > 0) {
    fail(401, "SESSION_REQUIRED", "La session X doit être renouvelée manuellement.");
  }
};

const assertAccount = async (page: Page): Promise<void> => {
  const expected = getAccountHandle().toLowerCase();
  const switcher = page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').first();
  if (await switcher.count() > 0) {
    const text = await switcher.innerText({ timeout: 5_000 });
    const handles = text.match(/@[A-Za-z0-9_]{1,15}\b/g) ?? [];
    if (handles.length > 0) {
      if (handles.length !== 1 || handles[0].slice(1).toLowerCase() !== expected) {
        fail(409, "ACCOUNT_MISMATCH", "La session ouverte appartient à un autre compte X.");
      }
      return;
    }
  }

  const profile = page.locator('a[data-testid="AppTabBar_Profile_Link"]').first();
  const href = await profile.getAttribute("href", { timeout: 5_000 });
  if (href) {
    const url = new URL(href, "https://x.com");
    if (url.hostname === "x.com" && url.pathname.replace(/\/$/, "").toLowerCase() === `/${expected}`) {
      return;
    }
    fail(409, "ACCOUNT_MISMATCH", "La session ouverte appartient à un autre compte X.");
  }
  fail(409, "ACCOUNT_UNVERIFIED", "Impossible de confirmer le compte X ouvert.");
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : {};

const getConfirmedTweetId = async (response: Response): Promise<string> => {
  const status = response.status();
  if (status === 401) {
    fail(401, "SESSION_REQUIRED", "La session X doit être renouvelée manuellement.");
  }
  if (status === 403) {
    fail(403, "ACCOUNT_CHALLENGE", "X refuse la publication ; vérifiez le compte manuellement.");
  }
  if (status === 429) {
    const headers = response.headers();
    const seconds = Number(headers["retry-after"]);
    const reset = Number(headers["x-rate-limit-reset"]);
    const retryAfter = Number.isFinite(seconds) && seconds > 0
      ? Math.ceil(seconds)
      : Number.isFinite(reset) && reset > 0 ? Math.max(1, Math.ceil(reset - Date.now() / 1000)) : undefined;
    throw new BrowserPublicationError({
      status: 429,
      code: "BROWSER_RATE_LIMIT",
      detail: "X limite temporairement les publications.",
      retryAfter,
    });
  }
  if (!response.ok()) {
    fail(502, "BROWSER_POST_FAILED", "X n'a pas confirmé la publication.");
  }

  const body = asRecord(await response.json());
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const code = asRecord(body.errors[0]).code;
    if ([64, 226, 326].includes(Number(code))) {
      fail(403, "ACCOUNT_CHALLENGE", "X demande une vérification manuelle avant publication.");
    }
    throw new BrowserPublicationError({
      status: 502,
      code: typeof code === "number" ? code : "BROWSER_POST_REJECTED",
      detail: "X a refusé la publication.",
    });
  }
  const result = asRecord(asRecord(asRecord(asRecord(body.data).create_tweet).tweet_results).result);
  const id = result.rest_id ?? asRecord(result.tweet).rest_id;
  if (typeof id !== "string" || !/^\d{1,30}$/.test(id)) {
    return fail(502, "PUBLICATION_UNCONFIRMED", "X n'a pas renvoyé d'identifiant de publication valide.");
  }
  return id;
};

const closeSafely = async (resource: Browser | BrowserContext | undefined): Promise<void> => {
  if (!resource) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      resource.close(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, CLOSE_TIMEOUT); }),
    ]);
  } catch {
    // Ne pas exposer d'erreur contenant la session ou des détails du navigateur.
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export type BrowserPostResult =
  | { success: true; message: string; id: string }
  | { success: false; message: string; error: XApiError };

export const normalizeBrowserFailure = (failure: unknown): Extract<BrowserPostResult, { success: false }> => {
  const error: XApiError = failure instanceof BrowserPublicationError
    ? failure.details
    : {
      status: failure instanceof Error && failure.name === "TimeoutError" ? 504 : 503,
      code: failure instanceof Error && failure.name === "TimeoutError" ? "BROWSER_TIMEOUT" : "BROWSER_FAILED",
      detail: "Le navigateur n'a pas confirmé la publication ; vérifiez le compte avant de réessayer.",
    };
  return { success: false, message: error.detail, error };
};

const withDeadline = async <T>(operation: Promise<T>, timeout: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BrowserPublicationError({
          status: 504,
          code: "BROWSER_TIMEOUT",
          detail: "Publication non confirmée à temps ; vérifiez le compte avant de réessayer.",
        })), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** Une seule session navigateur pour un lot ; aucune connexion automatique. */
export const createBrowserPublisher = async (): Promise<{
  postText: (text: string) => Promise<BrowserPostResult>;
  close: () => Promise<void>;
}> => {
  const configuration = getBrowserConfiguration();
  if (!configuration.configured) {
    fail(503, "BROWSER_NOT_CONFIGURED",
      `Configuration navigateur manquante ou inaccessible : ${configuration.missingVariables.join(", ")}.`);
  }

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page;
  let closed = false;
  let busy = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await closeSafely(context);
    await closeSafely(browser);
  };
  const ensureOpen = async () => {
    if (!closed) return;
    // Une création tardive après expiration doit aussi fermer ses ressources.
    await closeSafely(context);
    await closeSafely(browser);
    fail(503, "BROWSER_CLOSED", "La session de publication a été fermée.");
  };

  try {
    await withDeadline((async () => {
      browser = await chromium.launch({
        executablePath: getExecutablePath(), headless: true, timeout: 10_000,
      });
      await ensureOpen();
      context = await browser.newContext({ storageState: process.env.X_BROWSER_SESSION_PATH!.trim() });
      await ensureOpen();
      context.setDefaultTimeout(8_000);
      page = await context.newPage();
      await ensureOpen();
      await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 15_000 });
      await ensureOpen();
      await assertSession(page);
      await page.locator('[data-testid="SideNav_AccountSwitcher_Button"], a[data-testid="AppTabBar_Profile_Link"]')
        .first().waitFor({ state: "visible", timeout: 8_000 });
      await assertAccount(page);
      await ensureOpen();
    })(), 20_000);
  } catch (failure) {
    await close();
    throw new BrowserPublicationError(normalizeBrowserFailure(failure).error);
  }

  return {
    close,
    postText: async (text: string): Promise<BrowserPostResult> => {
      if (closed) {
        return normalizeBrowserFailure(new BrowserPublicationError({
          status: 503, code: "BROWSER_CLOSED", detail: "La session de publication a été fermée.",
        }));
      }
      if (busy) {
        return normalizeBrowserFailure(new BrowserPublicationError({
          status: 409, code: "BROWSER_BUSY", detail: "Une publication est déjà en cours dans cette session.",
        }));
      }
      if (!text.trim()) {
        return normalizeBrowserFailure(new BrowserPublicationError({
          status: 400, code: "EMPTY_TWEET", detail: "La publication est vide.",
        }));
      }
      busy = true;
      let submissionStarted = false;
      try {
        return await withDeadline((async () => {
          await assertSession(page);
          await assertAccount(page);
          await ensureOpen();
          await page.locator('[data-testid="tweetTextarea_0"]').first().fill(text);
          await assertSession(page);
          await ensureOpen();

          // Attendre la confirmation réseau, jamais déduire le succès du clic.
          const confirmation = page.waitForResponse((response) => {
            const url = new URL(response.url());
            return ["x.com", "api.x.com"].includes(url.hostname) &&
              /\/graphql\/[^/]+\/CreateTweet$/.test(url.pathname) &&
              response.request().method() === "POST";
          }, { timeout: 15_000 });
          // Évite un rejet non géré si le clic échoue avant l'attente ci-dessous.
          void confirmation.catch(() => undefined);
          submissionStarted = true;
          await page.locator('[data-testid="tweetButtonInline"]').first().click({ timeout: 5_000 });
          const id = await getConfirmedTweetId(await confirmation);
          return { success: true as const, message: "Tweet publié via le navigateur", id };
        })(), RUN_TIMEOUT);
      } catch (failure) {
        await close();
        const result = normalizeBrowserFailure(failure);
        const explicitRefusal = typeof result.error.code === "number" || [
          "SESSION_REQUIRED", "ACCOUNT_CHALLENGE", "BROWSER_RATE_LIMIT", "BROWSER_POST_REJECTED",
        ].includes(String(result.error.code));
        if (submissionStarted && !explicitRefusal) result.error.uncertain = true;
        return result;
      } finally {
        busy = false;
      }
    },
  };
};

/** Compatibilité pour une publication isolée ; le traitement par lot réutilise la factory. */
export const postToBrowser = async (text: string): Promise<BrowserPostResult> => {
  let publisher: Awaited<ReturnType<typeof createBrowserPublisher>> | undefined;
  try {
    publisher = await createBrowserPublisher();
    return await publisher.postText(text);
  } catch (failure) {
    return normalizeBrowserFailure(failure);
  } finally {
    await publisher?.close();
  }
};
