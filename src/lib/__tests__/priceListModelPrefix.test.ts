import { describe, it, expect } from "vitest";
import {
  detectModelPrefix,
  applyModelPrefixMove,
  type ModelPrefixRow,
} from "../priceListModelPrefix";

const row = (
  description: string | null,
  modelNumber: string | null = null,
  partNumber = "P-1",
): ModelPrefixRow => ({ partNumber, modelNumber, description });

describe("detectModelPrefix", () => {
  it("detects a hyphenated SKU at the start of the description", () => {
    expect(detectModelPrefix(row("I600-4K8 black EU"))).toEqual({
      token: "I600-4K8",
      rest: "black EU",
    });
  });

  it("detects a SKU followed by a spaced dash separator", () => {
    expect(detectModelPrefix(row("Z48 - Older style clamping shockmount"))).toEqual({
      token: "Z48",
      rest: "Older style clamping shockmount",
    });
  });

  it("trims trailing punctuation from the token", () => {
    expect(detectModelPrefix(row("I600-4K8. black EU"))?.token).toBe("I600-4K8");
  });

  it("accepts the all-caps+digit SKU shape", () => {
    expect(detectModelPrefix(row("MASK6C ceiling speaker white"))?.token).toBe("MASK6C");
  });

  it("rejects plain words and spec-like leads", () => {
    expect(detectModelPrefix(row("Input Module HDMI HDBaseT Quad 3G"))).toBeNull();
    expect(detectModelPrefix(row("HDBaseT 3.0 input card"))).toBeNull(); // no digit in lead token
    expect(detectModelPrefix(row("ILD 0.37:1 UST 90° lens"))).toBeNull();
    expect(detectModelPrefix(row("4K UHD laser projector"))).toBeNull(); // too short
    expect(detectModelPrefix(row("Cat5e cable black 25'"))).toBeNull(); // mixed-case single digit
  });

  it("rejects when stripping would leave an empty description", () => {
    expect(detectModelPrefix(row("I600-4K8"))).toBeNull();
    expect(detectModelPrefix(row("I600-4K8   "))).toBeNull();
  });

  it("rejects when the Model Number column holds a DIFFERENT value", () => {
    expect(detectModelPrefix(row("I600-4K8 black EU", "OTHER-99"))).toBeNull();
  });

  it("accepts when the Model Number column already holds the same token", () => {
    expect(detectModelPrefix(row("I600-4K8 black EU", "i600-4k8"))?.token).toBe("I600-4K8");
  });

  it("accepts a lead token that echoes the part number", () => {
    expect(detectModelPrefix(row("R9400810EU projector body", null, "R9400810EU"))?.token).toBe(
      "R9400810EU",
    );
  });

  it("handles null/empty descriptions", () => {
    expect(detectModelPrefix(row(null))).toBeNull();
    expect(detectModelPrefix(row(""))).toBeNull();
  });
});

describe("applyModelPrefixMove", () => {
  it("moves the token to the Model Number column and strips it from the description", () => {
    const [moved] = applyModelPrefixMove([row("I600-4K8 black EU")]);
    expect(moved.modelNumber).toBe("I600-4K8");
    expect(moved.description).toBe("black EU");
  });

  it("keeps an existing equal Model Number value untouched while stripping the description", () => {
    const [moved] = applyModelPrefixMove([row("I600-4K8 black EU", "i600-4k8")]);
    expect(moved.modelNumber).toBe("i600-4k8");
    expect(moved.description).toBe("black EU");
  });

  it("leaves non-matching rows unchanged (same object)", () => {
    const original = row("Input module, HDMI, HDBaseT");
    const [out] = applyModelPrefixMove([original]);
    expect(out).toBe(original);
  });

  it("preserves extra row fields", () => {
    const input = { ...row("I600-4K8 black EU"), listPrice: 14305 };
    const [moved] = applyModelPrefixMove([input]);
    expect(moved.listPrice).toBe(14305);
  });
});
