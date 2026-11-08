import { TwitterApi } from "twitter-api-v2";

/**
 * Client X (Twitter) basé sur l'API officielle v2.
 *
 * Remplace l'ancienne approche Puppeteer (scraping du formulaire de login),
 * qui déclenchait les protections anti-bot de X (Arkose/FunCaptcha) depuis
 * une IP datacenter et limitait le login du compte.
 *
 * Identifiants à créer sur https://developer.x.com :
 *   1. Créer un Projet + App, permissions "Read and write".
 *   2. Onglet "Keys and tokens" -> générer :
 *      - API Key / API Key Secret      => X_API_KEY / X_API_SECRET
 *      - Access Token / Access Secret  => X_ACCESS_TOKEN / X_ACCESS_SECRET
 *        (l'access token doit être généré APRÈS avoir activé "Read and write")
 */
const credentialNames = [
  "X_API_KEY",
  "X_API_SECRET",
  "X_ACCESS_TOKEN",
  "X_ACCESS_SECRET",
] as const;

export const getMissingXApiVariables = (): string[] =>
  credentialNames.filter((name) => !process.env[name]?.trim());

/** True si les 4 identifiants OAuth 1.0a sont présents. */
export const isXApiConfigured = (): boolean =>
  getMissingXApiVariables().length === 0;

let client: TwitterApi | null = null;

const getClient = (): TwitterApi => {
  if (!isXApiConfigured()) {
    throw new Error(
      "Identifiants X API manquants : X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET"
    );
  }
  if (!client) {
    client = new TwitterApi({
      appKey: process.env.X_API_KEY!.trim(),
      appSecret: process.env.X_API_SECRET!.trim(),
      accessToken: process.env.X_ACCESS_TOKEN!.trim(),
      accessSecret: process.env.X_ACCESS_SECRET!.trim(),
    });
  }
  return client;
};

export type XApiError = {
  status?: number;
  code?: number | string;
  detail: string;
  retryAfter?: number;
  uncertain?: boolean;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

// Ne jamais exposer l'objet d'erreur complet : il peut contenir la requête OAuth.
const safeText = (value: string): string => {
  let text = value;
  for (const name of [...credentialNames, "CRON_SECRET", "DATABASE_URL"]) {
    const secret = process.env[name]?.trim();
    if (secret) text = text.split(secret).join("[masqué]");
  }
  return text
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [masqué]")
    .replace(/oauth_[a-z_]+\s*=\s*"[^"]*"/gi, "oauth_[masqué]")
    .slice(0, 1000);
};

export const getXApiError = (error: unknown): XApiError => {
  const record = asRecord(error);
  const data = asRecord(record.data);
  const firstError = asRecord(Array.isArray(data.errors) ? data.errors[0] : null);
  const httpStatus = record.status ?? record.statusCode ?? record.code;
  const status =
    typeof httpStatus === "number" && httpStatus >= 400 && httpStatus <= 599
      ? httpStatus
      : undefined;
  const apiCode = firstError.code ?? data.code;
  const code =
    typeof apiCode === "number" || typeof apiCode === "string"
      ? typeof apiCode === "string" ? safeText(apiCode) : apiCode
      : undefined;
  const detail = [data.detail, firstError.message, data.title, record.message].find(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  const rateLimit = asRecord(record.rateLimit);
  const reset = rateLimit.reset;
  const retryAfter =
    status === 429 && typeof reset === "number"
      ? Math.max(1, Math.ceil(reset - Date.now() / 1000))
      : undefined;
  return {
    status,
    code,
    detail: safeText(detail ?? "La requête vers X a échoué."),
    retryAfter,
  };
};

/**
 * Publie un post sur X via POST /2/tweets.
 * @param text Contenu du post (max 280 caractères)
 */
export const postToX = async (
  text: string
): Promise<
  | { success: true; message: string; id: string }
  | { success: false; message: string; error: XApiError }
> => {
  let invocationStarted = false;
  try {
    const writeClient = getClient().v2;
    const publish = writeClient.tweet.bind(writeClient);
    invocationStarted = true;
    const res = await publish(text);
    if (typeof res.data?.id !== "string" || !res.data.id.trim()) {
      throw new Error("X n'a pas renvoyé d'identifiant de publication.");
    }
    return { success: true, message: "Tweet publié", id: res.data.id };
  } catch (error) {
    const details = getXApiError(error);
    // Sans réponse exploitable, X peut avoir accepté le post avant la panne.
    // Seul un refus HTTP 4xx explicite permet de libérer le reçu pré-envoi.
    details.uncertain = invocationStarted && !(details.status !== undefined && details.status >= 400 && details.status < 500);
    console.error("Erreur API X lors de la publication:", details);
    return { success: false, message: details.detail, error: details };
  }
};
