export const maxDuration = 300;
import puppeteer, { KnownDevices, Browser, Page } from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";
import { prisma } from "@/lib/prisma";
import { Alert } from "@prisma/client";

// Configuration
const localExecutablePath =
  process.platform === "win32"
    ? "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    : process.platform === "linux"
    ? "/usr/bin/google-chrome"
    : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const remoteExecutablePath =
  "https://github.com/Sparticuz/chromium/releases/download/v119.0.2/chromium-v119.0.2-pack.tar";

const isDev = process.env.NODE_ENV === "development";
const urlLogin = "https://x.com/i/flow/login";
const deviceName = "iPhone 11 Pro Max";
const device = KnownDevices[deviceName];
let browser: Browser | null = null;

// Vérification des variables d'environnement
if (!process.env.USER_EMAIL || !process.env.USER_PASSWORD) {
  throw new Error(
    "USER_EMAIL and USER_PASSWORD environment variables must be set"
  );
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lance le navigateur Puppeteer
 * @returns {Promise<Browser>} Instance du navigateur
 */
export const launchBrowser = async (): Promise<Browser> => {
  console.log("Launching browser");
  return await puppeteer.launch({
    args: isDev ? [] : chromium.args,
    executablePath: isDev
      ? localExecutablePath
      : await chromium.executablePath(remoteExecutablePath),
    headless: isDev ? false : chromium.headless,
  });
};

/**
 * Configure une page Puppeteer pour Twitter
 * @param page La page à configurer
 * @returns {Promise<Page>} La page configurée
 */
export const configurePage = async (page: Page): Promise<Page> => {
  console.log("Configuring page");
  const userAgent =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0.6422.80 Mobile/15E148 Safari/604.1";
  await page.setUserAgent(userAgent);
  await page.emulate(device);
  return page;
};

/**
 * Vérifie si l'utilisateur est déjà connecté
 * @param page La page Puppeteer
 * @returns {Promise<boolean>} True si connecté, false sinon
 */
export const checkExistingLogin = async (page: Page): Promise<boolean> => {
  console.log("Checking existing login");
  try {
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
    const currentUrl = page.url();
    const isLoggedIn = currentUrl === "https://x.com/home";

    // Si connecté, aller directement à la page de composition
    if (isLoggedIn) {
      console.log("Already logged in, redirecting to compose tweet page");
      await goToComposeTweet(page);
    }

    return isLoggedIn;
  } catch (error) {
    console.error("Error checking login:", error);
    return false;
  }
};

/**
 * Navigue vers la page de composition de tweet
 * @param page La page Puppeteer
 * @returns {Promise<boolean>} True si la navigation a réussi
 */
export const goToComposeTweet = async (page: Page): Promise<boolean> => {
  console.log("Navigating to compose tweet page");
  try {
    await page.goto("https://x.com/compose/post", {
      waitUntil: "domcontentloaded",
      timeout: 2000,
    });
    console.log("Compose tweet page loaded");
    return true;
  } catch (error) {
    console.error("Error navigating to compose tweet page:", error);
    return false;
  }
};

/**
 * Effectue le processus de connexion
 * @param page La page Puppeteer
 * @returns {Promise<string>} Message de réussite ou d'échec
 */
export const performLogin = async (page: Page): Promise<string> => {
  console.log("Performing login");
  try {
    // Attendre que la page soit stable
    await page.waitForNetworkIdle({ idleTime: 1000 });

    // Saisir l'email
    const usernameSelector =
      'input[name="text"], input[autocomplete="username"]';
    await page.waitForSelector(usernameSelector, { timeout: 6000 });

    const usernameInput = await page.$(usernameSelector);
    if (!usernameInput) throw new Error("Username input field not found");
    await usernameInput.type(process.env.USER_EMAIL || "", { delay: 50 });

    // Cliquer sur "Suivant"
    await page.evaluate(() =>
      (document.querySelector("button:nth-child(6)") as HTMLElement).click()
    );
    console.log("Username submitted");

    // Vérifier si une étape supplémentaire est nécessaire
    await page.waitForNetworkIdle({ idleTime: 1000 });
    const pageText = await page.$eval("*", (el) => el.textContent);
    if (
      pageText &&
      (pageText.includes("username") || pageText.includes("utilisateur"))
    ) {
      console.log("Additional verification required");
      await page.waitForSelector('input[name="text"]', { timeout: 6000 });
      const verificationInput = await page.$('input[name="text"]');
      if (!verificationInput)
        throw new Error("Verification input field not found");
      await verificationInput.type(process.env.USER_HANDLE || "", {
        delay: 50,
      });
      await page.keyboard.press("Enter");
      await wait(500);
    }

    // Saisir le mot de passe
    const passwordSelector =
      'input[name="password"], input[autocomplete="current-password"]';
    await page.waitForSelector(passwordSelector, { timeout: 6000 });

    const passwordInput = await page.$(passwordSelector);
    if (!passwordInput) throw new Error("Password input field not found");
    await passwordInput.type(process.env.USER_PASSWORD || "", { delay: 10 });
    await page.keyboard.press("Enter");
    console.log("Password submitted");

    // Attendre la fin de la connexion
    await page.waitForNetworkIdle({ idleTime: 1000 });

    // Vérifier si connecté
    const currentUrl = page.url();
    console.log("Current URL after login:", currentUrl);
    if (currentUrl === "https://x.com/home") {
      console.log("Login successful");

      // Aller directement à la page de composition de tweet
      await goToComposeTweet(page);

      return "Login successful";
    } else {
      console.log("Login failed, not on home page");
      return "Login failed";
    }
  } catch (error) {
    console.error("Error during login:", error);
    return `Login failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
};

/**
 * Fonction de navigation vers la page de connexion
 * @param page La page Puppeteer
 * @returns {Promise<string>} Message de réussite ou d'échec
 */
export const goToLogin = async (page: Page): Promise<string> => {
  console.log("Navigating to login page");
  try {
    const response = await page.goto(urlLogin, {
      waitUntil: "domcontentloaded",
      timeout: 50000,
    });
    if (response && response.status() !== 200) {
      throw new Error(`Failed to load login page: ${response.status()}`);
    }
    console.log("Login page loaded successfully");
    return await performLogin(page);
  } catch (error) {
    console.error("Error navigating to login page:", error);
    return `Failed to navigate to login page: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
};

/**
 * Entre le contenu du tweet dans la page
 * @param page La page Puppeteer
 * @param content Le contenu du tweet
 * @returns {Promise<boolean>} True si réussi, false sinon
 */
export const enterTweetContent = async (
  page: Page,
  content: string
): Promise<boolean> => {
  console.log("Entering tweet content");

  try {
    // Essayer différentes méthodes pour entrer le texte
    const selector = [
      'textarea[autocapitalize="sentences"][autocomplete="on"][data-testid="tweetTextarea_0"]',
    ];

      try {
        await page.waitForSelector(selector[0], {
          visible: true,
          timeout: 0,
        });
        console.log(`Found tweet input with selector: ${selector}`);

        if (selector.includes("RichTextInputContainer")) {
          // Utiliser l'injection JavaScript pour le container rich text
          await page.evaluate((text: string) => {
            const container = document.querySelector(
              'div[data-testid="tweetTextarea_0RichTextInputContainer"]'
            );
            if (container) {
              const editableDiv = container.querySelector(
                '[contenteditable="true"]'
              );
              if (editableDiv) {
                editableDiv.textContent = text;
                editableDiv.dispatchEvent(
                  new Event("input", { bubbles: true })
                );
              }
            }
          }, content);
        } else {
          // Utiliser la frappe directe
          await page.click(selector[0]);
          await page.keyboard.type(content);
        }

        console.log("Tweet content entered successfully");
        return true;
      } catch (error) {
        console.log(`Failed with selector ${selector}, trying next one`);
      }
    

    console.error("Failed to enter tweet content with any selector");
    return false;
  } catch (error) {
    console.error("Error entering tweet content:", error);
    return false;
  }
};

/**
 * Soumet le tweet en cliquant sur le bouton
 * @param page La page Puppeteer
 * @returns {Promise<boolean>} True si réussi, false sinon
 */
export const submitTweet = async (page: Page): Promise<boolean> => {
  console.log("Submitting tweet");
  try {
    // Essayer différents sélecteurs pour le bouton de tweet
    const buttonSelectors = [
      'div[data-testid="tweetButton"]',
      'button[data-testid="tweetButton"]',
      'div[data-testid="tweetButtonInline"]',
    ];

    for (const selector of buttonSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });

        // Vérifier si le bouton est désactivé
        const isDisabled = await page.evaluate((sel) => {
          const button = document.querySelector(sel);
          return button
            ? button.hasAttribute("disabled") ||
                button.getAttribute("aria-disabled") === "true"
            : true;
        }, selector);

        if (!isDisabled) {
          await page.click(selector);
          console.log(`Clicked tweet button with selector: ${selector}`);

          // Attendre que le tweet soit posté
          try {
            await page.waitForNavigation({ timeout: 500 });
          } catch (error) {
            // Timeout de navigation pas critique - Twitter peut ne pas naviguer après l'envoi
            console.log(
              "Navigation timeout after posting tweet, but this might be normal"
            );
          }

          console.log("Tweet submitted successfully");
          return true;
        } else {
          console.log(`Button ${selector} is disabled`);
        }
      } catch (error) {
        console.log(`Failed with selector ${selector}, trying next one`);
      }
    }

    console.error("Failed to submit tweet with any button selector");
    return false;
  } catch (error) {
    console.error("Error submitting tweet:", error);
    return false;
  }
};

/**
 * Se connecte à Twitter, réutilisant une session existante si valide ou effectuant une nouvelle connexion.
 * @returns {Promise<{success: boolean, message: string, page: Page | null, browser: Browser | null}>} Résultat de la connexion avec instances page et navigateur
 */
export const loginToTwitter = async (): Promise<{
  success: boolean;
  message: string;
  page: Page | null;
  browser: Browser | null;
}> => {
  console.log("Login to Twitter");

  try {
    // Lancer le navigateur
    browser = await launchBrowser();
    const page = await browser.newPage();
    await configurePage(page);

    // Vérifier les sessions existantes
    const currentDate = new Date();
    const [previousSession, deleteExpiredSessions] = await prisma.$transaction([
      prisma.xSession.findFirst({
        where: {
          expiresAt: {
            gte: currentDate,
          },
        },
      }),
      prisma.xSession.deleteMany({
        where: {
          expiresAt: {
            lt: currentDate,
          },
        },
      }),
    ]);

    if (previousSession) {
      console.log("Existing session found");
      const cookiesArr = JSON.parse(previousSession?.cookie as string);
      for (const cookie of cookiesArr) {
        await page.setCookie(cookie);
      }
      console.log("Cookies loaded");

      const isLoggedIn = await checkExistingLogin(page);
      if (isLoggedIn) {
        return {
          success: true,
          message: "Login successful with existing session",
          page,
          browser,
        };
      } else {
        console.log("Existing session invalid, performing new login");
        const loginResult = await goToLogin(page);
        const success = loginResult.includes("Login successful");

        if (success) {
          // Sauvegarder les cookies pour les sessions futures
          const cookies = await page.cookies();
          const sessionExpiry = new Date();
          sessionExpiry.setHours(sessionExpiry.getHours() + 24);

          await prisma.xSession.create({
            data: {
              cookie: JSON.stringify(cookies),
              expiresAt: sessionExpiry,
            },
          });
          console.log("Session saved to database");
        }

        return {
          success,
          message: loginResult,
          page,
          browser,
        };
      }
    } else {
      console.log("No valid session found, performing new login");
      const loginResult = await goToLogin(page);
      const success = loginResult.includes("Login successful");

      if (success) {
        // Sauvegarder les cookies pour les sessions futures
        const cookies = await page.cookies();
        const sessionExpiry = new Date();
        sessionExpiry.setHours(sessionExpiry.getHours() + 24);

        await prisma.xSession.create({
          data: {
            cookie: JSON.stringify(cookies),
            expiresAt: sessionExpiry,
          },
        });
        console.log("Session saved to database");
      }

      return {
        success,
        message: loginResult,
        page,
        browser,
      };
    }
  } catch (error) {
    console.error("Error during login process:", error);
    return {
      success: false,
      message: `Login failed due to an error: ${
        error instanceof Error ? error.message : String(error)
      }`,
      page: null,
      browser,
    };
  }
};

/**
 * Determines if a route is a tramway (lines 1-5) or bus
 * @param routeId The route ID to check
 * @returns True if the route is a tramway
 */
const isTramway = (routeId: string): boolean => {
  // Remove any prefix (like "T-" or "X-")
  const numericPart = routeId.split('-').pop() || routeId;
  const lineNumber = parseInt(numericPart, 10);
  return !isNaN(lineNumber) && lineNumber >= 1 && lineNumber <= 5;
};

/**
 * Gets an emoji for the given alert cause
 * @param cause The alert cause
 * @param isResolution Whether this is an incident resolution
 * @returns Appropriate emoji for the cause
 */
const getCauseEmoji = (cause: string, isResolution: boolean = false): string => {
  if (isResolution) return '';
  
  switch (cause) {
    case 'TECHNICAL_PROBLEM':
      return '🔧';
    case 'STRIKE':
      return '🪧';
    case 'DEMONSTRATION':
      return '📢';
    case 'ACCIDENT':
      return '🚨';
    case 'HOLIDAY':
      return '🎉';
    case 'WEATHER':
      return '🌦️';
    case 'MAINTENANCE':
      return '🛠️';
    case 'CONSTRUCTION':
      return '🚧';
    case 'POLICE_ACTIVITY':
      return '👮';
    case 'MEDICAL_EMERGENCY':
      return '🚑';
    case 'TRAFFIC_JAM':
      return '🚏';
    default:
      return '⚠️';
  }
};

/**
 * Formats a date to HH:MM format
 * @param date The date to format
 * @returns Formatted time string
 */
const formatTime = (date: Date): string => {
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
};

/**
 * Groups alerts by their header text
 * @param alerts Array of alerts to group
 * @returns Grouped alerts by header text
 */
export const groupAlertsByHeader = (alerts: Alert[]): Record<string, Alert[]> => {
  const grouped: Record<string, Alert[]> = {};
  
  for (const alert of alerts) {
    if (!grouped[alert.headerText]) {
      grouped[alert.headerText] = [];
    }
    grouped[alert.headerText].push(alert);
  }
  
  return grouped;
};

/**
 * Formats a group of alerts with the same header into a tweet
 * @param alerts Alerts with the same header text
 * @returns Formatted tweet text
 */
export const formatTweetFromAlertGroup = (alerts: Alert[]): string => {
  if (alerts.length === 0) return '';
  
  const headerText = alerts[0].headerText;
  const isResolution = headerText.toLowerCase().includes('reprise') || 
                       headerText.toLowerCase().includes('résolution') || 
                       headerText.toLowerCase().includes('fin d\'incident');
  
  // Get all unique route IDs from the group
  const allRouteIds = new Set<string>();
  let hasTramway = false;
  
  alerts.forEach(alert => {
    if (alert.routeIds) {
      alert.routeIds.split(',').forEach(route => {
        const trimmedRoute = (route.split('-').pop() || route).trim();
        allRouteIds.add(trimmedRoute);
        if (isTramway(trimmedRoute)) {
          hasTramway = true;
        }
      });
    }
  });
  
  // Sort routes by type (tramway first) and then by number
  const sortedRoutes = Array.from(allRouteIds).sort((a, b) => {
    const aIsTram = isTramway(a);
    const bIsTram = isTramway(b);
    
    if (aIsTram && !bIsTram) return -1;
    if (!aIsTram && bIsTram) return 1;
    
    // Extract numeric parts for comparison
    const aNumeric = parseInt(a.replace(/^[A-Za-z\-]+/, ''), 10);
    const bNumeric = parseInt(b.replace(/^[A-Za-z\-]+/, ''), 10);
    
    return aNumeric - bNumeric;
  });
  
  // Get start time from the first alert (they should be sorted by time)
  const startTime = formatTime(alerts[0].timeStart);
  
  // Build the tweet
  let tweet = '';
  
  // Add cause emoji and tramway emoji if applicable
  const causeEmoji = getCauseEmoji(alerts[0].cause, isResolution);
  if (causeEmoji) tweet += `${causeEmoji} `;
  if (hasTramway && !isResolution) tweet += '🚊 ';
  
  // Add header and time
  tweet += `${startTime}\n`;
  tweet += sortedRoutes.length > 1 ? `Lignes: ${sortedRoutes.join('-')}\n` : `Ligne: ${sortedRoutes[0]}\n`;
  tweet += `${alerts[0].descriptionText}\n\n`;
  tweet += `#Montpellier`;
  
  // Twitter has a 280 character limit
  if (tweet.length > 280) {
    // Truncate if needed
    tweet = tweet.substring(0, 277) + '...';
  }
  
  return tweet;
};

/**
 * Writes and posts a tweet with custom content
 * @param content The content of the tweet to post
 * @returns A result message and success status
 */
export const writeAndPostTweet = async (
  content: string
): Promise<{ success: boolean; message: string }> => {
  console.log("Writing and posting tweet with content:", content);
  let loginResult;

  try {
    // Se connecter à Twitter
    loginResult = await loginToTwitter();
    if (!loginResult.success) {
      return {
        success: false,
        message: `Failed to login: ${loginResult.message}`,
      };
    }

    console.log("Login successful, proceeding to write and post tweet");
    const { page } = loginResult;

    if (!page) {
      throw new Error("Page object is null after login");
    }

    // La page devrait déjà être sur la page de composition de tweet grâce à loginToTwitter
    // Entrer le contenu du tweet
    const contentEntered = await enterTweetContent(page, content);
    if (!contentEntered) {
      throw new Error("Failed to enter tweet content");
    }

    // Attendre un moment pour que le contenu soit bien enregistré
    await wait(500);

    // Soumettre le tweet
    const submitted = await submitTweet(page);
    if (!submitted) {
      throw new Error("Failed to submit tweet");
    }

    return { success: true, message: "Tweet posted successfully" };
  } catch (error) {
    console.error("Error posting tweet:", error);
    return {
      success: false,
      message: `Failed to post tweet: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    // Fermer la page et le navigateur
    if (loginResult?.page) {
      await loginResult.page.close();
      console.log("Page closed");
    }

    if (loginResult?.browser) {
      await loginResult.browser.close();
      console.log("Browser closed");
    }
  }
};

/**
 * Posts a tweet with the given alert information
 * @param alert The alert to post
 * @returns A result message and success status
 */
export const postTweet = async (
  alert: Alert
): Promise<{ success: boolean; message: string }> => {
  console.log("Posting tweet for alert:", alert.id);

  // Formater le contenu du tweet à partir de l'alerte
  const tweetContent = formatTweetFromAlertGroup([alert]);

  // Utiliser la fonction writeAndPostTweet pour publier le tweet
  const result = await writeAndPostTweet(tweetContent);

  // Si le tweet a été publié avec succès, mettre à jour l'alerte
  if (result.success) {
    try {
      await prisma.alert.update({
        where: { id: alert.id },
        data: { isPosted: true },
      });
      console.log(`Alert ${alert.id} marked as posted in database`);
    } catch (error) {
      console.error("Error updating alert status:", error);
      // Ne pas considérer l'échec de mise à jour comme un échec du tweet
    }
  }

  return result;
};

/**
 * Processes all unposted alerts and posts them as tweets
 * @returns Summary of the posting process
 */
export const processUnpostedAlerts = async (): Promise<{
  success: boolean;
  processed: number;
  failed: number;
  messages: string[];
}> => {
  console.log("Processing unposted alerts");
  const messages: string[] = [];
  let processed = 0;
  let failed = 0;

  try {
    // Get all unposted alerts
    const unpostedAlerts = await prisma.alert.findMany({
      where: {
        isPosted: false,
        timeStart: {
          gte: new Date(new Date().setHours(0, 0, 0, 0)), // Today
        },
      },
      orderBy: [
        { headerText: 'asc' },
        { timeStart: 'asc' },
      ],
      take: 20, // Increased limit to handle grouping
    });

    console.log(`Found ${unpostedAlerts.length} unposted alerts`);

    if (unpostedAlerts.length === 0) {
      return {
        success: true,
        processed: 0,
        failed: 0,
        messages: ["No unposted alerts found"],
      };
    }

    // Group alerts by header text
    const groupedAlerts = groupAlertsByHeader(unpostedAlerts);
    console.log(`Grouped into ${Object.keys(groupedAlerts).length} distinct alert headers`);

    // Process each group
    for (const [headerText, alertGroup] of Object.entries(groupedAlerts)) {
      console.log(`Processing alert group with header: "${headerText}" (${alertGroup.length} alerts)`);

      // Formater le contenu du tweet pour le groupe
      const tweetContent = formatTweetFromAlertGroup(alertGroup);

      // Publier le tweet
      const result = await writeAndPostTweet(tweetContent);
      
      if (result.success) {
        // Mettre à jour tous les alertes du groupe comme postées
        const alertIds = alertGroup.map(alert => alert.id);
        await prisma.alert.updateMany({
          where: { id: { in: alertIds } },
          data: { isPosted: true },
        });

        processed += alertGroup.length;
        messages.push(`Successfully posted ${alertGroup.length} alerts with header "${headerText}"`);
      } else {
        failed += alertGroup.length;
        messages.push(`Failed to post ${alertGroup.length} alerts with header "${headerText}": ${result.message}`);
      }

      // Wait a bit between posts to avoid rate limits
      await wait(500);
    }

    return {
      success: failed === 0,
      processed,
      failed,
      messages,
    };
  } catch (error) {
    console.error("Error processing alerts:", error);
    return {
      success: false,
      processed,
      failed: 0,
      messages: [
        `Error processing alerts: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
};

/**
 * Logs in to Twitter and posts any unposted alerts from today, grouping alerts with the same header
 * @returns Summary of the login and posting process
 */
export const postToTwitter = async (): Promise<{
  success: boolean;
  loginMessage: string;
  processed: number;
  failed: number;
  messages: string[];
}> => {
  console.log("Starting postToTwitter process");
  let loginResult;
  
  try {
    // Step 1: Login to Twitter
    loginResult = await loginToTwitter();
    
    if (!loginResult.success) {
      return {
        success: false,
        loginMessage: `Failed to login: ${loginResult.message}`,
        processed: 0,
        failed: 0,
        messages: [`Login failed: ${loginResult.message}`]
      };
    }
    
    console.log("Login successful, checking for unposted alerts");
    
    // Step 2: Check for unposted alerts from today
    const unpostedAlerts = await prisma.alert.findMany({
      where: {
        isPosted: false,
        timeStart: {
          gte: new Date(new Date().setHours(0, 0, 0, 0)), // Today
        },
      },
      orderBy: [
        { headerText: 'asc' },
        { timeStart: 'asc' },
      ],
      take: 20, // Increased limit to handle grouping
    });
    
    console.log(`Found ${unpostedAlerts.length} unposted alerts`);
    
    if (unpostedAlerts.length === 0) {
      // Close browser if no alerts to post
      if (loginResult.browser) {
        await loginResult.browser.close();
        console.log("Browser closed - no alerts to post");
      }
      
      return {
        success: true,
        loginMessage: loginResult.message,
        processed: 0,
        failed: 0,
        messages: ["Login successful but no unposted alerts found"]
      };
    }
    
    // Step 3: Group alerts by header text
    const groupedAlerts = groupAlertsByHeader(unpostedAlerts);
    console.log(`Grouped into ${Object.keys(groupedAlerts).length} distinct alert headers`);
    
    // Step 4: Process each group of alerts
    const messages: string[] = [];
    let processed = 0;
    let failed = 0;
    
    for (const [headerText, alertGroup] of Object.entries(groupedAlerts)) {
      console.log(`Processing alert group with header: "${headerText}" (${alertGroup.length} alerts)`);
      
      try {
        // Format the tweet content for the group
        const tweetContent = formatTweetFromAlertGroup(alertGroup);
        
        // Reuse the page from login if it exists
        if (loginResult.page) {
          // Navigate to compose tweet page if needed
          await goToComposeTweet(loginResult.page);
          
          // Enter tweet content
          const contentEntered = await enterTweetContent(loginResult.page, tweetContent);
          if (!contentEntered) {
            throw new Error("Failed to enter tweet content");
          }
          
          // Wait a moment for content to register
          await wait(500);
          
          // Submit the tweet
          const submitted = await submitTweet(loginResult.page);
          if (!submitted) {
            throw new Error("Failed to submit tweet");
          }
          
          // Update alert status in database for all alerts in the group
          const alertIds = alertGroup.map(alert => alert.id);
          await prisma.alert.updateMany({
            where: { id: { in: alertIds } },
            data: { isPosted: true },
          });
          
          processed += alertGroup.length;
          messages.push(`Successfully posted ${alertGroup.length} alerts with header "${headerText}"`);
        } else {
          // Fallback to individual posting if page is not available
          console.log("Page not available, using individual posting as fallback");
          const result = await writeAndPostTweet(tweetContent);
          
          if (result.success) {
            const alertIds = alertGroup.map(alert => alert.id);
            await prisma.alert.updateMany({
              where: { id: { in: alertIds } },
              data: { isPosted: true },
            });
            processed += alertGroup.length;
            messages.push(`Successfully posted ${alertGroup.length} alerts with header "${headerText}"`);
          } else {
            failed += alertGroup.length;
            messages.push(`Failed to post ${alertGroup.length} alerts with header "${headerText}": ${result.message}`);
          }
        }
        
        // Wait between posts to avoid rate limits
        await wait(500);
      } catch (error) {
        failed += alertGroup.length;
        messages.push(`Error posting alerts with header "${headerText}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    return {
      success: failed === 0,
      loginMessage: loginResult.message,
      processed,
      failed,
      messages
    };
  } catch (error) {
    console.error("Error in postToTwitter:", error);
    return {
      success: false,
      loginMessage: loginResult ? loginResult.message : "Login not attempted",
      processed: 0,
      failed: 0,
      messages: [`Error in postToTwitter: ${error instanceof Error ? error.message : String(error)}`]
    };
  } finally {
    // Close browser and page
    if (loginResult?.page) {
      await loginResult.page.close();
      console.log("Page closed");
    }
    
    if (loginResult?.browser) {
      await loginResult.browser.close();
      console.log("Browser closed");
    }
  }
};