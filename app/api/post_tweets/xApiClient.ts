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
const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } =
  process.env;

/** True si les 4 identifiants OAuth 1.0a sont présents. */
export const isXApiConfigured = (): boolean =>
  Boolean(X_API_KEY && X_API_SECRET && X_ACCESS_TOKEN && X_ACCESS_SECRET);

let client: TwitterApi | null = null;

const getClient = (): TwitterApi => {
  if (!isXApiConfigured()) {
    throw new Error(
      "Identifiants X API manquants : X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET"
    );
  }
  if (!client) {
    client = new TwitterApi({
      appKey: X_API_KEY as string,
      appSecret: X_API_SECRET as string,
      accessToken: X_ACCESS_TOKEN as string,
      accessSecret: X_ACCESS_SECRET as string,
    });
  }
  return client;
};

/**
 * Publie un post sur X via POST /2/tweets.
 * @param text Contenu du post (max 280 caractères)
 */
export const postToX = async (
  text: string
): Promise<{ success: boolean; message: string; id?: string }> => {
  try {
    const res = await getClient().v2.tweet(text);
    return { success: true, message: "Tweet publié", id: res.data?.id };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : JSON.stringify(error);
    console.error("Erreur API X lors de la publication:", message);
    return { success: false, message };
  }
};
