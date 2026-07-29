// Headless rendering for the add-weblinks pipeline.
//
// WHY: the whole verification pipeline reads a page with fetch(), which cannot run JavaScript.
// Manufacturers increasingly serve their per-SKU catalog pages as a client-rendered shell — biamp's
// products.biamp.com returns ~560 bytes of nav furniture and the generic title "Product Details" for
// EVERY SKU, live or retired or entirely made up (verified with 999-99999-99999), and echoes the
// requested path into <link rel="canonical">. Without rendering we are reduced to trusting a search
// index as the sole witness that such a page exists and is the right product.
//
// Rendering the page removes that dependency: the DOM carries the real product name, and a dead SKU
// says so out loud. It also makes a CONSTRUCTED url verifiable — which is what lets the pipeline
// recover a product whose page exists but was never crawled (see buildLeafSwapCandidates).
//
// OPERATIONAL NOTES:
//  - playwright is a devDependency and its browser binary is installed separately
//    (`npx playwright install chromium`). If either is missing this module disables itself on first
//    use, logs once with that command, and the caller silently falls back to fetch-only behaviour.
//  - One browser per process, reused; a small semaphore bounds concurrent pages so a 10-product
//    chunk cannot open ten Chromium tabs at once.
//  - WEBLINK_RENDER=0 turns it off entirely.

import { Semaphore } from "./concurrency";

export type RenderedPage = {
  /** URL after client-side and server-side redirects. */
  finalUrl: string;
  /** Full DOM serialization, for the same extractPageContent() path a fetched page takes. */
  html: string;
};

const RENDER_DISABLED = process.env.WEBLINK_RENDER === "0";
// Live catalog pages render in 7-19s; a MISSING SKU is the slow case (~24-30s), because the app
// waits out its own failed lookup. Allow for that — a timeout is a rejection, so being too impatient
// would hide the very signal that refutes a constructed URL.
const NAVIGATION_TIMEOUT_MS = 28_000;
// How long to wait, after the navigation commits, for the app to actually render its product.
// products.biamp.com routinely needs ~15-20s, so a shorter ceiling produced empty snapshots that the
// caller could not distinguish from a wrong page. Whatever remains of the caller's budget is used.
const SETTLE_TIMEOUT_MS = 26_000;
const HTML_CAP = 500_000;

// Nothing here contributes to the text we extract.
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font", "stylesheet"]);
// Tag managers, chat widgets and session recorders: they hold connections open, add seconds of
// latency, and would report our verification traffic to third parties.
const BLOCKED_HOST =
  /(google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|clarity\.ms|newrelic|nr-data|optimizely|segment\.io|intercom|drift\.com|qualified\.com|pure\.cloud|hs-scripts|hs-analytics|cookielaw|onetrust|usercentrics)/i;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Two pages at a time: enough to keep a chunk moving, small enough to bound memory on the app box.
const renderSemaphore = new Semaphore(2);

type BrowserLike = {
  newContext(options?: unknown): Promise<ContextLike>;
  close(): Promise<void>;
  isConnected?: () => boolean;
};
type ContextLike = {
  newPage(): Promise<PageLike>;
  route(pattern: string, handler: (route: RouteLike) => unknown): Promise<void>;
  close(): Promise<void>;
};
type RouteLike = {
  request(): { resourceType(): string; url(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
};
type PageLike = {
  goto(url: string, options?: unknown): Promise<unknown>;
  waitForLoadState(state: string, options?: unknown): Promise<void>;
  waitForFunction(fn: string, arg?: unknown, options?: unknown): Promise<unknown>;
  content(): Promise<string>;
  url(): string;
  close(): Promise<void>;
};

let browserPromise: Promise<BrowserLike | null> | null = null;
let permanentlyDisabled = RENDER_DISABLED;
// A launch can fail for reasons that have nothing to do with the install: the browser being killed,
// a hot reload tearing the module down, a momentary resource limit. Latching "disabled" on the first
// such error silently downgraded a whole batch to fetch-only — measured, with pages that had
// rendered fine minutes earlier coming back as unverified guesses. Only a MISSING install is
// permanent; anything else gets a few more chances.
let consecutiveLaunchFailures = 0;
const MAX_LAUNCH_FAILURES = 3;

const isMissingInstall = (err: unknown): boolean => {
  const message = err instanceof Error ? `${err.message}` : String(err);
  return /Cannot find module|MODULE_NOT_FOUND|Executable doesn't exist|playwright install|browserType\.launch: Failed to launch/i.test(
    message,
  );
};

/** True when rendering is at least theoretically available (not switched off, not already proven
 *  broken). Cheap — does not launch anything. */
export const isRenderingEnabled = (): boolean => !permanentlyDisabled;

const launchBrowser = async (): Promise<BrowserLike | null> => {
  try {
    // Dynamic + external (see serverExternalPackages in next.config.ts): the route must load
    // without playwright present.
    const playwright = (await import("playwright")) as unknown as {
      chromium: { launch(options?: unknown): Promise<BrowserLike> };
    };
    const browser = await playwright.chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage", "--no-sandbox"],
    });
    console.log("[weblink] headless renderer ready");
    consecutiveLaunchFailures = 0;
    return browser;
  } catch (err) {
    consecutiveLaunchFailures++;
    if (isMissingInstall(err) || consecutiveLaunchFailures >= MAX_LAUNCH_FAILURES) {
      permanentlyDisabled = true;
      console.warn(
        "[weblink] headless rendering disabled — falling back to fetch-only verification. " +
          "JS-only catalog pages will only be accepted when a search index confirms them. " +
          "If the browser is not installed, run: npx playwright install chromium. Cause:",
        err instanceof Error ? err.message : err,
      );
    } else {
      console.warn(
        `[weblink] headless renderer launch failed (${consecutiveLaunchFailures}/${MAX_LAUNCH_FAILURES}), will retry:`,
        err instanceof Error ? err.message : err,
      );
    }
    return null;
  }
};

const getBrowser = async (): Promise<BrowserLike | null> => {
  if (permanentlyDisabled) return null;
  if (!browserPromise) browserPromise = launchBrowser();
  const browser = await browserPromise;
  // A failed launch must not be remembered as "the browser" — drop it so the next caller retries.
  if (!browser) browserPromise = null;
  // A crashed browser must not poison every later call.
  if (browser && browser.isConnected && !browser.isConnected()) {
    browserPromise = null;
    return getBrowser();
  }
  return browser;
};

/**
 * Loads a URL in a real browser and returns the rendered DOM. Returns null when rendering is
 * unavailable, the navigation failed, or the budget ran out — callers treat that exactly like "we
 * could not read this page" and fall back to their other evidence.
 */
export const renderPage = async (url: string, budgetMs?: number): Promise<RenderedPage | null> => {
  if (permanentlyDisabled) return null;
  const navigationTimeout = Math.min(NAVIGATION_TIMEOUT_MS, budgetMs ?? NAVIGATION_TIMEOUT_MS);
  if (navigationTimeout < 3_000) return null; // not enough time to be worth a browser tab

  const browser = await getBrowser();
  if (!browser) return null;
  // Spend the whole budget: the navigation commits quickly, so the remainder belongs to the settle
  // wait, which is what actually decides whether the product appears.
  const deadline = Date.now() + (budgetMs ?? NAVIGATION_TIMEOUT_MS);

  await renderSemaphore.acquire();
  let context: ContextLike | null = null;
  try {
    context = await browser.newContext({
      userAgent: BROWSER_UA,
      locale: "en-US",
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
      viewport: { width: 1280, height: 900 },
    });
    // We only ever read text, so refuse everything that merely makes a page look right. On the
    // enterprise portals this matters for — image-heavy, webfont-heavy, tag-manager-heavy — this is
    // the difference between a page that settles in a few seconds and one that outlives its budget.
    await context.route("**/*", (route) => {
      const request = route.request();
      const type = request.resourceType();
      if (BLOCKED_RESOURCE_TYPES.has(type) || BLOCKED_HOST.test(request.url())) return route.abort();
      return route.continue();
    });

    const page = await context.newPage();
    // "commit" returns as soon as the navigation is committed, instead of waiting for a load event
    // these portals delay behind dozens of blocking requests. The product itself is then waited for
    // explicitly below.
    await page.goto(url, { waitUntil: "commit", timeout: navigationTimeout });
    // The signal that the app has actually rendered its product: a non-empty <h1>, or a <title> that
    // is no longer the generic placeholder. A timeout here is not fatal — whatever HTML exists is
    // still extracted, and the caller decides whether it is convincing.
    await page
      .waitForFunction(
        // Wait for CONTENT, not merely for a title: a title is present the moment the document
        // commits, so keying on it snapshotted client-rendered pages before the product appeared.
        `(() => {
          const h1 = document.querySelector('h1');
          if (h1 && h1.textContent && h1.textContent.trim().length > 0) return true;
          const text = (document.body && document.body.innerText) || '';
          return text.trim().length > 1200;
        })()`,
        undefined,
        { timeout: Math.max(2_000, Math.min(SETTLE_TIMEOUT_MS, deadline - Date.now())), polling: 250 },
      )
      .catch(() => {});
    const html = (await page.content()).slice(0, HTML_CAP);
    const finalUrl = page.url() || url;
    await page.close().catch(() => {});
    return { finalUrl, html };
  } catch (err) {
    console.log(`[weblink] render failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    await context?.close().catch(() => {});
    renderSemaphore.release();
  }
};

/** Releases the shared browser (tests / graceful shutdown). */
export const closeRenderer = async (): Promise<void> => {
  const pending = browserPromise;
  browserPromise = null;
  const browser = await pending?.catch(() => null);
  await browser?.close().catch(() => {});
};
