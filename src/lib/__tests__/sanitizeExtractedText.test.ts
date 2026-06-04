import { describe, it, expect } from "vitest";
import { sanitizeExtractedCell } from "../sanitizeExtractedText";

const ch = (code: number) => String.fromCharCode(code);
const SOFT_HYPHEN = ch(0x00ad);
const REPLACEMENT = ch(0xfffd);
const PRIVATE_USE = ch(0xe001);
const NB_HYPHEN = ch(0x2011);
const EN_DASH = ch(0x2013);
const ZERO_WIDTH = ch(0x200b);
const NUL = ch(0x00);
const SUPER2 = ch(0x00b2);

describe("sanitizeExtractedCell", () => {
  it("turns a box glyph between alphanumerics back into a hyphen (line-wrapped code)", () => {
    expect(sanitizeExtractedCell(`TPC-ANDROID${SOFT_HYPHEN}PHONE`)).toBe("TPC-ANDROID-PHONE");
    expect(sanitizeExtractedCell(`TPC-ANDROID${REPLACEMENT}TABLT`)).toBe("TPC-ANDROID-TABLT");
    expect(sanitizeExtractedCell(`TPC-ITOUCH${PRIVATE_USE}PHONE`)).toBe("TPC-ITOUCH-PHONE");
  });

  it("normalises dash variants to a plain hyphen", () => {
    expect(sanitizeExtractedCell(`MSA${NB_HYPHEN}AMK2`)).toBe("MSA-AMK2");
    expect(sanitizeExtractedCell(`MSA${EN_DASH}RMK`)).toBe("MSA-RMK");
  });

  it("removes zero-width and control characters", () => {
    expect(sanitizeExtractedCell(`abc${ZERO_WIDTH}def`)).toBe("abcdef");
    expect(sanitizeExtractedCell(`TPC${NUL}IPAD`)).toBe("TPCIPAD");
  });

  it("drops a stray box glyph that is not between alphanumerics", () => {
    expect(sanitizeExtractedCell(`Foo ${REPLACEMENT} bar`)).toBe("Foo bar");
  });

  it("leaves normal text (including superscripts) untouched", () => {
    expect(sanitizeExtractedCell(`cd/m${SUPER2}`)).toBe(`cd/m${SUPER2}`);
    expect(sanitizeExtractedCell("  TPC-IPAD  ")).toBe("TPC-IPAD");
    expect(sanitizeExtractedCell("Standard part-number/A.1")).toBe("Standard part-number/A.1");
  });
});
