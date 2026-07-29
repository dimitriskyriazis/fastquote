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
  isSupportCommunityPath,
  isArticleOrNewsPath,
  isHelpPortalHost,
  hasHeadlineSlug,
  looksLikeArticlePage,
  extractPageContent,
  looksLikeSoftNotFound,
  isHomepageLanding,
  pageMatchesProduct,
  extractPartPrefix,
  stripPartOrderSuffix,
  extractSpecTokens,
  chunkArray,
  identifierMatchesAsToken,
  strongMatchSource,
  isContentlessShell,
  stripTrackingParams,
  normalizedUrlKey,
  urlLeafSegment,
  buildIndexSearchQueries,
  dedupeByUrlLeaf,
  isBetterVerification,
  titleLooksDead,
  isDistinctiveIdentifier,
  indexTitleConfirms,
  classifyShellCandidate,
  mergeCandidates,
  countProductsPerLink,
  buildLeafSwapCandidates,
  excerptAroundIdentifier,
  looksLikeAccessWall,
  stripPartLanguageSuffix,
  matchSpecificity,
  extractProductNameFromDescription,
  deriveUrlTemplate,
  applyUrlTemplate,
  englishAlternates,
  type ExtractedPage,
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
  const base = { title: "", h1: "", metaDescription: "", ogTitle: "", ogType: "", htmlLang: "", ogLocale: "", canonicalUrl: null, alternates: [], structuredIds: [], bodyText: "" };
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
  const base = {
    title: "",
    h1: "",
    metaDescription: "",
    ogTitle: "",
    ogType: "",
    htmlLang: "",
    ogLocale: "",
    canonicalUrl: null,
    alternates: [],
    structuredIds: [],
    bodyText: "",
  };
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
        alternates: [],
        structuredIds: [],
        h1: "",
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
        alternates: [],
        structuredIds: [],
        h1: "",
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
        alternates: [],
        structuredIds: [],
        h1: "",
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

describe("stripPartOrderSuffix", () => {
  it("strips a trailing pure-alpha order suffix so the core matches the manufacturer's title/URL", () => {
    expect(stripPartOrderSuffix("8660.034-RT")).toBe("8660.034"); // Rittal titles it "8660034"
    expect(stripPartOrderSuffix("12345-ABC")).toBe("12345");
  });
  it("leaves numeric/band variant suffixes and short cores intact", () => {
    expect(stripPartOrderSuffix("PVA-2P500")).toBe(""); // "2P500" is not pure-alpha
    expect(stripPartOrderSuffix("BLX14RE/SM31-K3E")).toBe(""); // "K3E" has a digit
    expect(stripPartOrderSuffix("SM58")).toBe(""); // nothing to strip
    expect(stripPartOrderSuffix("SM57-LCE")).toBe(""); // core "SM57" <5 chars; extractPartPrefix covers it
  });
});

describe("extractSpecTokens", () => {
  it("pulls the distinguishing dimensions from a Rittal-style description", () => {
    const tokens = extractSpecTokens("VX Base/plinth trim panel, side, H: 100 mm, for D: 800 mm");
    expect(tokens).toContain("100mm");
    expect(tokens).toContain("800mm");
  });
  it("captures NxM configuration codes and standalone wattage/voltage", () => {
    expect(extractSpecTokens("Power amplifier, 2x500W")).toContain("2x500");
    expect(extractSpecTokens("500W power amplifier")).toContain("500w");
    expect(extractSpecTokens("230V 50Hz supply")).toEqual(expect.arrayContaining(["230v", "50hz"]));
  });
  it("captures lengths, rack units, and channel/port counts", () => {
    expect(extractSpecTokens("5m U/UTP CAT6 patch cable")).toContain("5m");
    expect(extractSpecTokens("Rack tray 1U")).toContain("1u");
    expect(extractSpecTokens("8-channel Dante interface")).toContain("8-channel");
    expect(extractSpecTokens("16 port PoE switch")).toContain("16port");
  });
  it("returns nothing when the description has no distinctive spec (falls back to type match)", () => {
    expect(extractSpecTokens("Cardioid dynamic vocal microphone")).toEqual([]);
    expect(extractSpecTokens("")).toEqual([]);
  });
  it("does not treat a family code like CAT6 as a spec", () => {
    expect(extractSpecTokens("CAT6 U/UTP patch cable")).not.toContain("6");
  });
});

describe("chunkArray", () => {
  it("chunks evenly and keeps the remainder", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkArray([], 5)).toEqual([]);
  });
});

// --- Search-index tier (biamp, 2026-07-28) ---------------------------------------

describe("identifierMatchesAsToken", () => {
  it("accepts the model inside a search-result title", () => {
    expect(identifierMatchesAsToken("Desono SUB2201-BL", "SUB2201-BL")).toBe(true);
    expect(identifierMatchesAsToken("Voltera D 1200.8", "Voltera D 1200.8")).toBe(true);
    expect(identifierMatchesAsToken("Impera Tango", "Tango")).toBe(true);
  });
  it("tolerates separator differences", () => {
    expect(identifierMatchesAsToken("Community IS6 112W subwoofer", "IS6-112W")).toBe(true);
    expect(identifierMatchesAsToken("Voltera D 1200-2M", "Voltera D 1200.2M")).toBe(true);
  });
  it("matches a hyphenated rendering of an unhyphenated code", () => {
    // Allen & Heath's product page is titled "Qu-5 / Qu-5D" while the catalog part number is "QU5";
    // without this the product's own page was rejected as not naming it.
    expect(identifierMatchesAsToken("Qu-5 / Qu-5D • Allen & Heath", "QU5")).toBe(true);
    expect(identifierMatchesAsToken("SM-7-B microphone", "SM7B")).toBe(true);
  });
  it("stays strict at the boundaries despite the extra flexibility", () => {
    expect(identifierMatchesAsToken("Qu-5D mixer", "QU5D")).toBe(true);
    expect(identifierMatchesAsToken("Qu-16 mixer", "QU5")).toBe(false);
    expect(identifierMatchesAsToken("Desono MASK6CT-W", "MASK6C-W")).toBe(false);
    expect(identifierMatchesAsToken("Community IS6-112WR", "IS6-112W")).toBe(false);
    expect(identifierMatchesAsToken("X-1000 amplifier", "X100")).toBe(false);
  });
  it("rejects sibling variants that the loose matcher would accept", () => {
    // The whole point of this matcher: these are different products.
    expect(identifierMatchesAsToken("Community IS6-112WR", "IS6-112W")).toBe(false);
    expect(identifierMatchesAsToken("Desono MASK6CT-W", "MASK6C-W")).toBe(false);
    expect(identifierMatchesAsToken("Voltera D 1200.4", "Voltera D 1200.8")).toBe(false);
    expect(identifierAppearsInText("Community IS6-112WR", "IS6-112W")).toBe(true); // contrast
  });
  it("ignores empty and too-short identifiers", () => {
    expect(identifierMatchesAsToken("Desono SUB2201-BL", "")).toBe(false);
    expect(identifierMatchesAsToken("A2 amplifier", "A2")).toBe(false);
  });
});

describe("strongMatchSource", () => {
  const page = (over: Partial<ExtractedPage> = {}): ExtractedPage => ({
    title: "",
    metaDescription: "",
    ogTitle: "",
    ogType: "",
    htmlLang: "en",
    ogLocale: "",
    alternates: [],
    structuredIds: [],
    h1: "",
    canonicalUrl: null,
    bodyText: "",
    ...over,
  });

  it("reports 'page' when the site's own title names the product", () => {
    expect(
      strongMatchSource(page({ title: "Desono SUB2201-BL | Biamp" }), "https://x.com/p/1", ["SUB2201-BL"]),
    ).toBe("page");
  });
  it("reports 'url' when only the URL carries the identifier", () => {
    expect(strongMatchSource(page(), "https://x.com/ecom-item/910-01492", ["910-01492"])).toBe("url");
  });
  it("treats an echoed canonical as URL evidence, not page evidence", () => {
    // JS-only catalogs echo the requested path into <link rel="canonical">, so a URL
    // pattern-filled from our part number would otherwise 'confirm' itself.
    expect(
      strongMatchSource(page({ canonicalUrl: "https://x.com/ecom-item/999-99999-99999" }), "https://x.com/ecom-item/999-99999-99999", [
        "999-99999-99999",
      ]),
    ).toBe("url");
  });
  it("returns null with no match anywhere", () => {
    expect(strongMatchSource(page({ title: "Loudspeakers" }), "https://x.com/shop", ["910-01492"])).toBe(null);
  });
});

describe("isContentlessShell", () => {
  const shell: ExtractedPage = {
    title: "Product Details - products.biamp.com",
    metaDescription: "",
    ogTitle: "",
    ogType: "website",
    htmlLang: "en-us",
    ogLocale: "",
    alternates: [],
    structuredIds: [],
    h1: "",
    canonicalUrl: null,
    bodyText: "Product Details Skip to Main Content Credit Card ".repeat(10), // ~480 chars
  };
  it("flags a client-rendered shell", () => {
    expect(isContentlessShell(shell)).toBe(true);
  });
  it("does not flag a page with real copy", () => {
    expect(isContentlessShell({ ...shell, bodyText: "x".repeat(2000) })).toBe(false);
  });
  it("does not flag a short page that still has a meta description", () => {
    expect(isContentlessShell({ ...shell, metaDescription: "Biamp Voltera amplifiers deliver…" })).toBe(false);
  });
});

describe("stripTrackingParams", () => {
  it("removes click ids but keeps real routing params", () => {
    expect(stripTrackingParams("https://x.com/p/910-01880?fbclid=abc")).toBe("https://x.com/p/910-01880");
    expect(stripTrackingParams("https://x.com/p?variantId=7&utm_source=news&_ga=2.1")).toBe(
      "https://x.com/p?variantId=7",
    );
  });
  it("leaves clean URLs and unparseable input alone", () => {
    expect(stripTrackingParams("https://x.com/p/1")).toBe("https://x.com/p/1");
    expect(stripTrackingParams("not a url")).toBe("not a url");
  });
  it("drops basket state a site appends to its own redirect", () => {
    // soundtube.com redirects an exact-part URL to itself with ?quantity=1 attached.
    expect(stripTrackingParams("https://www.soundtube.com/sd1-br16-r?quantity=1")).toBe(
      "https://www.soundtube.com/sd1-br16-r",
    );
  });
});

describe("normalizedUrlKey / urlLeafSegment", () => {
  it("ignores www, trailing slash and case", () => {
    expect(normalizedUrlKey("https://WWW.Biamp.com/Products/X/")).toBe("biamp.com/products/x");
    expect(normalizedUrlKey("https://biamp.com/products/x")).toBe(
      normalizedUrlKey("https://www.biamp.com/products/x/"),
    );
  });
  it("treats a meaningful query as part of the page identity", () => {
    // Catalogs that address a variant by query must not collapse into one page: that would let an
    // indexed sibling vouch for a URL the index never listed, and would flag two correct
    // per-variant links as one shared page.
    expect(normalizedUrlKey("https://x.com/p?variantId=7")).not.toBe(normalizedUrlKey("https://x.com/p?variantId=8"));
    expect(normalizedUrlKey("https://x.com/p?variantId=7")).not.toBe(normalizedUrlKey("https://x.com/p"));
  });
  it("is insensitive to parameter order", () => {
    expect(normalizedUrlKey("https://x.com/p?b=2&a=1")).toBe(normalizedUrlKey("https://x.com/p?a=1&b=2"));
  });
  it("extracts the product leaf", () => {
    expect(urlLeafSegment("https://x.com/product-details/-/o/ecom-item/910-01492")).toBe("910-01492");
    expect(urlLeafSegment("https://x.com/")).toBe("");
  });
});

describe("buildIndexSearchQueries", () => {
  it("leads with the quoted model name, not the order code", () => {
    const queries = buildIndexSearchQueries({
      brand: "biamp",
      modelNumber: "Voltera D 1200.8",
      partNumber: "920-01956-00002",
      domain: "biamp.com",
    });
    expect(queries[0]).toBe('site:biamp.com "Voltera D 1200.8"');
    expect(queries[1]).toBe('biamp "Voltera D 1200.8"');
    expect(queries.length).toBeLessThanOrEqual(3);
  });
  it("falls back to the part number when there is no model", () => {
    expect(
      buildIndexSearchQueries({ brand: "biamp", modelNumber: "", partNumber: "910-01492", domain: "biamp.com" }),
    ).toEqual(['site:biamp.com "910-01492"']);
  });
  it("searches the base part number ahead of the full order code, within the query cap", () => {
    const queries = buildIndexSearchQueries({
      brand: "Rittal",
      modelNumber: "",
      partNumber: "8660.034-RT",
      partNumberCore: "8660.034",
      domain: "rittal.com",
    });
    expect(queries).toEqual(['site:rittal.com "8660.034"', 'site:rittal.com "8660.034-RT"']);
  });
  it("drops the site:-scoped queries when there is no domain, keeping the open-web one", () => {
    expect(
      buildIndexSearchQueries({ brand: "biamp", modelNumber: "Tango", partNumber: "910-01880", domain: "" }),
    ).toEqual(['biamp "Tango"']);
  });
});

describe("dedupeByUrlLeaf", () => {
  it("collapses two routes to the same SKU, keeping the better-ranked (first) one", () => {
    const first = "https://p.biamp.com/product-details/-/o/category/214EE9B5%7CC33E850A/cn/Subwoofers/ecom-item/910-01492";
    const out = dedupeByUrlLeaf([{ link: first }, { link: "https://p.biamp.com/product-details/-/o/ecom-item/910-01492" }]);
    // Ranking carries relevance and language preference; a shorter string does not.
    expect(out).toEqual([{ link: first }]);
  });
  it("does not collapse different products or generic tails", () => {
    const out = dedupeByUrlLeaf([
      { link: "https://x.com/ecom-item/910-01492" },
      { link: "https://x.com/ecom-item/910-01880" },
      { link: "https://x.com/shop/ecom-product-page/2" },
      { link: "https://x.com/other/ecom-product-page/2" },
    ]);
    expect(out).toHaveLength(4);
  });
  it("never collapses across hosts — a docs site is not the product page", () => {
    const out = dedupeByUrlLeaf([
      { link: "https://www.shure.com/en-GB/products/microphones/sm7b-2024" },
      { link: "https://pubs.shure.com/guide/sm7b-2024" },
    ]);
    expect(out).toHaveLength(2);
  });
  it("never collapses a docs/support path onto a product path", () => {
    const out = dedupeByUrlLeaf([
      { link: "https://x.com/products/mask6c-w1" },
      { link: "https://x.com/support/mask6c-w1" },
      { link: "https://x.com/downloads/mask6c-w1" },
    ]);
    expect(out).toHaveLength(3);
  });
  it("leaves word-only slugs alone (no digit ⇒ not a SKU)", () => {
    const out = dedupeByUrlLeaf([
      { link: "https://x.com/products/voltera" },
      { link: "https://x.com/families/voltera" },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("titleLooksDead", () => {
  it("rejects the dead-SKU titles the index really returns", () => {
    // Real Google results for products.biamp.com, 2026-07-28.
    expect(titleLooksDead("920-01955-00001 - item not found or not available")).toBe(true);
    expect(titleLooksDead("910-10359 - item not found or not available")).toBe(true);
    expect(titleLooksDead("ecom.product_detail.description.item_dash_not_found")).toBe(true);
    expect(titleLooksDead("Page not found")).toBe(true);
  });
  it("keeps live product titles", () => {
    expect(titleLooksDead("Voltera D 1200.8")).toBe(false);
    expect(titleLooksDead("Desono SUB2201-BL")).toBe(false);
    expect(titleLooksDead("Product Details - products.biamp.com")).toBe(false);
    expect(titleLooksDead("")).toBe(false);
  });
});

describe("isDistinctiveIdentifier", () => {
  it("accepts codes with digits and long words, rejects short range names", () => {
    expect(isDistinctiveIdentifier("IS6-112W")).toBe(true);
    expect(isDistinctiveIdentifier("Tango")).toBe(true); // 5 chars
    expect(isDistinctiveIdentifier("SM7B")).toBe(true); // has a digit
    expect(isDistinctiveIdentifier("Air")).toBe(false);
    expect(isDistinctiveIdentifier("One")).toBe(false);
    expect(isDistinctiveIdentifier("")).toBe(false);
  });
  it("rejects category words that live in the ModelNumber column", () => {
    // 468 of Soundtube's 469 rows carry the model "Accessory"; two of them were "confirmed" by a
    // search result whose title contained that word.
    expect(isDistinctiveIdentifier("Accessory")).toBe(false);
    expect(isDistinctiveIdentifier("accessories")).toBe(false);
    expect(isDistinctiveIdentifier("Cable")).toBe(false);
    expect(isDistinctiveIdentifier("Bracket")).toBe(false);
    expect(isDistinctiveIdentifier("Various")).toBe(false);
    expect(isDistinctiveIdentifier("N/A")).toBe(false);
    expect(isDistinctiveIdentifier("Software")).toBe(false);
    // ...but a real code that merely contains such a word is still fine.
    expect(isDistinctiveIdentifier("CABLE-2M-BLK")).toBe(true);
  });
});

describe("parentDocSectionUrl: product sub-tabs", () => {
  it("prefers the product page over its resources/downloads tab", () => {
    expect(parentDocSectionUrl("https://www.allen-heath.com/hardware/qu/qu-5-qu-5d/resources/")).toBe(
      "https://www.allen-heath.com/hardware/qu/qu-5-qu-5d",
    );
    expect(parentDocSectionUrl("https://brand.com/products/x900/downloads")).toBe("https://brand.com/products/x900");
  });
  it("leaves a product page alone", () => {
    expect(parentDocSectionUrl("https://www.allen-heath.com/hardware/qu/qu-5-qu-5d")).toBeNull();
  });
});

describe("isHelpPortalHost", () => {
  it("recognises help portals by subdomain, which the path check missed", () => {
    expect(isHelpPortalHost("q-syshelp.qsc.com")).toBe(true);
    expect(isHelpPortalHost("help.brand.com")).toBe(true);
    expect(isHelpPortalHost("knowledge.brand.com")).toBe(true);
  });
  it("recognises user forums by subdomain — the reported false positive", () => {
    // forums.allen-heath.com/t/new-qu5-issues-with-recording-and-playback/30343 was accepted as a
    // product page because the thread quoted the part number.
    expect(isHelpPortalHost("forums.allen-heath.com")).toBe(true);
    expect(isHelpPortalHost("community.brand.com")).toBe(true);
    expect(isHelpPortalHost("discuss.brand.com")).toBe(true);
  });
  it("rejects the Discourse thread path shape on any host", () => {
    expect(isArticleOrNewsPath("/t/new-qu5-issues-with-recording-and-playback/30343")).toBe(true);
    // …but not a product path that merely starts with a short segment.
    expect(isArticleOrNewsPath("/t/products/ani4in")).toBe(false);
  });
  it("leaves product and documentation hosts alone", () => {
    expect(isHelpPortalHost("www.qsc.com")).toBe(false);
    expect(isHelpPortalHost("products.biamp.com")).toBe(false);
    // A doc site can be the best available product page (Haivision), so it must not be excluded.
    expect(isHelpPortalHost("doc.haivision.com")).toBe(false);
    // The registrable domain is never judged — a brand may simply be named this.
    expect(isHelpPortalHost("www.helpsystems.com")).toBe(false);
  });
});

describe("isArticleOrNewsPath: forum threads", () => {
  it("rejects the user-forum thread a measured run offered as a product link", () => {
    expect(isArticleOrNewsPath("/home/forum/pro-tools-post-production/post-surround-video/148815-post-facility")).toBe(
      true,
    );
    expect(isArticleOrNewsPath("/showthread.php")).toBe(true);
    expect(isArticleOrNewsPath("/forums/general-discussion/12345-topic")).toBe(true);
  });
  it("does not reject product paths that merely contain similar words", () => {
    expect(isArticleOrNewsPath("/products/forum-collaboration-suite-tables/fm-tre-0662730-a3g")).toBe(false);
  });
});

describe("isArticleOrNewsPath: help-centre pages", () => {
  it("rejects the help/licensing page a measured run wrongly accepted", () => {
    expect(isArticleOrNewsPath("/help/content/core_management/licensing.htm")).toBe(true);
    expect(isArticleOrNewsPath("/faq/how-to-mount")).toBe(true);
  });
  it("still allows documentation-site product pages", () => {
    // Haivision's doc site can be the best available product page; only /help/ and /faq/ are out.
    expect(isArticleOrNewsPath("/docs/haivision/air/hardware-specifications")).toBe(false);
    expect(isArticleOrNewsPath("/documentation/makito-x4")).toBe(false);
  });
});

describe("indexTitleConfirms", () => {
  it("confirms when the leading title segment names the product", () => {
    expect(indexTitleConfirms("Desono SUB2201-BL", ["SUB2201-BL"])).toBe(true);
    expect(indexTitleConfirms("Voltera D 1200.8 | Biamp", ["Voltera D 1200.8"])).toBe(true);
    expect(indexTitleConfirms("Impera Tango - Biamp Control", ["Tango"])).toBe(true);
  });
  it("refuses accessory/compatibility listings that merely mention the model", () => {
    expect(indexTitleConfirms("CLICKMOUNT bracket for MASK6C-W", ["MASK6C-W"])).toBe(false);
    expect(indexTitleConfirms("Spare grille compatible with SUB2201-BL", ["SUB2201-BL"])).toBe(false);
    expect(indexTitleConfirms("Voltera D 1200.8 vs D 2400.8", ["Voltera D 1200.8"])).toBe(false);
  });
  it("refuses matches that only appear after the leading segment", () => {
    expect(indexTitleConfirms("Loudspeakers | Surface Mount | MASK6C-W", ["MASK6C-W"])).toBe(false);
  });
  it("refuses sibling variants and non-distinctive identifiers", () => {
    expect(indexTitleConfirms("Desono MASK6CT-W", ["MASK6C-W"])).toBe(false);
    expect(indexTitleConfirms("Air control panel", ["Air"])).toBe(false);
    expect(indexTitleConfirms("", ["SUB2201-BL"])).toBe(false);
  });
});

describe("classifyShellCandidate", () => {
  const ids = ["920-01956-00002", "Voltera D 1200.8"];

  it("rejects a shell the index never listed — the fabricated-URL case", () => {
    expect(
      classifyShellCandidate({
        indexHit: null,
        identifiers: ids,
        url: "https://products.biamp.com/product-details/-/o/ecom-item/920-01956-00002",
      }),
    ).toBe("no-witness");
  });
  it("accepts when the index title names the model, even though the URL carries a different SKU", () => {
    expect(
      classifyShellCandidate({
        indexHit: { title: "Voltera D 1200.8" },
        identifiers: ids,
        url: "https://products.biamp.com/product-details/-/o/cn/Voltera-Amplifiers/ecom-item/920-01956-00001",
      }),
    ).toBe("index");
  });
  it("accepts when the indexed URL itself carries the part number", () => {
    expect(
      classifyShellCandidate({
        indexHit: { title: "Product Details - products.biamp.com" },
        identifiers: ["910-01880", "Tango"],
        url: "https://products.biamp.com/product-details/-/o/cn/Touch-Panel-Controllers/ecom-item/910-01880",
      }),
    ).toBe("index");
  });
  it("rejects a SKU the index lists as dead", () => {
    expect(
      classifyShellCandidate({
        indexHit: { title: "920-01955-00001 - item not found or not available" },
        identifiers: ["920-01955-00001"],
        url: "https://products.biamp.com/product-details/-/o/ecom-item/920-01955-00001",
      }),
    ).toBe("dead-item");
  });
  it("rejects a shell whose only witness describes another product", () => {
    expect(
      classifyShellCandidate({
        indexHit: { title: "Desono MASK6CT-W" },
        identifiers: ["930-00641-00002", "MASK6C-W"],
        url: "https://products.biamp.com/product-details/-/o/ecom-item/930-00641-00004",
      }),
    ).toBe("not-about-product");
  });
});

describe("mergeCandidates", () => {
  const identifiers = ["910-01492", "SUB2201-BL"];

  it("ranks an indexed URL carrying the part number first, then a proposal that does", () => {
    const merged = mergeCandidates({
      indexHits: [
        { link: "https://p.biamp.com/shop/-/o/category/x", title: "Subwoofers" },
        { link: "https://p.biamp.com/product-details/-/o/ecom-item/910-01492", title: "Desono SUB2201-BL" },
      ],
      proposals: [
        { link: "https://www.biamp.com/products/families/desono" },
        { link: "https://www.biamp.com/p/910-01492" },
      ],
      identifiers,
      maxIndex: 5,
      maxProposals: 3,
      max: 8,
    });
    expect(merged.map((c) => c.link)).toEqual([
      "https://p.biamp.com/product-details/-/o/ecom-item/910-01492", // index + URL has the part
      "https://www.biamp.com/p/910-01492", // proposal + URL has the part
      "https://p.biamp.com/shop/-/o/category/x", // remaining index hit
      "https://www.biamp.com/products/families/desono", // remaining proposal
    ]);
  });

  it("ranks a title-confirmed index hit above unconfirmed ones", () => {
    const merged = mergeCandidates({
      indexHits: [
        { link: "https://p.biamp.com/a", title: "Loudspeakers" },
        { link: "https://p.biamp.com/b", title: "Desono SUB2201-BL" },
      ],
      proposals: [],
      identifiers,
      maxIndex: 5,
      maxProposals: 3,
      max: 8,
    });
    expect(merged[0].link).toBe("https://p.biamp.com/b");
  });

  it("keeps proposal slots even when the index returns more hits than the cap", () => {
    const merged = mergeCandidates({
      indexHits: Array.from({ length: 8 }, (_, i) => ({ link: `https://p.biamp.com/i${i}`, title: "Subwoofers" })),
      proposals: [{ link: "https://www.biamp.com/products/families/desono" }],
      identifiers,
      maxIndex: 5,
      maxProposals: 3,
      max: 8,
    });
    expect(merged.filter((c) => c.fromIndex)).toHaveLength(5);
    expect(merged.filter((c) => !c.fromIndex)).toHaveLength(1);
  });

  it("dedupes across sources by URL identity", () => {
    const merged = mergeCandidates({
      indexHits: [{ link: "https://p.biamp.com/x/", title: "Desono SUB2201-BL" }],
      proposals: [{ link: "https://www.p.biamp.com/x" }],
      identifiers,
      maxIndex: 5,
      maxProposals: 3,
      max: 8,
    });
    expect(merged).toHaveLength(1);
  });
});

describe("h1 extraction and dead-page detection", () => {
  it("reads the h1 and uses it to spot a client-rendered dead SKU", () => {
    // Shape of a fabricated biamp SKU after rendering: generic <title>, the bad news in the h1,
    // and the phrase far past the first 300 characters of body text.
    const page = extractPageContent(
      `<html lang="en-US"><head><title>Product Details - products.biamp.com</title></head><body>` +
        `<nav>${"Log In Username Password Remember Me Forgot Password ".repeat(12)}</nav>` +
        `<h1 class="x">999-99999-99999 - ITEM NOT FOUND OR NOT AVAILABLE</h1></body></html>`,
    );
    expect(page.h1).toBe("999-99999-99999 - ITEM NOT FOUND OR NOT AVAILABLE");
    expect(looksLikeSoftNotFound(page)).toBe(true);
  });
  it("treats a rendered product page as live and lets its h1 carry page evidence", () => {
    const page = extractPageContent(
      `<html lang="en-US"><head><title>Desono MASK6C-W</title></head><body><h1>Desono MASK6C-W</h1></body></html>`,
    );
    expect(looksLikeSoftNotFound(page)).toBe(false);
    expect(strongMatchSource(page, "https://p.biamp.com/x/ecom-item/930-00641-00002", ["MASK6C-W"])).toBe("page");
  });
});

describe("structured data (JSON-LD) identity", () => {
  it("reads the part number out of JSON-LD, where some manufacturers publish it only", () => {
    // Extron's product pages are TITLED with a descriptive name; the order code lives in JSON-LD, so
    // without reading it the page could be accepted on a name match with the code never checked.
    const page = extractPageContent(
      `<html lang="en"><head><title>RJ-11 / RJ-45 Bezel Kit - Architectural Connectivity | Extron</title>` +
        `<script type="application/ld+json">{"@type":"ProductGroup","hasVariant":[{"@type":"Product",` +
        `"name":"RJ-11 / RJ-45 Bezel Kit","sku":"70-201-01"}]}</script></head><body></body></html>`,
    );
    expect(page.structuredIds).toContain("70-201-01");
    // …and that makes the page-side match a real CODE match, not just a name match.
    expect(strongMatchSource(page, "https://www.extron.com/product/aapbezelkit", ["70-201-01"])).toBe("page");
  });
  it("survives a truncated or invalid JSON-LD block", () => {
    const page = extractPageContent(
      `<html><head><script type="application/ld+json">{"@type":"Product","sku":"ABC-123","broken`,
    );
    expect(page.structuredIds).toEqual([]);
  });
  it("collects sku, mpn and productID", () => {
    const page = extractPageContent(
      `<html><head><script type="application/ld+json">{"sku":"S-1","mpn":"M-2","productID":"P-3"}</script></head></html>`,
    );
    expect(page.structuredIds).toEqual(["S-1", "M-2", "P-3"]);
  });
});

describe("buildIndexSearchQueries: family prefix", () => {
  it("adds a prefix query as the last resort, since some parts only have a base-code page", () => {
    // d&b sells Z5815.001 (white) and .000 (black) but publishes one page: /accessories/z5815/.
    const queries = buildIndexSearchQueries({
      brand: "d&b audiotechnik",
      modelNumber: "",
      partNumber: "Z5815.001",
      partNumberCore: "",
      partPrefix: "Z5815",
      domain: "dbaudio.com",
    });
    expect(queries).toContain('site:dbaudio.com "Z5815"');
    expect(queries.indexOf('site:dbaudio.com "Z5815"')).toBeGreaterThan(0); // never first
  });
});

describe("extractProductNameFromDescription", () => {
  it("mines the name from the front of a real description", () => {
    // Real rows from the 2026-07-29 batch, where ModelNumber was empty or useless.
    expect(
      extractProductNameFromDescription(
        "EW-DP ENG SET (U1/5) Portable digital wireless set. Includes (1) EW-DP EK receiver, (1) EW-D SK…",
      ),
    ).toBe("EW-DP ENG SET (U1/5)");
    // Stops at the first prose word: the code is the searchable part, "Corner Mount Bracket" is copy.
    expect(extractProductNameFromDescription("SM1001p Corner Mount Bracket")).toBe("SM1001p");
    expect(
      extractProductNameFromDescription(
        "WG433 ACSR MediaCentral | Production Management System Support, 5 days onsite & EXAMS",
      ),
    ).toBe("WG433 ACSR MediaCentral");
  });
  it("returns nothing when the description opens with prose instead of a code", () => {
    // Better to give the search no name than a meaningless one; these rows have a ModelNumber anyway.
    expect(extractProductNameFromDescription('Passive 10" subwoofer, 4 ohms / 250 watts, black')).toBe("");
  });
  it("returns nothing when there is no name to mine", () => {
    expect(extractProductNameFromDescription("")).toBe("");
    expect(extractProductNameFromDescription("accessory")).toBe("");
    expect(extractProductNameFromDescription("a kit")).toBe("");
  });
});

describe("deriveUrlTemplate / applyUrlTemplate", () => {
  it("learns a brand's URL shape from a link that verified", () => {
    const tpl = deriveUrlTemplate(
      "https://www.belden.com/products/patch-cords/fiber-patch-cords/fp5lulu002m",
      "FP5LULU002M",
    );
    expect(tpl).toEqual({
      template: "https://www.belden.com/products/patch-cords/fiber-patch-cords/{part}",
      transform: "lower",
    });
    expect(applyUrlTemplate(tpl!, "FP5LULU003M")).toBe(
      "https://www.belden.com/products/patch-cords/fiber-patch-cords/fp5lulu003m",
    );
  });
  it("handles separator-stripped and as-is codes", () => {
    expect(deriveUrlTemplate("https://x.com/p/ecom-item/930-00641-00002", "930-00641-00002")?.transform).toBe("raw");
    expect(deriveUrlTemplate("https://x.com/p/8660034", "8660.034")?.transform).toBe("strip");
  });
  it("replaces only the last occurrence, so a category segment cannot corrupt the template", () => {
    const tpl = deriveUrlTemplate("https://x.com/sm7b/products/sm7b", "SM7B");
    expect(tpl?.template).toBe("https://x.com/sm7b/products/{part}");
  });
  it("returns null when the URL does not carry the part number", () => {
    expect(deriveUrlTemplate("https://x.com/products/some-slug", "FP5LULU002M")).toBeNull();
    expect(deriveUrlTemplate("https://x.com/p/abc", "ab")).toBeNull();
  });
});

describe("englishAlternates", () => {
  const page = (alternates: Array<{ hreflang: string; href: string }>): ExtractedPage => ({
    title: "",
    h1: "",
    metaDescription: "",
    ogTitle: "",
    ogType: "",
    htmlLang: "de",
    ogLocale: "",
    canonicalUrl: null,
    structuredIds: [],
    alternates,
    bodyText: "",
  });
  it("prefers European English, then generic, then other English regions", () => {
    expect(
      englishAlternates(
        page([
          { hreflang: "en-US", href: "/en-us/p" },
          { hreflang: "de-DE", href: "/de-de/p" },
          { hreflang: "en-GB", href: "/en-gb/p" },
          { hreflang: "en", href: "/en/p" },
        ]),
        "https://brand.com/de-de/p",
      ),
    ).toEqual(["https://brand.com/en-gb/p", "https://brand.com/en/p", "https://brand.com/en-us/p"]);
  });
  it("resolves relative hrefs and drops the page itself", () => {
    expect(englishAlternates(page([{ hreflang: "en-GB", href: "https://brand.com/de/p" }]), "https://brand.com/de/p")).toEqual(
      [],
    );
  });
  it("ignores non-English alternates", () => {
    expect(englishAlternates(page([{ hreflang: "fr-FR", href: "/fr/p" }]), "https://brand.com/de/p")).toEqual([]);
  });
});

describe("stripPartLanguageSuffix", () => {
  it("strips a price-list language suffix that no manufacturer publishes", () => {
    expect(stripPartLanguageSuffix("2550-00020-00_EN")).toBe("2550-00020-00");
    expect(stripPartLanguageSuffix("ABC-123_de")).toBe("ABC-123");
  });
  it("leaves real codes alone", () => {
    expect(stripPartLanguageSuffix("2550-00020-00")).toBe("");
    expect(stripPartLanguageSuffix("NE8MXR1-B-TOP-D")).toBe(""); // hyphen, not underscore
    expect(stripPartLanguageSuffix("SD1_EN16")).toBe(""); // not a trailing suffix
  });
});

describe("matchSpecificity", () => {
  const ids = { partNumber: "SD1-BR16-R", modelNumber: "", partCore: "SD1-BR16", partPrefix: "SD1" };
  it("reports 'exact' when the full part or the model is named", () => {
    expect(matchSpecificity("SD1-BR16-R Rear On-Center Bracket", ids)).toBe("exact");
    expect(matchSpecificity("Desono SUB2201-BL", { modelNumber: "SUB2201-BL" })).toBe("exact");
  });
  it("reports 'core' when only the suffix-stripped code matches — the sibling risk", () => {
    // The real failure: soundtube.com/sd1-br16 is titled "SD1-BR16", a DIFFERENT bracket.
    expect(matchSpecificity("SD1-BR16 On-Center Drywall Bracket", ids)).toBe("core");
  });
  it("reports 'prefix' when only the family code matches — a base-code page at best", () => {
    expect(matchSpecificity("SD1 series brackets", { partNumber: "SD1-BR16-R", partPrefix: "SD1" })).toBe("prefix");
  });
  it("reports null when nothing matches", () => {
    expect(matchSpecificity("Loudspeakers", ids)).toBe(null);
  });
});

describe("looksLikeAccessWall", () => {
  const page = (title: string, h1 = ""): ExtractedPage => ({
    title,
    h1,
    metaDescription: "",
    ogTitle: "",
    ogType: "",
    htmlLang: "en",
    ogLocale: "",
    alternates: [],
    structuredIds: [],
    canonicalUrl: null,
    bodyText: "",
  });
  it("recognises the walls that a brand check would otherwise read as proof", () => {
    // Real titles seen 2026-07-29: Cloudflare on belden.com/barco.com/akg.com, and pro.sony.
    expect(looksLikeAccessWall(page("Just a moment..."))).toBe(true);
    expect(looksLikeAccessWall(page("Access Denied"))).toBe(true);
    expect(looksLikeAccessWall(page("Attention Required! | Cloudflare"))).toBe(true);
    expect(looksLikeAccessWall(page("", "Checking your browser before accessing"))).toBe(true);
  });
  it("leaves real pages alone", () => {
    expect(looksLikeAccessWall(page("Barco | Inspired sight and sharing solutions"))).toBe(false);
    expect(looksLikeAccessWall(page("Desono MASK6C-W", "Desono MASK6C-W"))).toBe(false);
  });
});

describe("buildLeafSwapCandidates", () => {
  it("takes a sibling's real catalog URL and swaps in our part number, simplest shape first", () => {
    const out = buildLeafSwapCandidates({
      indexedUrls: [
        "https://products.biamp.com/product-details/-/o/category/214EE9B5%7CC33E850A/cn/Surface-Mount/ecom-item/930-00641-00003",
        "https://products.biamp.com/product-details/-/o/ecom-item/930-00641-00004",
      ],
      partNumber: "930-00641-00002",
    });
    expect(out[0]).toBe("https://products.biamp.com/product-details/-/o/ecom-item/930-00641-00002");
  });
  it("drops the sibling's query string", () => {
    const out = buildLeafSwapCandidates({
      indexedUrls: ["https://x.com/p/ecom-item/910-01880?variantId=9"],
      partNumber: "910-01492",
    });
    expect(out).toEqual(["https://x.com/p/ecom-item/910-01492"]);
  });
  it("never swaps into docs/support paths or non-SKU leaves", () => {
    expect(
      buildLeafSwapCandidates({
        indexedUrls: ["https://x.com/support/930-00641-00003", "https://x.com/products/voltera"],
        partNumber: "930-00641-00002",
      }),
    ).toEqual([]);
  });
  it("returns nothing when the sibling URL is already this product, or the part is unusable", () => {
    expect(
      buildLeafSwapCandidates({
        indexedUrls: ["https://x.com/p/ecom-item/930-00641-00002"],
        partNumber: "930-00641-00002",
      }),
    ).toEqual([]);
    expect(buildLeafSwapCandidates({ indexedUrls: ["https://x.com/p/ecom-item/930-1"], partNumber: "" })).toEqual([]);
  });
});

describe("excerptAroundIdentifier", () => {
  const filler = "nav cookie banner hero copy ".repeat(60); // ~1,600 chars
  it("centres the window on the product mention instead of the top of the page", () => {
    const body = `${filler} The Desono MASK6C-W is a two-way surface mount loudspeaker. ${filler}`;
    const excerpt = excerptAroundIdentifier(body, ["MASK6C-W"], 400);
    expect(excerpt).toContain("MASK6C-W");
    expect(excerpt.length).toBeLessThanOrEqual(400);
  });
  it("falls back to the head of the page when the product is not mentioned", () => {
    const body = `START ${filler}`;
    expect(excerptAroundIdentifier(body, ["MASK6C-W"], 200).startsWith("START")).toBe(true);
  });
  it("returns short text untouched", () => {
    expect(excerptAroundIdentifier("short page", ["MASK6C-W"], 500)).toBe("short page");
  });
});

describe("countProductsPerLink", () => {
  it("counts distinct products per page, so one family page is flagged", () => {
    const counts = countProductsPerLink([
      { productId: 84565, webLink: "https://www.biamp.com/products/product-families/voltera" },
      { productId: 84568, webLink: "https://www.biamp.com/products/product-families/voltera" },
      { productId: 84371, webLink: "https://p.biamp.com/product-details/-/o/ecom-item/910-01492" },
      { productId: 84379, webLink: null },
    ]);
    expect(counts.get(normalizedUrlKey("https://www.biamp.com/products/product-families/voltera"))).toBe(2);
    expect(counts.get(normalizedUrlKey("https://p.biamp.com/product-details/-/o/ecom-item/910-01492"))).toBe(1);
  });
  it("does not count the same product twice (a retried chunk must not fake a duplicate)", () => {
    const counts = countProductsPerLink([
      { productId: 1, webLink: "https://x.com/p/1" },
      { productId: 1, webLink: "https://x.com/p/1" },
    ]);
    expect(counts.get(normalizedUrlKey("https://x.com/p/1"))).toBe(1);
  });
  it("keeps query-distinguished variant pages apart", () => {
    const counts = countProductsPerLink([
      { productId: 1, webLink: "https://x.com/p?variantId=7" },
      { productId: 2, webLink: "https://x.com/p?variantId=8" },
    ]);
    expect([...counts.values()]).toEqual([1, 1]);
  });
});

describe("isBetterVerification", () => {
  it("ranks page content above index confirmation above AI judgement above family pages", () => {
    expect(isBetterVerification("content", "index")).toBe(true);
    expect(isBetterVerification("index", "llm")).toBe(true);
    expect(isBetterVerification("llm", "family")).toBe(true);
    expect(isBetterVerification("family", "llm")).toBe(false);
    expect(isBetterVerification("content", "content")).toBe(false);
  });
});
