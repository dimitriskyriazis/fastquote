import { Semaphore } from "./concurrency";

/**
 * Thin wrapper over the Serper Google Search API used to fetch a few result snippets as
 * extra context for product-description generation. Returns [] on any error or when no
 * SERPER_API_KEY is configured, so callers can treat web context as best-effort.
 */
const serperSemaphore = new Semaphore(5);

export type SerperSnippet = { title: string; snippet: string };

export const serperSearch = async (q: string, tag = ""): Promise<SerperSnippet[]> => {
  if (!process.env.SERPER_API_KEY) return [];
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1000;

  await serperSemaphore.acquire();
  try {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": process.env.SERPER_API_KEY ?? "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q, num: 5, hl: "en", gl: "us" }),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          organic?: Array<{ title?: string; snippet?: string }>;
        };
        return (data.organic ?? [])
          .slice(0, 3)
          .map((r) => ({ title: r.title ?? "", snippet: r.snippet ?? "" }))
          .filter((r) => r.title || r.snippet);
      }

      if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[serper] ${res.status}${tag ? ` (${tag})` : ""}, retry in ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      console.error(`[serper] API error${tag ? ` (${tag})` : ""}: ${res.status}`);
      return [];
    }
    return [];
  } catch (err) {
    console.warn(`[serper] request failed${tag ? ` (${tag})` : ""}:`, err);
    return [];
  } finally {
    serperSemaphore.release();
  }
};
