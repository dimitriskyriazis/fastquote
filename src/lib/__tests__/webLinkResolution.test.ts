import { describe, it, expect } from "vitest";
import {
  isRealWebLink,
  pageMatchStrength,
  normalizeIdentifier,
  normalizeHaystack,
  containsIdentifier,
  identifierAppearsInText,
  hostMatchesDomain,
  parseDomainReply,
  localePrefixIndex,
  parseRegionLangPrefix,
  buildRegionLangEnglishCandidates,
  parentDocSectionUrl,
  urlLanguageIsNonEnglish,
  urlDeclaresEnglish,
  isEnglishResult,
  pageLanguage,
  isUuidLikeSegment,
  isSupportCommunityPath,
  isArticleOrNewsPath,
  hasHeadlineSlug,
  looksLikeArticlePage,
  scoreCandidateUrl,
  extractPageContent,
  looksLikeSoftNotFound,
  isHomepageLanding,
  pageMatchesProduct,
  extractPartPrefix,
  chunkArray,
} from "../webLinkResolution";

describe("isRealWebLink", () => {
  it("accepts http(s) URLs", () => {
    expect(isRealWebLink("https://www.extron.com/product/x")).toBe(true);
    expect(isRealWebLink("http://www.akg.com/pro")).toBe(true);
  });
  it("rejects the placeholder debris and non-URLs", () => {
    expect(isRealWebLink("Link")).toBe(false);
    expect(isRealWebLink("link")).toBe(false);
    expect(isRealWebLink("")).toBe(false);
    expect(isRealWebLink(null)).toBe(false);
    expect(isRealWebLink(undefined)).toBe(false);
    expect(isRealWebLink("www.extron.com/product")).toBe(false); // no scheme
  });
});

describe("normalizeIdentifier / normalizeHaystack", () => {
  it("strips dots as well as spaces/hyphens/underscores", () => {
    expect(normalizeIdentifier("911.1520.900")).toBe("9111520900");
    expect(normalizeIdentifier("911-1520-900")).toBe("9111520900");
    expect(normalizeIdentifier("MX395W/O")).toBe("mx395wo");
  });
  it("haystack keeps slashes so segment boundaries survive", () => {
    expect(normalizeHaystack("/ecom-item/911-1520-900")).toBe("/ecomitem/9111520900");
  });
});

describe("containsIdentifier digit boundaries", () => {
  it("does not let X-100 match the X-1000 sibling page", () => {
    expect(containsIdentifier("/products/x1000/", "x100")).toBe(false);
    expect(containsIdentifier("/products/x100/", "x100")).toBe(true);
  });
  it("rejects matches inside longer digit runs", () => {
    expect(containsIdentifier("/p/21100/", "1100")).toBe(false);
  });
  it("allows letter neighbours (variant suffixes, merged extensions)", () => {
    expect(containsIdentifier("/hp1290ihtml", "hp1290i")).toBe(true);
    expect(containsIdentifier("/hp1290iwh/", "hp1290i")).toBe(true);
  });
  it("finds a later valid occurrence after an invalid one", () => {
    expect(containsIdentifier("x1000 x100!", "x100")).toBe(true);
  });
});

describe("identifierAppearsInText", () => {
  it("matches separator-insensitively for long identifiers", () => {
    expect(identifierAppearsInText("ecom-item 911.1520.900 spec sheet", "911-1520-900")).toBe(true);
    expect(identifierAppearsInText("SBC220 Charging Station", "sbc-220")).toBe(true);
  });
  it("uses word boundaries for short identifiers", () => {
    expect(identifierAppearsInText("the U3 loudspeaker", "U3")).toBe(true);
    expect(identifierAppearsInText("the US3000 battery", "U3")).toBe(false);
  });
});

describe("hostMatchesDomain", () => {
  it("requires a dot boundary", () => {
    expect(hostMatchesDomain("notsony.com", "sony.com")).toBe(false);
    expect(hostMatchesDomain("www.sony.com", "sony.com")).toBe(true);
    expect(hostMatchesDomain("products.biamp.com", "biamp.com")).toBe(true);
    expect(hostMatchesDomain("biamp.com", "biamp.com")).toBe(true);
  });
});

describe("parseDomainReply", () => {
  it("accepts bare domains and full URLs", () => {
    expect(parseDomainReply("extron.com")).toBe("extron.com");
    expect(parseDomainReply("https://www.sony.com/en")).toBe("sony.com");
    expect(parseDomainReply("grassvalley.com.")).toBe("grassvalley.com");
    expect(parseDomainReply("`dbaudio.com`")).toBe("dbaudio.com");
  });
  it("rejects refusals and chatty answers", () => {
    expect(parseDomainReply("NOT_FOUND")).toBeNull();
    expect(parseDomainReply("NOT_FOUND.")).toBeNull();
    expect(parseDomainReply("The domain is extron.com")).toBeNull();
    expect(parseDomainReply("")).toBeNull();
  });
});

describe("localePrefixIndex", () => {
  it("finds plain and prefixed locale segments", () => {
    expect(localePrefixIndex(["it-IT", "prodotti", "x"])).toBe(0);
    expect(localePrefixIndex(["global", "de", "products"])).toBe(1);
    expect(localePrefixIndex(["products", "x"])).toBe(-1);
  });
  it("does not mistake bare two-letter product paths for locales", () => {
    expect(localePrefixIndex(["tv", "xr-55"])).toBe(-1);
    expect(localePrefixIndex(["hp", "printers"])).toBe(-1);
    expect(localePrefixIndex(["av", "receivers"])).toBe(-1);
    expect(localePrefixIndex(["de", "produkte"])).toBe(0); // real language code still wins
    expect(localePrefixIndex(["en-US", "products"])).toBe(0);
  });
});

describe("isUuidLikeSegment", () => {
  it("recognises GUIDs and pipe-joined GUID filters", () => {
    expect(isUuidLikeSegment("327c3621-db53-4c33-9c4a-1234567890ab")).toBe(true);
    expect(isUuidLikeSegment("aaa|bbb")).toBe(true);
    expect(isUuidLikeSegment("ecom-item")).toBe(false);
  });
});

describe("support-community / article path classification", () => {
  it("recognises the Salesforce-community support app (portal records AND articles)", () => {
    expect(isSupportCommunityPath("/support/s/portalproduct/a2jpo000003qeugmam/105004000000")).toBe(true);
    expect(isSupportCommunityPath("/support/s/article/k2-summit-release-notes")).toBe(true);
    expect(isSupportCommunityPath("/global/en/products/amplifiers/5d")).toBe(false);
  });
  it("treats support-community records and generic news/blog as non-product pages", () => {
    // The Grass Valley portalproduct record is a bare service record, not a product page.
    expect(isArticleOrNewsPath("/support/s/portalproduct/a2jpo000003qeugmam/105004000000")).toBe(true);
    expect(isArticleOrNewsPath("/support/s/article/kaleido-ix-how-to")).toBe(true);
    expect(isArticleOrNewsPath("/news/2024/new-firmware")).toBe(true);
    expect(isArticleOrNewsPath("/blog/behind-the-scenes")).toBe(true);
    expect(isArticleOrNewsPath("/global/en/products/amplifiers/5d")).toBe(false);
  });
});

describe("parseRegionLangPrefix", () => {
  it("detects /{region}/{language}/ commerce prefixes (Keenfinity/Bosch)", () => {
    expect(parseRegionLangPrefix(["tw", "en", "Router", "p", "F.01U.396.303"])).toMatchObject({
      region: "tw",
      lang: "en",
      restIdx: 2,
    });
    expect(parseRegionLangPrefix(["tw", "tw", "Call-station"])).toMatchObject({ region: "tw", lang: "tw" });
    expect(parseRegionLangPrefix(["au", "en", "Controller"])).toMatchObject({ region: "au", lang: "en" });
  });
  it("does not misfire on two-letter product paths", () => {
    expect(parseRegionLangPrefix(["av", "hd", "receivers"])).toBeNull(); // neither region nor language
    expect(parseRegionLangPrefix(["products", "x"])).toBeNull();
    expect(parseRegionLangPrefix(["tv"])).toBeNull();
  });
});

describe("urlLanguageIsNonEnglish", () => {
  it("flags non-English URLs (single-locale and region/language)", () => {
    expect(urlLanguageIsNonEnglish("https://commerce.keenfinity.tech/it/it/Router/p/F.01U.396.303/")).toBe(true);
    expect(urlLanguageIsNonEnglish("https://www.shure.com/it-IT/prodotti/accessori/sbc220")).toBe(true);
    expect(urlLanguageIsNonEnglish("https://brand.com/fr/produits/x")).toBe(true);
  });
  it("passes English and locale-less URLs", () => {
    expect(urlLanguageIsNonEnglish("https://commerce.keenfinity.tech/it/en/Router/p/F.01U.396.303/")).toBe(false);
    expect(urlLanguageIsNonEnglish("https://www.shure.com/en-GB/products/accessories/sbc220")).toBe(false);
    expect(urlLanguageIsNonEnglish("https://www.dbaudio.com/global/en/products/all/series/u3/")).toBe(false);
    expect(urlLanguageIsNonEnglish("https://www.blackmagicdesign.com/products/teranexmini/techspecs/W-TERAMIN-08")).toBe(
      false,
    );
  });
});

describe("isEnglishResult", () => {
  it("rejects non-English URLs regardless of page language", () => {
    expect(isEnglishResult("https://commerce.keenfinity.tech/it/it/Router/p/F.01U.396.303/", "en")).toBe(false);
    expect(isEnglishResult("https://www.shure.com/it-IT/prodotti/x", "")).toBe(false);
  });
  it("trusts an explicitly-English URL even when the page mislabels its html lang", () => {
    // Keenfinity /it/en/ sometimes carries <html lang="it">; the /en/ path is authoritative.
    expect(isEnglishResult("https://commerce.keenfinity.tech/it/en/Router/p/F.01U.396.303/", "it")).toBe(true);
    expect(isEnglishResult("https://www.shure.com/en-GB/products/x", "en")).toBe(true);
  });
  it("falls back to page language for locale-less URLs", () => {
    expect(isEnglishResult("https://brand.com/products/x", "")).toBe(true); // unknown → assume English
    expect(isEnglishResult("https://brand.com/products/x", "en")).toBe(true);
    expect(isEnglishResult("https://brand.com/products/x", "it")).toBe(false);
  });
});

describe("urlDeclaresEnglish", () => {
  it("is true only for URLs with an explicit English locale segment", () => {
    expect(urlDeclaresEnglish("https://commerce.keenfinity.tech/it/en/Router/p/x/")).toBe(true);
    expect(urlDeclaresEnglish("https://www.shure.com/en-GB/products/x")).toBe(true);
    expect(urlDeclaresEnglish("https://commerce.keenfinity.tech/it/it/Router/p/x/")).toBe(false);
    expect(urlDeclaresEnglish("https://brand.com/products/x")).toBe(false); // locale-less
  });
});

describe("pageLanguage", () => {
  const base = { title: "", metaDescription: "", ogTitle: "", ogType: "", htmlLang: "", ogLocale: "", canonicalUrl: null, bodyText: "" };
  it("reads the language from <html lang> or og:locale", () => {
    expect(pageLanguage({ ...base, htmlLang: "it-it" })).toBe("it");
    expect(pageLanguage({ ...base, htmlLang: "en" })).toBe("en");
    expect(pageLanguage({ ...base, ogLocale: "it_it" })).toBe("it");
    expect(pageLanguage(base)).toBe("");
  });
  it("is populated by extractPageContent from the html tag", () => {
    const page = extractPageContent('<html lang="it-IT"><head><title>Router</title></head><body>x</body></html>');
    expect(page.htmlLang).toBe("it-it");
    expect(pageLanguage(page)).toBe("it");
  });
});

describe("buildRegionLangEnglishCandidates", () => {
  it("produces European-English first, then international (/xl/en/), then the original region", () => {
    const out = buildRegionLangEnglishCandidates(
      "https://commerce.keenfinity.tech/tw/tw/Call-station/p/F.01U.298.720/",
    );
    expect(out[0]).toBe("https://commerce.keenfinity.tech/eu/en/Call-station/p/F.01U.298.720/");
    expect(out).toContain("https://commerce.keenfinity.tech/gb/en/Call-station/p/F.01U.298.720/");
    // international English (Keenfinity's working /xl/en/ site) is included
    expect(out).toContain("https://commerce.keenfinity.tech/xl/en/Call-station/p/F.01U.298.720/");
    // keeps the trailing slash and falls back to the original region in English
    expect(out).toContain("https://commerce.keenfinity.tech/tw/en/Call-station/p/F.01U.298.720/");
    // the original Taiwanese URL is never proposed back
    expect(out).not.toContain("https://commerce.keenfinity.tech/tw/tw/Call-station/p/F.01U.298.720/");
  });
  it("returns nothing for URLs without a region/language prefix", () => {
    expect(buildRegionLangEnglishCandidates("https://brand.com/products/x")).toEqual([]);
  });
});

describe("parentDocSectionUrl", () => {
  it("strips a documentation sub-tab to the product landing page", () => {
    expect(parentDocSectionUrl("https://doc.haivision.com/Transmitters/5.4/Air/hardware-specifications")).toBe(
      "https://doc.haivision.com/Transmitters/5.4/Air",
    );
    expect(parentDocSectionUrl("https://doc.brand.com/product/x/release-notes")).toBe(
      "https://doc.brand.com/product/x",
    );
  });
  it("returns null for a normal product page (not a known sub-tab)", () => {
    expect(parentDocSectionUrl("https://doc.haivision.com/Transmitters/5.4/Air")).toBeNull();
    expect(parentDocSectionUrl("https://brand.com/products/ldx-c110")).toBeNull();
    expect(parentDocSectionUrl("https://brand.com/hardware-specifications")).toBeNull(); // no parent product segment
  });
});

describe("hasHeadlineSlug", () => {
  it("flags blog/press-release slugs that read like a headline", () => {
    // The exact Grass Valley blog post that leaked through as a product link.
    expect(
      hasHeadlineSlug(
        "https://www.grassvalley.com/ldx-110-and-ldx-c110-a-cost-efficient-camera-generation-for-demanding-productions-2/",
      ),
    ).toBe(true);
    expect(hasHeadlineSlug("https://brand.com/why-our-new-cameras-are-the-best-for-you/")).toBe(true);
  });
  it("does not flag real product slugs", () => {
    expect(hasHeadlineSlug("https://www.grassvalley.com/products/cameras/ldx-c110/")).toBe(false);
    expect(hasHeadlineSlug("https://www.blackmagicdesign.com/products/teranexmini/techspecs/W-TERAMIN-08")).toBe(false);
    expect(hasHeadlineSlug("https://ap.connect.panasonic.com/sg/en/products/projectors/pt-mz14kl")).toBe(false);
    expect(hasHeadlineSlug("https://brand.com/products/all-in-one-conference-camera-x200")).toBe(false);
  });
});

describe("looksLikeArticlePage", () => {
  const base = { title: "", metaDescription: "", ogTitle: "", ogType: "", htmlLang: "", ogLocale: "", canonicalUrl: null, bodyText: "" };
  it("flags pages whose OpenGraph type is article/blog even with a clean URL", () => {
    expect(looksLikeArticlePage({ ...base, ogType: "article" }, "https://brand.com/x")).toBe(true);
    expect(looksLikeArticlePage({ ...base, ogType: "blog" }, "https://brand.com/x")).toBe(true);
  });
  it("flags headline-slug URLs regardless of og:type", () => {
    expect(
      looksLikeArticlePage(base, "https://www.grassvalley.com/ldx-110-and-ldx-c110-a-cost-efficient-camera-generation-2/"),
    ).toBe(true);
  });
  it("passes real product pages", () => {
    expect(looksLikeArticlePage({ ...base, ogType: "product" }, "https://brand.com/products/ldx-c110")).toBe(false);
    expect(looksLikeArticlePage({ ...base, ogType: "website" }, "https://brand.com/products/ldx-c110")).toBe(false);
  });
});

describe("scoreCandidateUrl", () => {
  const ids = { modelNumber: "", partNumber: "911.1520.900", partPrefix: "" };

  it("no longer penalises the correct page when separators differ (dot vs hyphen)", () => {
    // Old behaviour: dot-vs-hyphen mismatch missed every bonus AND triggered the -8
    // wrong-product penalty, dropping the correct page below the score cutoff.
    const score = scoreCandidateUrl("https://biamp.com/ecom-item/911-1520-900", ids);
    expect(score).toBeGreaterThan(0);
  });

  it("still penalises a URL carrying a different product code", () => {
    const score = scoreCandidateUrl("https://biamp.com/ecom-item/911-9999-111", ids);
    expect(score).toBeLessThan(0);
  });

  it("scores query-string product URLs", () => {
    const score = scoreCandidateUrl("https://example.com/product.php?sku=911.1520.900", ids);
    expect(score).toBeGreaterThan(0);
  });

  it("prefers EU/UK English locales and penalises non-English", () => {
    const base = { modelNumber: "sbc220", partNumber: "", partPrefix: "" };
    const enGb = scoreCandidateUrl("https://www.shure.com/en-GB/products/accessories/sbc220", base);
    const enUs = scoreCandidateUrl("https://www.shure.com/en-US/products/accessories/sbc220", base);
    const itIt = scoreCandidateUrl("https://www.shure.com/it-IT/prodotti/accessori/sbc220", base);
    expect(enGb).toBeGreaterThan(enUs);
    expect(enUs).toBeGreaterThan(itIt);
  });

  it("prefers European-English over other-region English over non-English in /{region}/{lang}/ URLs", () => {
    const base = { modelNumber: "", partNumber: "F.01U.298.720", partPrefix: "" };
    const euEn = scoreCandidateUrl("https://commerce.keenfinity.tech/de/en/Call-station/p/F.01U.298.720/", base);
    const twEn = scoreCandidateUrl("https://commerce.keenfinity.tech/tw/en/Call-station/p/F.01U.298.720/", base);
    const twTw = scoreCandidateUrl("https://commerce.keenfinity.tech/tw/tw/Call-station/p/F.01U.298.720/", base);
    expect(euEn).toBeGreaterThan(twEn);
    expect(twEn).toBeGreaterThan(twTw);
  });

  it("penalises retail store/shop subdomains so a doc/spec page wins", () => {
    const ids = { modelNumber: "aw-ot-pb", partNumber: "AW-OT-PB", partPrefix: "" };
    const store = scoreCandidateUrl("https://store.haivision.com/products/aw-ot-pb", ids);
    const doc = scoreCandidateUrl("https://doc.haivision.com/Transmitters/5.4/Air/aw-ot-pb", ids);
    expect(doc).toBeGreaterThan(store);
  });

  it("does not misfire the wrong-code penalty on UUID category segments", () => {
    const score = scoreCandidateUrl(
      "https://products.biamp.com/product-details/-/o/category/327C3621-DB53-4C33-9C4A-1234567890AB/ecom-item/911-1520-900",
      ids,
    );
    expect(score).toBeGreaterThan(0);
  });

  it("drops Grass Valley community support pages below the cutoff, even when the URL carries the part number", () => {
    // The portalproduct record URL contains the normalized part number (1-0500400-0000 →
    // 105004000000), which would otherwise earn +6; the -20 support-community penalty keeps it
    // below the score>-5 cutoff so a general main-site page is preferred instead.
    const gvIds = { modelNumber: "ldx c110", partNumber: "1-0500400-0000", partPrefix: "" };
    const portalRecord = scoreCandidateUrl(
      "https://community.grassvalley.com/support/s/portalproduct/a2JPo000003qEUgMAM/105004000000",
      gvIds,
    );
    const article = scoreCandidateUrl(
      "https://community.grassvalley.com/support/s/article/ldx-c110-release-notes",
      gvIds,
    );
    expect(portalRecord).toBeLessThanOrEqual(-5);
    expect(article).toBeLessThanOrEqual(-5);
    // A real main-site product page still scores well above the cutoff.
    const mainSite = scoreCandidateUrl("https://www.grassvalley.com/products/cameras/ldx-c110/", gvIds);
    expect(mainSite).toBeGreaterThan(portalRecord);
  });

  it("does not penalise product slugs that merely contain listing words", () => {
    const base = { modelNumber: "sl200", partNumber: "", partPrefix: "" };
    const slugScore = scoreCandidateUrl("https://brand.com/products/searchlight-sl200", base);
    const searchScore = scoreCandidateUrl("https://brand.com/products/search", base);
    expect(slugScore).toBeGreaterThan(searchScore);
    expect(slugScore).toBeGreaterThan(0);
  });
});

describe("extractPageContent", () => {
  const html = `
    <html><head>
      <title>U3 Loudspeaker &amp; Mount — d&amp;b audiotechnik</title>
      <meta content="Spec page for Z5012.500 bracket" name="description">
      <meta property="og:title" content="Z5012.500 bracket" />
      <link href="https://www.dbaudio.com/global/en/products/z5012/" rel="canonical">
      <script>var x = "941.9999.999";</script>
      <style>.a{color:red}</style>
    </head><body><h1>Z5012.500</h1><p>Rigging &gt; brackets</p></body></html>`;

  it("extracts title, meta description, og:title, canonical (attribute order agnostic)", () => {
    const page = extractPageContent(html);
    expect(page.title).toBe("U3 Loudspeaker & Mount — d&b audiotechnik");
    expect(page.metaDescription).toBe("Spec page for Z5012.500 bracket");
    expect(page.ogTitle).toBe("Z5012.500 bracket");
    expect(page.canonicalUrl).toBe("https://www.dbaudio.com/global/en/products/z5012/");
  });

  it("strips scripts/styles from body text and decodes entities", () => {
    const page = extractPageContent(html);
    expect(page.bodyText).toContain("Z5012.500");
    expect(page.bodyText).toContain("Rigging > brackets");
    expect(page.bodyText).not.toContain("941.9999.999");
  });
});

describe("looksLikeSoftNotFound", () => {
  it("flags not-found titles", () => {
    expect(
      looksLikeSoftNotFound({
        title: "Page not found - Sony",
        metaDescription: "",
        ogTitle: "",
        ogType: "",
        htmlLang: "",
        ogLocale: "",
        canonicalUrl: null,
        bodyText: "",
      }),
    ).toBe(true);
    expect(
      looksLikeSoftNotFound({
        title: "404",
        metaDescription: "",
        ogTitle: "",
        ogType: "",
        htmlLang: "",
        ogLocale: "",
        canonicalUrl: null,
        bodyText: "",
      }),
    ).toBe(true);
  });
  it("passes normal product pages", () => {
    expect(
      looksLikeSoftNotFound({
        title: "SBC220 Charging Station - Shure",
        metaDescription: "",
        ogTitle: "",
        ogType: "",
        htmlLang: "",
        ogLocale: "",
        canonicalUrl: null,
        bodyText: "Dual-docking networked charging station",
      }),
    ).toBe(false);
  });
});

describe("isHomepageLanding", () => {
  it("flags a deep request landing on the site root", () => {
    expect(isHomepageLanding("https://x.com/products/abc", "https://x.com/")).toBe(true);
  });
  it("flags landing on a bare locale root", () => {
    expect(isHomepageLanding("https://x.com/products/abc", "https://x.com/en/")).toBe(true);
  });
  it("passes a real page (path or query)", () => {
    expect(isHomepageLanding("https://x.com/products/abc", "https://x.com/en/products/abc")).toBe(false);
    expect(isHomepageLanding("https://x.com/p?id=5", "https://x.com/p")).toBe(false);
  });
});

describe("pageMatchesProduct / pageMatchStrength", () => {
  const page = extractPageContent(
    "<html><head><title>Charging Station</title></head><body>The SBC220 charges two transmitters.</body></html>",
  );
  it("matches identifiers found in body text", () => {
    expect(pageMatchesProduct(page, "https://www.shure.com/x", ["SBC-220"])).toBe(true);
  });
  it("matches identifiers found only in the final URL", () => {
    expect(pageMatchesProduct(page, "https://www.shure.com/products/sbc220x", ["SBC220X"])).toBe(true);
  });
  it("fails when nothing matches", () => {
    expect(pageMatchesProduct(page, "https://www.shure.com/x", ["MXA920"])).toBe(false);
  });

  it("grades title/URL matches as strong", () => {
    const titled = extractPageContent(
      "<html><head><title>Z5802.001 U3 Horizontal bracket</title></head><body>specs</body></html>",
    );
    expect(pageMatchStrength(titled, "https://www.dbaudio.com/x", ["Z5802.001"])).toBe("strong");
    expect(pageMatchStrength(page, "https://www.dbaudio.com/accessories/z5802/", ["Z5802.001", "", "Z5802"])).toBe(
      "strong",
    );
  });

  it("grades a body-only match as weak — accessory part number listed on the parent product's page", () => {
    // The U3 loudspeaker page lists its bracket's part number in an accessories section;
    // that must NOT count as strong evidence that this page is the bracket's page.
    const parentPage = extractPageContent(
      "<html><head><title>U3 Loudspeaker — d&amp;b audiotechnik</title></head>" +
        "<body>Point source. Accessories: Z5802.001 Horizontal bracket white, Z5815.001 Bi10 bracket.</body></html>",
    );
    expect(
      pageMatchStrength(parentPage, "https://www.dbaudio.com/global/en/products/all/series/u-series/u3/", [
        "Z5802.001",
        "",
        "Z5802",
      ]),
    ).toBe("body");
  });

  it("grades no match as none", () => {
    expect(pageMatchStrength(page, "https://www.shure.com/x", ["MXA920"])).toBe("none");
  });
});

describe("extractPartPrefix", () => {
  it("extracts meaningful prefixes from dot- and hyphen-separated part numbers", () => {
    expect(extractPartPrefix("Z5012.500")).toBe("Z5012");
    expect(extractPartPrefix("BT9340-LG-LSAC")).toBe("BT9340");
  });
  it("returns empty for short or separator-free part numbers", () => {
    expect(extractPartPrefix("910-001390-00")).toBe(""); // "910" too short to be meaningful
    expect(extractPartPrefix("SBC220")).toBe("");
  });
});

describe("chunkArray", () => {
  it("chunks evenly and keeps the remainder", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkArray([], 5)).toEqual([]);
  });
});
