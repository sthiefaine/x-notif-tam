import { createBrowserPublisher, getBrowserConfiguration, normalizeBrowserFailure } from "./browserClient";
import { getMissingXApiVariables, postToX, type XApiError } from "./xApiClient";

export type PublisherConfiguration = {
  mode: string;
  configured: boolean;
  missingVariables: string[];
  message: string;
};

// Aucun basculement automatique vers un service payant.
export function getPublisherConfiguration(): PublisherConfiguration {
  const mode = process.env.X_POSTING_MODE?.trim().toLowerCase() || "disabled";
  if (mode === "browser") {
    const configuration = getBrowserConfiguration();
    return {
      mode,
      ...configuration,
      message: configuration.configured
        ? "Publication par navigateur configurée"
        : "Une session de navigateur et X_ACCOUNT_HANDLE sont nécessaires. Exécuter npm run x:login en local.",
    };
  }
  if (mode === "api") {
    const missingVariables = getMissingXApiVariables();
    return {
      mode,
      configured: missingVariables.length === 0,
      missingVariables,
      message: missingVariables.length === 0
        ? "API X configurée"
        : `Identifiants X API manquants : ${missingVariables.join(", ")}`,
    };
  }
  return {
    mode,
    configured: false,
    missingVariables: ["X_POSTING_MODE"],
    message: mode === "disabled"
      ? "Publication désactivée. Choisir X_POSTING_MODE=browser ou api."
      : "X_POSTING_MODE doit valoir browser, api ou disabled.",
  };
}

export type PublicationResult =
  | { success: true; message: string; id: string }
  | { success: false; message: string; error: XApiError };

export function createTextPublisher(): {
  postText(text: string): Promise<PublicationResult>;
  close(): Promise<void>;
} {
  const configuration = getPublisherConfiguration();
  let browserPublisher: Awaited<ReturnType<typeof createBrowserPublisher>> | undefined;
  return {
    async postText(text) {
      if (!configuration.configured) {
        return {
          success: false,
          message: configuration.message,
          error: { status: 503, code: "POSTING_NOT_CONFIGURED", detail: configuration.message },
        };
      }
      if (configuration.mode === "api") return postToX(text);
      try {
        browserPublisher ??= await createBrowserPublisher();
        return await browserPublisher.postText(text);
      } catch (error) {
        return normalizeBrowserFailure(error);
      }
    },
    async close() {
      await browserPublisher?.close();
    },
  };
}
