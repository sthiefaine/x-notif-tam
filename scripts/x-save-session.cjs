/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  LoginError,
  prepareLoginProfile,
  findChromeExecutable,
  normalizeHandle,
  verifyAccount,
  scopeSessionToX,
  saveSessionFile,
} = require("./x-browser-login.cjs");

async function requireExistingProfile(projectDirectory) {
  const root = await fs.realpath(projectDirectory);
  const profile = path.join(root, ".x-browser", "login-profile");
  for (const directory of [path.dirname(profile), profile, path.join(profile, "Default")]) {
    try {
      const entry = await fs.lstat(directory);
      if (entry.isSymbolicLink() || !entry.isDirectory() || await fs.realpath(directory) !== directory) {
        throw new LoginError("Le profil dédié doit être un dossier local existant, sans lien symbolique. Aucune session enregistrée.");
      }
    } catch (error) {
      if (error instanceof LoginError) throw error;
      throw new LoginError("Le profil Chrome dédié est introuvable ou incomplet. Aucune session enregistrée.");
    }
  }
  return { root, profile };
}

async function closeContext(context, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      context.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new LoginError("Le Chrome dédié ne s'est pas fermé à temps. Fermez-le manuellement.")), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof LoginError) throw error;
    throw new LoginError("Le Chrome dédié n'a pas pu se fermer correctement. Fermez-le manuellement.");
  } finally {
    clearTimeout(timer);
  }
}

async function runSaveSession({
  env = process.env,
  chromium,
  projectDirectory = process.cwd(),
  prepareProfile = prepareLoginProfile,
  findExecutable = findChromeExecutable,
  saveSession = saveSessionFile,
  output = (message) => console.log(message),
  closeTimeoutMs = 10_000,
} = {}) {
  const expectedHandle = normalizeHandle(env.X_ACCOUNT_HANDLE?.trim() || env.USER_HANDLE);
  const { root, profile } = await requireExistingProfile(projectDirectory);
  const preparedProfile = await prepareProfile(root);
  if (preparedProfile !== profile) {
    throw new LoginError("Seul le profil Chrome dédié à ce projet peut être utilisé. Aucune session enregistrée.");
  }
  // Recheck the fixed existing directories after lock/symlink verification.
  await requireExistingProfile(root);
  const executablePath = findExecutable(env);
  if (!executablePath) {
    throw new LoginError("Chrome est introuvable. Installez-le ou renseignez CHROMIUM_EXECUTABLE_PATH.");
  }
  const filename = path.resolve(root, env.X_BROWSER_SESSION_PATH?.trim() || ".x-browser/session.json");
  const engine = chromium || require("playwright-core").chromium;
  const context = await engine.launchPersistentContext(profile, {
    executablePath,
    headless: false,
    timeout: 30_000,
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await verifyAccount(page, expectedHandle);
    const state = scopeSessionToX(await context.storageState());
    if (!state.cookies.some((cookie) => cookie.name === "auth_token"
      && cookie.value && ["x.com", ".x.com"].includes(cookie.domain))) {
      throw new LoginError("Le profil dédié n'a pas de session X complète. Aucune session enregistrée.");
    }
    await saveSession(filename, state);
    output("Compte vérifié. Session X enregistrée depuis le profil dédié, sans nouvelle connexion.");
    return { filename, handle: expectedHandle };
  } finally {
    await closeContext(context, closeTimeoutMs);
  }
}

if (require.main === module) {
  runSaveSession().catch((error) => {
    console.error(error instanceof LoginError
      ? error.message
      : "Session non enregistrée. Vérifiez Chrome et le profil dédié, puis recommencez.");
    process.exitCode = 1;
  });
}

module.exports = { requireExistingProfile, runSaveSession };
