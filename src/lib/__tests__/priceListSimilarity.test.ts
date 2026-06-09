import { describe, it, expect } from "vitest";
import {
  normalizeModelBase,
  descriptionSignatureTokens,
  descriptionSignatureKey,
  groupSimilarRows,
  MAX_SIMILAR_GROUP,
  type SimilarityRow,
} from "../priceListSimilarity";

describe("normalizeModelBase", () => {
  it("strips a trailing colour-code variant suffix", () => {
    expect(normalizeModelBase("MASK6C-W")).toBe(normalizeModelBase("MASK6C-BL"));
    expect(normalizeModelBase("MASK6C-W")).toBe("MASK6C");
    expect(normalizeModelBase("IC6-WH")).toBe("IC6");
  });

  it("strips a trailing region-code variant suffix", () => {
    expect(normalizeModelBase("AP-4000-EU")).toBe(normalizeModelBase("AP-4000-US"));
  });

  it("strips a region code glued onto the part number without a separator", () => {
    expect(normalizeModelBase("", "R9400810EU")).toBe("R9400810");
    expect(normalizeModelBase("", "R9400810EU")).toBe(normalizeModelBase("", "R9400810UK"));
    // ...but a different model number is still distinct.
    expect(normalizeModelBase("", "R9400810EU")).not.toBe(normalizeModelBase("", "R9400811EU"));
  });

  it("does not mistake trailing letters of a word for a glued region code", () => {
    expect(normalizeModelBase("PLUS")).toBe("PLUS"); // ends in "US" but no digit before it
    expect(normalizeModelBase("MENU")).toBe("MENU");
  });

  it("strips a short trailing pure-digit pack/sequence segment", () => {
    expect(normalizeModelBase("Expert Power Control 1105-1")).toBe(
      normalizeModelBase("Expert Power Control 1105-2"),
    );
  });

  it("does NOT strip a meaningful trailing segment", () => {
    expect(normalizeModelBase("Tesira AMP-450BP")).toBe("TESIRA AMP 450BP");
    expect(normalizeModelBase("DC220T-M")).toBe("DC220T M");
  });

  it("does NOT strip a trailing number that is the model identity (no digit in the prior segment)", () => {
    // "AMP 480"/"CX 100"/"DCS-5" — the number IS the product, not a pack/sequence code.
    expect(normalizeModelBase("AMP 240")).not.toBe(normalizeModelBase("AMP 480"));
    expect(normalizeModelBase("CX 100")).not.toBe(normalizeModelBase("CX 200"));
    expect(normalizeModelBase("DCS-5")).not.toBe(normalizeModelBase("DCS-8"));
  });

  it("leaves single-segment models intact", () => {
    expect(normalizeModelBase("MASK6C")).toBe("MASK6C");
  });

  it("falls back to the part number when there is no model", () => {
    expect(normalizeModelBase("", "910-00337-W")).toBe("910 00337");
    expect(normalizeModelBase(null, "910-00337-BL")).toBe("910 00337");
  });

  it("returns an empty base when nothing is supplied", () => {
    expect(normalizeModelBase("", "")).toBe("");
    expect(normalizeModelBase(null, null)).toBe("");
  });
});

describe("descriptionSignature", () => {
  it("drops colours, numbers and units so variants share a skeleton", () => {
    expect(descriptionSignatureKey("Ceiling speaker 6 inch, 10W, white")).toBe(
      descriptionSignatureKey("Ceiling speaker 8 inch, 20W, black"),
    );
  });

  it("keeps the meaningful word skeleton", () => {
    expect(descriptionSignatureTokens("Commercial ceiling speaker, 10 W, 8 ohms, white")).toEqual([
      "commercial",
      "ceiling",
      "speaker",
    ]);
  });

  it("distinguishes genuinely different product types", () => {
    expect(descriptionSignatureKey("Ceiling speaker, white")).not.toBe(
      descriptionSignatureKey("Wall amplifier, white"),
    );
  });

  it("is empty for blank input", () => {
    expect(descriptionSignatureTokens("")).toEqual([]);
    expect(descriptionSignatureKey(null)).toBe("");
  });
});

describe("groupSimilarRows", () => {
  const flatten = (groups: number[][]) => groups.flat().sort((a, b) => a - b);

  it("returns no groups for empty input", () => {
    expect(groupSimilarRows([])).toEqual([]);
  });

  it("covers every index exactly once", () => {
    const rows: SimilarityRow[] = [
      { modelNumber: "MASK6C-W", description: "Ceiling speaker white" },
      { modelNumber: "MASK6C-BL", description: "Ceiling speaker black" },
      { modelNumber: "AMP-450BP", description: "2-channel amplifier" },
      { modelNumber: "XYZ-1", description: "Random gadget" },
    ];
    const groups = groupSimilarRows(rows);
    expect(flatten(groups)).toEqual([0, 1, 2, 3]);
  });

  it("groups colour variants of the same base model", () => {
    const rows: SimilarityRow[] = [
      { modelNumber: "MASK6C-W", description: "Commercial ceiling speaker, 10W, white" },
      { modelNumber: "MASK6C-BL", description: "Commercial ceiling speaker, 10W, black" },
      { modelNumber: "WIDGET-9", description: "Unrelated rack shelf" },
    ];
    const groups = groupSimilarRows(rows);
    const family = groups.find((g) => g.includes(0));
    expect(family).toEqual([0, 1]);
    expect(groups.some((g) => g.length === 1 && g[0] === 2)).toBe(true);
  });

  it("groups EU/UK region variants of the same glued part number together", () => {
    const rows: SimilarityRow[] = [
      { partNumber: "R9400810EU", description: "4K UHD laser phosphor projector, 8000 lumens" },
      { partNumber: "R9400810UK", description: "4K UHD laser phosphor projector, 8000 lumens" },
      { partNumber: "R9400811EU", description: "4K UHD laser projector, 10000 lumens" },
      { partNumber: "R9400811UK", description: "4K UHD laser projector, 10000 lumens" },
    ];
    const groups = groupSimilarRows(rows);
    expect(groups.find((g) => g.includes(0))).toEqual([0, 1]); // 810 EU+UK
    expect(groups.find((g) => g.includes(2))).toEqual([2, 3]); // 811 EU+UK
  });

  it("groups strong-base variants even when the source descriptions are inconsistent", () => {
    const rows: SimilarityRow[] = [
      { partNumber: "R9400810EU", description: "Single-chip DLP laser phosphor projector, 8000 lumens, 4K" },
      { partNumber: "R9400810UK", description: "Projector 4K UHD, network capable, optional Wi-Fi, compact" },
    ];
    // Same strong base R9400810 (EU/UK) → grouped so the rewrite makes them consistent, even though
    // the two supplier descriptions are worded completely differently (this is the real-world case).
    expect(groupSimilarRows(rows)).toEqual([[0, 1]]);
  });

  it("groups size variants whose model bases differ via the identical description skeleton", () => {
    const rows: SimilarityRow[] = [
      { modelNumber: "QE43T", description: 'Professional display 43" 4K Edge LED' },
      { modelNumber: "QE50T", description: 'Professional display 50" 4K Edge LED' },
      { modelNumber: "QE55T", description: 'Professional display 55" 4K Edge LED' },
    ];
    const groups = groupSimilarRows(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual([0, 1, 2]);
  });

  it("does NOT group same-base models whose descriptions are unrelated", () => {
    // Base-model collision between genuinely different products → kept as singletons.
    const rows: SimilarityRow[] = [
      { modelNumber: "IC6-W", description: "Ceiling speaker, two-way coaxial" },
      { modelNumber: "IC6-EU", description: "Network paging controller, rack mount" },
    ];
    const groups = groupSimilarRows(rows);
    expect(groups).toHaveLength(2);
  });

  it("leaves distinct products as singletons", () => {
    const rows: SimilarityRow[] = [
      { modelNumber: "A1", description: "HDMI matrix switcher" },
      { modelNumber: "B2", description: "Wireless microphone receiver" },
      { modelNumber: "C3", description: "Pole mount bracket" },
    ];
    const groups = groupSimilarRows(rows);
    expect(groups).toHaveLength(3);
    groups.forEach((g) => expect(g).toHaveLength(1));
  });

  it("splits an oversized family into chunks of at most MAX_SIMILAR_GROUP", () => {
    const rows: SimilarityRow[] = Array.from({ length: MAX_SIMILAR_GROUP + 5 }, (_, i) => ({
      modelNumber: `SPK-${i}`, // identical description skeletons link them via Phase B
      description: "Ceiling speaker commercial grade",
    }));
    const groups = groupSimilarRows(rows);
    expect(groups.length).toBeGreaterThan(1);
    groups.forEach((g) => expect(g.length).toBeLessThanOrEqual(MAX_SIMILAR_GROUP));
    expect(flatten(groups)).toEqual(rows.map((_, i) => i));
  });

  it("does not merge distinct models whose numbers are their identity, even with similar text", () => {
    const rows: SimilarityRow[] = [
      { modelNumber: "AMP 240", description: "Power amplifier studio 2-channel" },
      { modelNumber: "AMP 480", description: "Power amplifier touring 2-channel" },
    ];
    // Bases stay "AMP 240" / "AMP 480" (number kept) and the skeletons differ → two singletons.
    expect(groupSimilarRows(rows)).toHaveLength(2);
  });

  it("does not group on a single generic skeleton word", () => {
    const rows: SimilarityRow[] = [
      { partNumber: "P1", description: "cable" },
      { partNumber: "P2", description: "cable" },
    ];
    const groups = groupSimilarRows(rows);
    expect(groups).toHaveLength(2);
  });
});
