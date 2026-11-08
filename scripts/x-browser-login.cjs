/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline/promises");
const { spawn: spawnChild } = require("node:child_process");

class LoginError extends Error {}

function findChromeExecutable(env, exists = existsSync) {
  return [
    env.CHROMIUM_EXECUTABLE_PATH?.trim(),
    env.PUPPETEER_EXECUTABLE_PATH?.trim(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].find((candidate) => candidate && exists(candidate));
}

function normalizeHandle(value) {
  const handle = (value || "").trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    throw new LoginError("Renseignez X_ACCOUNT_HANDLE avec le nom exact du compte X attendu.");
  }
  return handle.toLowerCase();
}

function isRestrictedUrl(value) {
  const url = new URL(value);
  return url.protocol !== "https:"
    || !["x.com", "www.x.com"].includes(url.hostname)
    || /^\/(?:i\/flow(?:\/|$)|i\/jf\/onboarding\/web(?:\/|$)|login(?:\/|$)|account\/(?:access|suspended|login_verification)(?:\/|$))/.test(url.pathname);
}

async function privateDirectory(directory) {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const entry = await fs.lstat(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory() || await fs.realpath(directory) !== directory) {
    throw new LoginError("Le profil dédié doit être un dossier local sans lien symbolique. Aucune session enregistrée.");
  }
  await fs.chmod(directory, 0o700);
}

async function hasProfileLock(directory) {
  try {
    await fs.lstat(path.join(directory, "SingletonLock"));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function prepareLoginProfile(projectDirectory) {
  const root = await fs.realpath(projectDirectory);
  const privateRoot = path.join(root, ".x-browser");
  const directory = path.join(privateRoot, "login-profile");
  await privateDirectory(privateRoot);
  await privateDirectory(directory);
  if (await hasProfileLock(directory)) {
    throw new LoginError("Le profil Chrome dédié est déjà ouvert ou verrouillé. Fermez ce Chrome manuellement puis relancez la commande.");
  }
  return directory;
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new LoginError(message)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function launchManualChrome(executablePath, profileDirectory, { spawn = spawnChild } = {}) {
  if (!executablePath) {
    throw new LoginError("Chrome est introuvable. Installez-le ou renseignez CHROMIUM_EXECUTABLE_PATH.");
  }
  let child;
  try {
    child = spawn(executablePath, [
      `--user-data-dir=${profileDirectory}`,
      "--no-first-run",
      "https://x.com/home",
    ], { stdio: "ignore" });
  } catch {
    throw new LoginError("Impossible d'ouvrir le Chrome dédié. Vérifiez son installation.");
  }
  const manual = { process: child, exited: false, result: null, terminationRequested: false };
  manual.completion = new Promise((resolve) => {
    const finish = (result) => {
      if (manual.exited) return;
      manual.exited = true;
      manual.result = result;
      resolve(result);
    };
    child.once("exit", (code, signal) => finish({ code, signal }));
    // This promise always resolves, including on errors, so no background
    // process event can produce an unhandled rejection while the user logs in.
    child.on("error", () => finish({ error: true }));
  });
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      child.removeListener("exit", onEarlyExit);
    };
    const onSpawn = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new LoginError("Impossible d'ouvrir le Chrome dédié. Vérifiez son installation.")); };
    const onEarlyExit = () => { cleanup(); reject(new LoginError("Le Chrome dédié s'est fermé avant son démarrage.")); };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("exit", onEarlyExit);
  });
  return manual;
}

function browserExitFailed(result, terminationRequested) {
  return result.error || (result.code !== 0 && !(terminationRequested && result.signal === "SIGTERM"));
}

async function waitForBrowserExit(manual, { timeoutMs = 10_000 } = {}) {
  if (!manual.exited) {
    try {
      // Only this child was launched by us with the dedicated profile. Never
      // read a PID from a lock file or target another Chrome process.
      manual.terminationRequested = manual.process.kill("SIGTERM");
    } catch {
      throw new LoginError("Fermez manuellement le Chrome dédié puis relancez la commande.");
    }
  }
  const result = await withTimeout(manual.completion, timeoutMs,
    "Le Chrome dédié ne s'est pas fermé à temps. Fermez-le manuellement puis relancez la commande.");
  if (browserExitFailed(result, manual.terminationRequested)) {
    throw new LoginError("Le Chrome dédié s'est arrêté avec une erreur. Aucune session enregistrée.");
  }
}

async function waitForProfileUnlock(directory, { timeoutMs = 5_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (await hasProfileLock(directory)) {
    if (Date.now() >= deadline) {
      throw new LoginError("Le profil Chrome dédié reste verrouillé. Fermez ce Chrome manuellement puis relancez la commande.");
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - Date.now()))));
  }
  // Recheck both directories before Playwright receives the profile.
  for (const candidate of [path.dirname(directory), directory]) {
    const entry = await fs.lstat(candidate);
    if (entry.isSymbolicLink() || !entry.isDirectory() || await fs.realpath(candidate) !== candidate) {
      throw new LoginError("Le profil dédié a changé. Aucune session enregistrée.");
    }
  }
}

async function verifyAccount(page, expectedHandle) {
  if (isRestrictedUrl(page.url())) {
    throw new LoginError("La connexion ou une vérification X reste en attente. Aucune session enregistrée.");
  }
  const challenges = page.locator(
    'iframe[src*="arkoselabs"], iframe[src*="captcha"], iframe[src*="funcaptcha"]'
  );
  if (await challenges.count() > 0) {
    throw new LoginError("X affiche une vérification. Terminez-la manuellement avant de recommencer.");
  }
  const profile = page.locator('a[data-testid="AppTabBar_Profile_Link"]').first();
  try {
    await profile.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    throw new LoginError("Impossible de vérifier le compte connecté. Aucune session enregistrée.");
  }
  const href = await profile.getAttribute("href");
  if (!href || isRestrictedUrl(page.url())) {
    throw new LoginError("Impossible de vérifier le compte connecté. Aucune session enregistrée.");
  }
  const profileUrl = new URL(href, "https://x.com");
  const profileHandle = profileUrl.pathname.replace(/^\/|\/$/g, "").toLowerCase();
  if (profileUrl.protocol !== "https:"
    || !["x.com", "www.x.com"].includes(profileUrl.hostname)
    || profileHandle !== expectedHandle) {
    throw new LoginError("Le compte connecté ne correspond pas à X_ACCOUNT_HANDLE. Aucune session enregistrée.");
  }
  if (await challenges.count() > 0) {
    throw new LoginError("X affiche une vérification. Aucune session enregistrée.");
  }
}

async function saveSessionFile(filename, state) {
  const directory = path.dirname(filename);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(state), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function scopeSessionToX(state) {
  const isXHost = (hostname) => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*x\.com$/i.test(hostname);
  return {
    cookies: (Array.isArray(state.cookies) ? state.cookies : []).filter((cookie) =>
      typeof cookie.domain === "string" && isXHost(cookie.domain.replace(/^\./, ""))
    ),
    origins: (Array.isArray(state.origins) ? state.origins : []).filter((entry) => {
      if (typeof entry.origin !== "string") return false;
      try {
        const origin = new URL(entry.origin);
        return origin.protocol === "https:" && !origin.port
          && origin.origin === entry.origin && isXHost(origin.hostname);
      } catch {
        return false;
      }
    }),
  };
}

async function waitForEnter({ signal } = {}) {
  if (!process.stdin.isTTY) {
    throw new LoginError("Lancez cette commande dans un terminal interactif pour confirmer la connexion manuelle.");
  }
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await terminal.question("Connectez-vous manuellement au compte attendu, puis appuyez sur Entrée ici pour enregistrer la session. ", { signal });
  } finally {
    terminal.close();
  }
}

async function runLogin({
  env = process.env,
  chromium,
  prompt = waitForEnter,
  output = (message) => console.log(message),
  saveSession = saveSessionFile,
  findExecutable = findChromeExecutable,
  prepareProfile = prepareLoginProfile,
  waitForUnlock = waitForProfileUnlock,
  spawn = spawnChild,
  projectDirectory = process.cwd(),
} = {}) {
  const expectedHandle = normalizeHandle(env.X_ACCOUNT_HANDLE?.trim() || env.USER_HANDLE);
  const filename = path.resolve(projectDirectory, env.X_BROWSER_SESSION_PATH?.trim() || ".x-browser/session.json");
  const executablePath = findExecutable(env);
  if (!executablePath) {
    throw new LoginError("Chrome est introuvable. Installez-le ou renseignez CHROMIUM_EXECUTABLE_PATH.");
  }
  const profileDirectory = await prepareProfile(projectDirectory);
  const manual = await launchManualChrome(executablePath, profileDirectory, { spawn });
  output("Le Chrome dédié est ouvert. Connectez-vous et validez les éventuels codes vous-même. Entrée fermera uniquement ce Chrome pour enregistrer la session.");
  const confirmation = new AbortController();
  try {
    await Promise.race([
      Promise.resolve().then(() => prompt({ signal: confirmation.signal })),
      manual.completion.then((result) => {
        if (browserExitFailed(result, false)) {
          throw new LoginError("Le Chrome dédié s'est arrêté avec une erreur. Aucune session enregistrée.");
        }
        // A normal manual quit still requires the terminal confirmation.
        return new Promise(() => {});
      }),
    ]);
  } catch (error) {
    // If the terminal confirmation fails, only close the dedicated child.
    // A browser crash has already been collected by its completion listener.
    await waitForBrowserExit(manual).catch(() => {});
    throw error;
  } finally {
    confirmation.abort();
  }
  await waitForBrowserExit(manual);
  await waitForUnlock(profileDirectory);
  const engine = chromium || require("playwright-core").chromium;
  const context = await engine.launchPersistentContext(profileDirectory, {
    executablePath,
    headless: false,
    timeout: 30_000,
  });
  try {
    // This profile belongs to the project; the user's personal profile is
    // never read, copied, or opened by either stage.
    const page = context.pages()[0] || await context.newPage();
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await verifyAccount(page, expectedHandle);
    // The dedicated browser may also have visited an email provider for a
    // verification code. Only X cookies and HTTPS X origins leave this machine.
    const state = scopeSessionToX(await context.storageState());
    const authenticated = state.cookies?.some((cookie) => cookie.name === "auth_token"
      && cookie.value
      && ["x.com", ".x.com"].includes(cookie.domain));
    if (!authenticated) {
      throw new LoginError("La session X est incomplète. Aucune session enregistrée.");
    }
    await saveSession(filename, state);
    output("Compte vérifié. Session enregistrée dans le fichier configuré, accessible uniquement à votre utilisateur.");
    return { filename, handle: expectedHandle };
  } finally {
    await withTimeout(context.close(), 10_000, "Fermez manuellement le Chrome dédié resté ouvert.");
  }
}

if (require.main === module) {
  runLogin().catch((error) => {
    console.error(error instanceof LoginError
      ? error.message
      : "Connexion non enregistrée. Vérifiez Chrome et la configuration, puis recommencez.");
    process.exitCode = 1;
  });
}

module.exports = {
  LoginError, normalizeHandle, findChromeExecutable, isRestrictedUrl,
  prepareLoginProfile, launchManualChrome, waitForBrowserExit, waitForProfileUnlock,
  verifyAccount, saveSessionFile, scopeSessionToX, runLogin,
};
