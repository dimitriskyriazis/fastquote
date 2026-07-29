import { describe, it, expect } from "vitest";
import { buildProposerPrompt, parseProposerReply } from "../webLinkProposer";

const product = {
  brand: "Bosch",
  partNumber: "PVA-2P500",
  modelNumber: "",
  description: "Power amplifier, 2x500W",
};

describe("buildProposerPrompt", () => {
  it("scopes the search to the curated domain when known", () => {
    const prompt = buildProposerPrompt(product, "commerce.keenfinity.tech");
    expect(prompt).toContain("commerce.keenfinity.tech");
    expect(prompt).toContain("PVA-2P500");
    expect(prompt).toContain("Power amplifier, 2x500W");
    expect(prompt).toContain("ENGLISH");
  });
  it("asks the model to identify the official site when no domain is known", () => {
    const prompt = buildProposerPrompt(product, null);
    expect(prompt).toContain("identify the manufacturer's official website");
    expect(prompt).toContain("official_domain");
  });
  it("tells the model to search the base part number when a core is supplied", () => {
    const prompt = buildProposerPrompt(
      { brand: "Rittal", partNumber: "8660.034-RT", partNumberCore: "8660.034", modelNumber: "", description: "trim panel" },
      "rittal.com",
    );
    expect(prompt).toContain("Base part number (better search term than the full order code): 8660.034");
    expect(prompt).toContain("use the BASE part number");
  });
  it("leads with the model name and forbids constructing URLs", () => {
    const prompt = buildProposerPrompt(
      { brand: "biamp", partNumber: "920-01956-00002", modelNumber: "Voltera D 1200.8", description: "amplifier" },
      "biamp.com",
    );
    // The part number is an internal order code — the model name is what manufacturer pages
    // are titled with, so it must be presented as the primary search term. Assert both lines are
    // PRESENT before comparing positions: two -1s would satisfy a bare "<" comparison.
    const modelAt = prompt.indexOf("Model / product name (PRIMARY search term): Voltera D 1200.8");
    const partAt = prompt.indexOf("Part / order code");
    expect(modelAt).toBeGreaterThan(-1);
    expect(partAt).toBeGreaterThan(-1);
    expect(modelAt).toBeLessThan(partAt);
    expect(prompt).toContain("NEVER construct, guess, complete or pattern-fill a URL");
    expect(prompt).toContain("STRONGLY prefer the page for THIS specific model");
  });
  it("omits the base-part-number guidance when there is no suffix", () => {
    const prompt = buildProposerPrompt(product, "commerce.keenfinity.tech"); // no partNumberCore
    expect(prompt).not.toContain("Base part number");
    expect(prompt).not.toContain("use the BASE part number");
  });
});

describe("parseProposerReply", () => {
  it("parses a clean JSON reply", () => {
    const result = parseProposerReply(
      '{"candidates": ["https://commerce.keenfinity.tech/xl/en/Power-amplifier-2x500W/p/F.01U.298.641/"], "official_domain": "commerce.keenfinity.tech", "not_found": false}',
    );
    expect(result.candidates).toEqual([
      "https://commerce.keenfinity.tech/xl/en/Power-amplifier-2x500W/p/F.01U.298.641/",
    ]);
    expect(result.resolvedDomain).toBe("commerce.keenfinity.tech");
  });

  it("tolerates fenced code blocks and surrounding prose", () => {
    const result = parseProposerReply(
      'Here is what I found:\n```json\n{"candidates": ["https://www.extron.com/product/x"], "official_domain": "https://www.extron.com/", "not_found": false}\n```\nLet me know if you need more.',
    );
    expect(result.candidates).toEqual(["https://www.extron.com/product/x"]);
    // official_domain is normalized to a bare domain even when given as a URL
    expect(result.resolvedDomain).toBe("extron.com");
  });

  it("filters non-URL candidates, dedupes, and caps the list", () => {
    const result = parseProposerReply(
      JSON.stringify({
        candidates: [
          "https://a.com/1",
          "not a url",
          "ftp://a.com/x",
          "https://a.com/1",
          "https://a.com/2",
          "https://a.com/3",
          "https://a.com/4",
          "https://a.com/5",
          "https://a.com/6",
        ],
        official_domain: "a.com",
      }),
    );
    expect(result.candidates).toHaveLength(5);
    expect(result.candidates[0]).toBe("https://a.com/1");
    expect(result.candidates).not.toContain("not a url");
  });

  it("handles not_found and garbage without throwing", () => {
    expect(parseProposerReply('{"candidates": [], "official_domain": "", "not_found": true}')).toEqual({
      candidates: [],
      resolvedDomain: null,
    });
    expect(parseProposerReply("I could not find anything, sorry.")).toEqual({
      candidates: [],
      resolvedDomain: null,
    });
    expect(parseProposerReply("")).toEqual({ candidates: [], resolvedDomain: null });
  });
});
