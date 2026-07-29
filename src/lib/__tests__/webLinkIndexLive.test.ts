// Live end-to-end check of the search-index tier (real Serper queries + real page fetches).
// OPT-IN — it costs API calls and needs network, so it is skipped unless you ask for it:
//
//   WEBLINK_LIVE=1 npx vitest run src/lib/__tests__/webLinkIndexLive.test.ts --reporter=verbose
//
// Run it when a brand's links come back wrong: it prints, per product, which tier accepted the page
// and which SKU was chosen. The fixtures are the biamp products from the 2026-07-28 report
// (client-rendered catalog on products.biamp.com — see lib/webLinkIndexSearch.ts).
//
// It deliberately drives the SAME extracted decision helpers the route uses (mergeCandidates,
// strongMatchSource, classifyShellCandidate) rather than re-implementing them, so this file cannot
// quietly diverge from production behaviour.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { searchIndexCandidates } from "../webLinkIndexSearch";
import {
  extractPageContent,
  isContentlessShell,
  strongMatchSource,
  classifyShellCandidate,
  mergeCandidates,
  normalizedUrlKey,
  buildLeafSwapCandidates,
  looksLikeSoftNotFound,
  identifierMatchesAsToken,
  isDistinctiveIdentifier,
} from "../webLinkResolution";
import { renderPage, closeRenderer } from "../webLinkRender";

const LIVE = process.env.WEBLINK_LIVE === "1";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const loadEnv = () => {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
};

// Network failures against a live third-party site are an environment problem, not a code defect
// (biamp starts refusing connections after a few dozen probes), so they yield null and the product
// is reported as unresolved rather than exploding the run.
const fetchPage = async (url: string) => {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html,*/*", "Accept-Language": "en-US,en;q=0.5" },
    });
    if (!res.ok) return null;
    return { finalUrl: res.url, page: extractPageContent((await res.text()).slice(0, 500_000)) };
  } catch {
    return null;
  }
};

const products = [
  { part: "920-01871-20000", model: "Apprimo Touch 7 White", expectSku: "920-01871-20000" },
  { part: "930-10886-00004", model: "IS6-112W", expectSku: "930-10886-00004" },
  // Its own page exists but is NOT in the index (only sibling MASK6CT/MASK4CT variants are), whose
  // titles do not match this model. Recoverable only by constructing the URL from a sibling's shape
  // and proving it with a render — so it doubles as the test for that path.
  { part: "930-00641-00002", model: "MASK6C-W", expectSku: "930-00641-00002" },
  { part: "910-01492", model: "SUB2201-BL", expectSku: "910-01492" },
  { part: "910-01880", model: "Tango", expectSku: "910-01880" },
  // biamp's catalog SKU differs from our order code for these two (…-00001 vs our …-00002), so the
  // URL cannot carry the part number — the index title is the only evidence.
  { part: "920-01984-00002", model: "Voltera D 1200.2M", expectSku: "920-01984-00001" },
  { part: "920-01956-00002", model: "Voltera D 1200.8", expectSku: "920-01956-00001" },
];

describe.skipIf(!LIVE)("biamp catalog: search-index tier (live)", () => {
  it(
    "recovers the per-SKU pages, and never substitutes a sibling SKU",
    async () => {
      loadEnv();
      const outcomes: string[] = [];
      let matched = 0;
      let wrongSku = 0;
      let unreachable = 0;

      for (const p of products) {
        const identifiers = [p.part, p.model];
        const hits = await searchIndexCandidates({
          brand: "biamp",
          modelNumber: p.model,
          partNumber: p.part,
          domain: "biamp.com",
        });
        const indexByUrl = new Map(hits.map((h) => [normalizedUrlKey(h.link), h]));
        const candidates = mergeCandidates({
          indexHits: hits,
          proposals: [],
          identifiers,
          maxIndex: 5,
          maxProposals: 3,
          max: 8,
        }).filter((c) => !/\.(pdf|docx?|xlsx?)$/i.test(new URL(c.link).pathname));

        let tier = "none";
        let chosen = "";
        let reachable = false;
        for (const candidate of candidates.slice(0, 4)) {
          const fetched = await fetchPage(candidate.link);
          if (!fetched) continue;
          reachable = true;
          const matchSource = strongMatchSource(fetched.page, fetched.finalUrl, identifiers);
          if (matchSource === "page") {
            tier = "content";
            chosen = fetched.finalUrl;
            break;
          }
          if (isContentlessShell(fetched.page)) {
            const indexHit =
              indexByUrl.get(normalizedUrlKey(fetched.finalUrl)) ??
              indexByUrl.get(normalizedUrlKey(candidate.link)) ??
              null;
            if (classifyShellCandidate({ indexHit, identifiers, url: fetched.finalUrl }) === "index") {
              tier = "index";
              chosen = fetched.finalUrl;
              break;
            }
          }
          // Anything else needs the LLM judge, which this offline-ish check does not run.
        }

        // Nothing verified from the index: rebuild the URL from a sibling's shape and let a real
        // browser settle it (the route's last-resort path).
        if (!chosen) {
          for (const candidate of buildLeafSwapCandidates({
            indexedUrls: candidates.map((c) => c.link),
            partNumber: p.part,
          })) {
            const rendered = await renderPage(candidate, 22_000);
            if (!rendered) continue;
            const page = extractPageContent(rendered.html);
            if (looksLikeSoftNotFound(page)) continue;
            const pageWords = `${page.title} ${page.h1} ${page.ogTitle} ${page.metaDescription}`;
            if (identifiers.some((id) => isDistinctiveIdentifier(id) && identifierMatchesAsToken(pageWords, id))) {
              tier = "rendered";
              chosen = rendered.finalUrl;
              break;
            }
          }
        }

        const sku = chosen.match(/ecom-item\/([\w-]+)/)?.[1] ?? null;
        if (sku && sku === p.expectSku) matched++;
        else if (sku && sku !== p.expectSku) wrongSku++;
        else if (!reachable && tier === "none") unreachable++;
        outcomes.push(
          `${p.part.padEnd(16)} ${p.model.padEnd(22)} tier=${tier.padEnd(8)} sku=${sku ?? "-"} ` +
            `${
              sku === p.expectSku
                ? "as expected"
                : sku
                  ? "!! DIFFERENT SKU"
                  : !reachable
                    ? "site unreachable (throttled?)"
                    : p.expectSku
                      ? "!! MISSED"
                      : "correctly none"
            }`,
        );
        // Be a polite client: this hammers a third-party catalog, which starts refusing
        // connections after a few dozen requests.
        await new Promise((r) => setTimeout(r, 1_500));
      }

      console.log("\n" + outcomes.join("\n") + (unreachable ? `\n(${unreachable} product(s) unreachable)` : "") + "\n");
      // The invariant that must hold no matter how the network behaves.
      expect(wrongSku, "a sibling SKU's page must never be substituted").toBe(0);
      // Recovery is only assertable for products the site actually served.
      expect(matched, "per-SKU pages recovered (of the reachable ones)").toBeGreaterThanOrEqual(
        Math.max(1, products.length - 1 - unreachable),
      );
    },
    300_000,
  );

  it(
    "rejects a URL pattern-filled from the part number (the proposer's failure mode)",
    async () => {
      loadEnv();
      // Constructed, not found: biamp's catalog SKU for Voltera D 1200.8 is …-00001, and the
      // proposer returned this …-00002 variant of the URL when told about the subdomain. The site
      // answers HTTP 200 with the same shell for any SKU, so only the index can refute it.
      const fabricated = "https://products.biamp.com/product-details/-/o/ecom-item/920-01956-00002";
      const identifiers = ["920-01956-00002", "Voltera D 1200.8"];
      const fetched = await fetchPage(fabricated);
      expect(fetched, "the site answers 200 even for a SKU that has no page").not.toBeNull();
      expect(isContentlessShell(fetched!.page)).toBe(true);
      // The old pipeline accepted exactly this as "content" (part number in the URL/canonical).
      expect(strongMatchSource(fetched!.page, fetched!.finalUrl, identifiers)).toBe("url");

      const hits = await searchIndexCandidates({
        brand: "biamp",
        modelNumber: "Voltera D 1200.8",
        partNumber: "920-01956-00002",
        domain: "biamp.com",
      });
      const indexHit = new Map(hits.map((h) => [normalizedUrlKey(h.link), h])).get(normalizedUrlKey(fabricated)) ?? null;
      expect(indexHit, "must not be index-confirmed").toBeNull();
      expect(classifyShellCandidate({ indexHit, identifiers, url: fabricated })).toBe("no-witness");

      // And rendering must never accept it. The site prints "<part> - ITEM NOT FOUND OR NOT
      // AVAILABLE" in its <h1>, but that heading is rendered by the SAME slow lookup that fails, so
      // a render can also legitimately time out with an empty DOM. Both outcomes must be rejections
      // — that asymmetry is the safety property: an unconvincing render never accepts.
      const rendered = await renderPage(fabricated, 25_000);
      if (rendered) {
        const page = extractPageContent(rendered.html);
        const namesProduct = identifiers.some(
          (id) => isDistinctiveIdentifier(id) && identifierMatchesAsToken(`${page.title} ${page.h1} ${page.ogTitle}`, id),
        );
        expect(namesProduct || looksLikeSoftNotFound(page), "a fabricated SKU must never look like its product").toBe(
          page.h1 ? looksLikeSoftNotFound(page) : false,
        );
        if (page.h1) expect(looksLikeSoftNotFound(page)).toBe(true);
        else console.log("[live] the fabricated page had not rendered its heading yet — rejected as inconclusive");
      } else {
        console.log("[live] render timed out — rejected, which is the safe outcome");
      }
      await closeRenderer();
    },
    180_000,
  );
});
