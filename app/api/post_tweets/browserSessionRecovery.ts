import {
  constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync,
  openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { BrowserContext } from "playwright-core";

export type BrowserStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
export class SessionRecoveryError extends Error {
  constructor(readonly code: string, message: string, readonly status = 503) {
    super(message);
    this.name = "SessionRecoveryError";
  }
}

const storageError = (): never => {
  throw new SessionRecoveryError("UNSAFE_SESSION_STORAGE", "Le stockage de session doit être privé, appartenir à l'application et être sans lien symbolique.");
};
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function checkPrivateFile(filename: string) {
  const stat = lstatSync(filename);
  const uid = process.getuid?.();
  if (uid === undefined || stat.uid !== uid || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
    return storageError();
  }
  return stat;
}

function checkStorage(filename: string) {
  const parent = path.dirname(filename);
  let directory = parent;
  for (;;) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) storageError();
    if (directory === parent && (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)) storageError();
    const above = path.dirname(directory);
    if (above === directory) break;
    directory = above;
  }
  return checkPrivateFile(filename);
}

export type SessionSnapshot = {
  filename: string;
  fingerprint: string;
  state: BrowserStorageState;
};

export function readSessionSnapshot(configuredPath: string): SessionSnapshot {
  const filename = path.resolve(configuredPath);
  const before = checkStorage(filename);
  const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino) storageError();
    const raw = readFileSync(descriptor);
    let state: BrowserStorageState;
    try {
      state = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new SessionRecoveryError("INVALID_SESSION_STORAGE", "Le fichier de session X est invalide.");
    }
    if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
      throw new SessionRecoveryError("INVALID_SESSION_STORAGE", "Le fichier de session X est invalide.");
    }
    return { filename, fingerprint: digest(raw), state };
  } finally {
    closeSync(descriptor);
  }
}

function assertUnchanged(snapshot: SessionSnapshot) {
  const current = readSessionSnapshot(snapshot.filename);
  if (current.fingerprint !== snapshot.fingerprint) {
    throw new SessionRecoveryError("SESSION_CHANGED", "La session a changé ; aucune reconnexion n'a été tentée.", 409);
  }
}

/** Le marqueur reste présent après succès, refus ou crash : jamais de second essai du même fichier. */
export function claimSessionRecovery(snapshot: SessionSnapshot, checkActive: () => void): void {
  checkActive();
  assertUnchanged(snapshot);
  const name = `.x-login-attempt-${digest(path.basename(snapshot.filename)).slice(0, 12)}-${snapshot.fingerprint}.json`;
  const marker = path.join(path.dirname(snapshot.filename), name);
  let descriptor: number;
  try {
    descriptor = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      checkPrivateFile(marker);
      throw new SessionRecoveryError("SESSION_RECOVERY_USED", "La tentative unique de reconnexion pour cette session a déjà été utilisée. Une connexion manuelle est nécessaire.", 401);
    }
    storageError();
  }
  try {
    fchmodSync(descriptor!, 0o600);
    writeFileSync(descriptor!, JSON.stringify({ version: 1, attemptedAt: new Date().toISOString() }));
    fsyncSync(descriptor!);
    checkActive();
  } finally {
    closeSync(descriptor!);
  }
}

export function scopeRecoveredSession(state: BrowserStorageState): BrowserStorageState {
  const isXHost = (hostname: string) => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*x\.com$/i.test(hostname);
  return {
    cookies: state.cookies.filter((cookie) => typeof cookie.domain === "string" && isXHost(cookie.domain.replace(/^\./, ""))),
    origins: state.origins.filter((entry) => {
      try {
        const url = new URL(entry.origin);
        return url.protocol === "https:" && !url.port && url.origin === entry.origin && isXHost(url.hostname);
      } catch { return false; }
    }),
  };
}

export function hasValidXAuthentication(state: BrowserStorageState): boolean {
  return state.cookies.some((cookie) => cookie.name === "auth_token" && Boolean(cookie.value)
    && ["x.com", ".x.com"].includes(cookie.domain)
    && (cookie.expires === -1 || cookie.expires > Date.now() / 1000));
}

/** Écritures synchrones et vérification du budget avant rename : aucun commit différé après timeout. */
export function saveRecoveredSession(snapshot: SessionSnapshot, state: BrowserStorageState, checkActive: () => void): void {
  checkActive();
  assertUnchanged(snapshot);
  const scoped = scopeRecoveredSession(state);
  if (!hasValidXAuthentication(scoped)) {
    throw new SessionRecoveryError("SESSION_REQUIRED", "La reconnexion n'a pas produit de session X valide.", 401);
  }
  const temporary = path.join(path.dirname(snapshot.filename), `.x-session-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    checkActive();
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, JSON.stringify(scoped));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    assertUnchanged(snapshot);
    checkActive();
    renameSync(temporary, snapshot.filename);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
