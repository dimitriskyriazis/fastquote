/**
 * Telmaco house-style product-description rules.
 *
 * This is the single source of truth for the B2B AV catalog description style, shared by the
 * Products "enhance descriptions" tool and the price-list cleanup AI step so both stay
 * consistent. Keep the rules here; do not fork the prompt.
 */

export const PRODUCT_DESCRIPTION_SYSTEM_PROMPT: string = [
  "Rewrite product descriptions for a B2B AV equipment catalog. Output ONLY the description, nothing else.",
  "",
  "FORMAT: Comma-separated key specs in a single line (or bullet list for complex kits). No full sentences. No filler words.",
  "",
  "MODEL NUMBER RULE (critical — read carefully): NEVER write the product's model number or part number anywhere in the output — not at the start, not in the middle, not at the end — even if it already appears in the Current Description. If it is present in the Current Description, REMOVE it. The Model and Part Number fields are provided ONLY so you can look up specs; they must never be copied into the output description. (Other model numbers mentioned for compatibility — e.g. 'compatible with U 67, U 87' — are NOT this product's number and stay.)",
  "",
  "CAPITALIZATION: Never write the description in ALL CAPS. If the input is in ALL CAPS or SCREAMING CASE, convert it to sentence case (capitalize only the first letter and recognised proper nouns/brand names). Write all other words in lowercase.",
  "",
  "WEB CONTEXT RULE (critical): The Current Description defines WHAT the product is. Use web context ONLY to add specs that are consistent with it. If the web context looks like a DIFFERENT product — a different category/type than the Current Description (e.g. the description says 'projector' but the web result is a server, a meter, or an unrelated device) — IGNORE the web context entirely and rewrite from the Current Description alone. Never let web context change the product's category. Never invent specs (resolutions, pixel dimensions, wattages, sizes) that are not in the Current Description or trustworthy matching web context — e.g. do not write a resolution like '4K UHD (1920×1200)' unless those exact pixel dimensions are given.",
  "",
  "NEVER DO:",
  "- Add disclaimers or 'verify with manufacturer' notes",
  "- Add label prefixes like 'Type:' or 'Lens type:'",
  "- Use marketing/filler words (high-performance, seamless, cutting-edge, robust, innovative, designed for, optimized for)",
  "- Explain what a spec means (e.g. 'for clear projection in confined spaces')",
  "- Add info not in the input or web context",
  "- Write the product's model number or part number anywhere in the output — always remove it, even if it appears at the start of the Current Description (including any ' - ' separator that follows it)",
  "",
  "FORMATTING RULES:",
  "- Start with the product type/category as the first term (e.g. 'PDU, ...' / 'Commercial ceiling speaker, ...' / 'Single-chip DLP projector, ...')",
  "- Specs are comma-separated with no label prefixes ('16 A' not 'Amperage: 16 A')",
  "- Physical dimensions go at the end in format: LxHxD: W×H×D cm",
  "- Color goes at the end, lowercase (e.g. 'white', 'black')",
  "- No trailing period for comma-separated spec lists; use full sentences with periods only for control panels and accessories where function needs describing",
  "- Wattage and impedance format: '8 ohms / 140 watts' or '70V/100V transformer'",
  "- Parenthetical notes for important commercial info: e.g. '(priced individually, but sold in pairs)'",
  "- Bundles and kits: short type description + semicolon + 'includes' + comma-separated component list; quantities in parentheses before each component: '(2) ComponentName'",
  "- Component model numbers inside bundle/kit descriptions ARE kept — they identify the included items, not the product itself",
  "- Displays: start with size + panel type (e.g. '43\" Edge LED professional display with ...'); resolution as 'Name (W×H)' (e.g. '4K UHD (3840×2160)'); brightness in cd/m²; input count as '2× HDMI 2.0'; VESA mount as 'VESA W×H mm mount'; use 'with' connector and end with period",
  "",
  "EXAMPLES:",
  "IN: Z 48 Older style clamping action shockmount for all variants of U 67, U 77, U 87, M 269 | Brand: Sennheiser | Part Number: Z48",
  "OUT: Clamping shockmount, compatible with U 67, U 77, U 87, M 269.",
  "(Z 48 / Z48 is this product's own number — REMOVED even though it was in the description; the U 67 / U 77 / U 87 / M 269 compatibility references are other products and stay)",
  "",
  "IN: Z 48 - Older style clamping action shockmount for all variants of U 67, U 77, U 87, M 269 | Brand: Sennheiser | Part Number: Z48",
  "OUT: Clamping shockmount, compatible with U 67, U 77, U 87, M 269.",
  "(model/part number and its trailing ' - ' separator both removed)",
  "",
  "IN: Short-throw zoom lens | Brand: Barco | Part Number: R9832753",
  "OUT: Short-throw zoom lens, 0.65-0.75:1 throw ratio, WUXGA resolution.",
  "(R9832753 is the part number — never written in the output)",
  "",
  "IN: G LENS (0.65-0.75:1) | Brand: Barco | Part Number: R9832753",
  "OUT: Short-throw zoom lens, 0.65-0.75:1 throw ratio, WUXGA resolution.",
  "(R9832753 is the part number — never written in the output)",
  "",
  "IN: Digital 4 channel access point transceiver, Europe version 1880-1900 MHz... | Brand: Televic",
  "OUT: (return unchanged — already good)",
  "",
  "IN: Pole mount bracket, single/dual loudspeakers | Brand: Biamp | Model: PMB-2RR | Part Number: 910-01230",
  "OUT: Pole mount bracket, single/dual loudspeakers, pan-tilt, hot-dipped galvanized steel, stainless steel fasteners, aluminum clamp.",
  "(PMB-2RR / 910-01230 are this product's model/part number — never written in the output)",
  "",
  "IN: High brightness 4K UHD laser projector, single chip DLP, 8000 lumens | Brand: Barco | Model: I600-4K8",
  "OUT: 8,000 ISO lumen, 4K UHD (Supershift), 1920 × 1200 native, single-chip DLP laser phosphor projector, sealed optical engine, laser phosphor light source rated for 20,000 hours",
  "(key lumen spec goes first; technical abbreviations kept; no trailing period for spec list; model number never written)",
  "",
  "IN: Power distribution unit 16A type F socket with sensor | Brand: Gude | Model: Expert Power Control 1105-1",
  "OUT: PDU, 16 A, safety socket type F, 1 sensor connector, SSL, IPv6, SNMPv3, plastic case, LxHxD: 12×6.5×9.5 cm",
  "(type as abbreviation first; dimensions last; lowercase 'plastic case'; no trailing period)",
  "",
  "IN: Wall controller with LCD for source and volume selection | Brand: Biamp | Model: D-DIWAC",
  "OUT: Digital decora style wall control with 2-line LCD display. Buttons for source selection and volume control. Standard 2-wire connection.",
  "(sentence-style with periods for control panels; 'digital' lowercase mid-sentence; functional description appropriate here)",
  "",
  "IN: Drop ceiling speaker 600x600mm commercial | Brand: Biamp | Model: DC220T-M | Part Number: 910-00337",
  "OUT: Commercial 600mm × 600mm drop ceiling speaker, 10W, 8 ohms, 70V/100V transformer, white (priced individually, but sold in pairs)",
  "(application type first; dimensions next; parenthetical note for sales info; color lowercase at end; no trailing period)",
  "",
  "IN: Meeting room bundle with DSP, microphone, amp, speakers and cables | Brand: Biamp | Part Number: 930-10007-00025",
  "OUT: Certified meeting room bundle; includes TesiraFORTÉ X 400, Parlé TCM-X White, Tesira AMP-450BP, (2) Desono MASK6C-BL Black, (1) Cat5e Cable Black 25' Plenum Rated, (4) Cat5e Cable Black 10' Plenum Rated, (1) Cat5e Cable Black 3', (2) Desono CCA-1",
  "(bundle: type + semicolon + 'includes' list; quantities in parentheses; the bundle's own part number 930-10007-00025 is dropped, but component model numbers are kept as they identify included items)",
  "",
  'IN: 43" professional display, 4K, Edge LED | Brand: Samsung | Model: QE43T | Part Number: LH43QETELGCXEN',
  'OUT: 43" Edge LED professional display with 4K UHD (3840×2160) resolution, 300 cd/m² brightness, 16/7 operation, MagicInfo Lite SoC, 2× HDMI 2.0 inputs, VESA 200×200 mm mount.',
  "(display format: size + panel type first, then 'with' + comma-separated specs; resolution as 'Name (W×H)'; brightness in cd/m²; input count as '2×'; VESA as 'VESA W×H mm mount'; ends with period; model/part number never written)",
].join("\n");

/**
 * Addendum that turns the single-product prompt into a batch/consistency prompt. The base rules
 * still apply to every item; this only adds the "make the variants read as one family" goal and
 * the JSON output contract. Appended to PRODUCT_DESCRIPTION_SYSTEM_PROMPT so the house style stays
 * the single source of truth.
 */
const GROUP_CONSISTENCY_ADDENDUM: string = [
  "",
  "BATCH / CONSISTENCY MODE:",
  "The user message lists SEVERAL products that are variants of the same product line — they differ only in attributes such as colour, size, capacity, channel count, or region.",
  "Rewrite ALL of them so the descriptions are CONSISTENT with each other:",
  "- identical leading product-type term across the whole set,",
  "- identical spec vocabulary and units (don't write '8 ohms' for one and '8 ohm' for another),",
  "- identical ordering and formatting of the specs the items share,",
  "- so the set reads as one coherent family.",
  "Vary ONLY the attribute(s) that genuinely differ between the items (e.g. the colour, the size, the wattage); everything the items share must be worded identically.",
  "Each item still obeys ALL the rules above (no model/part numbers, no ALL CAPS, no filler, product type first, etc.).",
  "",
  "OUTPUT: Return ONLY a JSON array — no prose, no markdown, no code fences. One object per input item, keyed by its id:",
  '[{"id": <item id>, "description": "<rewritten description>"}]',
  "Include every id from the input exactly once. The description value is the plain description text only.",
].join("\n");

/**
 * System prompt for rewriting a family of similar products together so their descriptions stay
 * consistent. Shares the base house-style rules and adds the batch-consistency + JSON contract.
 */
export const PRODUCT_DESCRIPTION_GROUP_SYSTEM_PROMPT: string =
  `${PRODUCT_DESCRIPTION_SYSTEM_PROMPT}\n${GROUP_CONSISTENCY_ADDENDUM}`;

export type DescriptionInput = {
  brand: string;
  modelNumber: string;
  partNumber: string;
  category?: string;
  description: string;
  webSnippets?: string;
};

/**
 * Build the user message. Model/Part are always included (when present) so the model can use
 * them to look up specs — they are never copied into the output, and any leak is removed
 * afterwards by stripModelPartTokens per the MODEL NUMBER RULE.
 */
export const buildDescriptionUserMessage = (input: DescriptionInput): string => {
  const { brand, modelNumber, partNumber, category, description, webSnippets } = input;
  return [
    `Brand: ${brand || "Unknown"}`,
    modelNumber ? `Model: ${modelNumber}` : "",
    partNumber ? `Part Number: ${partNumber}` : "",
    category ? `Category: ${category}` : "",
    `Current Description: ${description || "None"}`,
    webSnippets ? `\nWeb context:\n${webSnippets}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
};

export type GroupDescriptionMember = {
  id: number;
  modelNumber: string;
  partNumber: string;
  description: string;
};

/**
 * Build the user message for a family of similar products. Each member is listed with its id (so
 * the model can key its JSON output) plus the Model/Part fields for spec lookup — which, as in the
 * single-item path, are never copied into the output and are stripped afterwards. Web context is
 * shared across the whole family.
 */
export const buildGroupDescriptionUserMessage = (input: {
  brand: string;
  members: GroupDescriptionMember[];
  webSnippets?: string;
}): string => {
  const { brand, members, webSnippets } = input;
  const lines: string[] = [`Brand: ${brand || "Unknown"}`, "", "Items:"];
  for (const member of members) {
    const parts = [`- id ${member.id}:`];
    if (member.modelNumber) parts.push(`Model: ${member.modelNumber}`);
    if (member.partNumber) parts.push(`Part Number: ${member.partNumber}`);
    parts.push(`Current Description: ${member.description || "None"}`);
    lines.push(parts.join(" | "));
  }
  if (webSnippets) {
    lines.push("", "Web context (shared across the family, for spec lookup):", webSnippets);
  }
  return lines.join("\n");
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Remove the product's own model/part number from generated text. These tokens are never kept
 * in the output description (the Model/Part fields exist only for spec lookup), so they are
 * stripped unconditionally — including any trailing ' - ' style separator — even if they were
 * present in the original description.
 *
 * This only strips the exact model/part tokens; other model numbers mentioned for compatibility
 * or as bundle components use different tokens and are left untouched.
 */
export const stripModelPartTokens = (
  text: string,
  modelNumber: string,
  partNumber: string,
): string => {
  const stripToken = (token: string, input: string): string => {
    if (!token) return input;
    return input.replace(new RegExp(escapeRegex(token) + "\\s*[-–—]?\\s*", "gi"), "").trim();
  };
  let out = text;
  out = stripToken(modelNumber, out);
  out = stripToken(partNumber, out);
  return out;
};
