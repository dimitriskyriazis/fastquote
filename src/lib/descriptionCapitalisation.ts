/**
 * Shared rules for the "fix capitalisation" tool: which descriptions look shouted,
 * what the AI is told to do with them, and what counts as an acceptable answer.
 *
 * Both halves of the feature live here so they cannot drift apart. The price-list
 * import decides WHICH products to offer a fix for; /api/products/fix-capitalisation
 * decides WHAT the fixed text is allowed to be. Previously the import route carried
 * its own inline heuristic whose comment documented examples it did not actually
 * flag, and the API route trusted whatever the model returned.
 */

import { normalizeSearchText } from './textSearch';

/**
 * Technical terms whose spelling is fixed by convention, written the way the
 * catalogue should show them.
 *
 * The list does double duty, which is the point of keeping it in one place:
 *
 * 1. It is handed to the model as the leave-exactly-as-written list, so "POE"
 *    comes back as "PoE" and "HDBASET" as "HDBaseT" instead of being frozen in
 *    whatever case the supplier typed.
 * 2. Uppercased, it tells {@link isLikelyBadlyCapitalised} which words say nothing
 *    about whether a line is shouted. Counting them as shouting was the bug that
 *    made the old heuristic fire on well-written lines such as "Dante-enabled
 *    WUXGA HDBASET SDVOE processor".
 *
 * Product brand names with mixed-case house spelling (ClickShare, BrightSign) stay
 * OUT of this list on purpose: a shouted "CLICKSHARE" is exactly the signal the
 * heuristic is looking for. They are named separately in the prompt rules instead.
 */
export const CANONICAL_TERMS: readonly string[] = [
  // Regions and markets
  'EU', 'UK', 'US', 'USA', 'EMEA', 'APAC', 'ANZ', 'ROW',
  // Video and resolution
  'HD', 'FHD', 'QHD', 'UHD', '4K', '8K', 'HDR', 'HDMI', 'VGA', 'DVI', 'SDI', 'NDI',
  'HDBaseT', 'SDVoE', 'HDCP', 'EDID', 'CEC', 'ARC', 'eARC', 'HEVC', 'MJPEG',
  'AVC', 'DCI', 'PTZ', 'NVR', 'DVR', 'ONVIF', 'RTSP', 'SRT', 'WebRTC',
  'WXGA', 'WUXGA', 'SXGA', 'XGA', 'SVGA', 'QXGA', 'DLP', 'LCD', 'LED', 'OLED', 'LCoS',
  // Audio
  'Dante', 'AES', 'AES67', 'AVB', 'TDM', 'DSP', 'AEC', 'ANC', 'XLR', 'TRS', 'TRRS',
  'SPL', 'THD', 'RMS', 'UHF', 'VHF', 'DECT', 'MEMS', 'MADI', 'ADAT', 'S/PDIF', 'AoIP',
  // Networking and control
  'IP', 'LAN', 'WAN', 'VLAN', 'PoE', 'PoE+', 'SFP', 'RJ45', 'HTTP', 'HTTPS', 'TCP',
  'UDP', 'DNS', 'DHCP', 'SNMP', 'OSC', 'API', 'SSL', 'TLS', 'VPN', 'NFC', 'RFID',
  'GPIO', 'RS-232', 'RS-422', 'RS-485', 'USB', 'USB-C', 'Wi-Fi', 'Bluetooth', 'BLE',
  'SIP', 'PSTN', 'ISDN', 'MQTT', 'SSH', 'KNX', 'DALI', 'DMX', 'Art-Net', 'sACN',
  'BMS', 'CMS', 'STP', 'UTP', 'FTP', 'AVoIP',
  // Electrical and physical
  'AC', 'DC', 'RF', 'IR', 'PSU', 'PDU', 'UPS', 'IEC', 'VESA', 'RU', 'IK', 'ATEX',
  'IP65', 'IP66', 'IP67', 'NEMA', 'EMC', 'CE', 'RoHS', 'REACH', 'UL', 'FCC',
  // Trade and commercial
  'AV', 'IT', 'BYOD', 'MTBF', 'RRP', 'MOQ', 'SKU', 'OEM', 'VAT', 'MSRP',
  'NBD', 'SLA', 'RMA', 'EOL', 'EOS',
  // Brands that really are written in capitals
  'QSC', 'AMX', 'JBL', 'NEC', 'LG', 'BSS', 'RDL', 'KVM', 'TOA', 'AKG', 'DPA',
  'EAW', 'RCF', 'FBT', 'LEA', 'ATEN', 'MSI', 'ASUS', 'HP', 'AOC', 'BenQ',
];

const CANONICAL_UPPER = new Set(CANONICAL_TERMS.map((term) => term.toLocaleUpperCase()));

/** Splits on everything that is not a letter or a digit, so "USB-C" and "H.264" break apart. */
const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
const HAS_DIGIT = /\p{N}/u;

/** True when the token has cased letters and every one of them is upper case. */
const isShoutedWord = (word: string): boolean =>
  word === word.toLocaleUpperCase() && word !== word.toLocaleLowerCase();

/**
 * Heuristic for "this description was typed in capitals and wants fixing".
 *
 * A word counts toward the verdict only if it could plausibly have been written in
 * mixed case: at least three letters, no digits (part numbers and sizes such as
 * "1X4" or "G60" say nothing about prose casing), and not on the
 * {@link CANONICAL_TERMS} list. The description is flagged when at least two
 * such words are shouted AND they are at least half of them, which keeps a single
 * stray acronym or a lone "NOT" from tripping it.
 *
 * Flags:
 *   "CLICKSHARE HUB PRO EU WITH 2 BUTTONS"    5 of 5 candidate words shouted
 *   "CLICKSHARE BAR CB Core EU WITH 1 BUTTON" 4 of 5 shouted
 * Leaves alone:
 *   "Linear Acoustic UPMAX downmix processor" 1 shouted word, below the floor of 2
 *   "Dante-enabled WUXGA HDBASET SDVOE processor" WUXGA, HDBASET and SDVOE are all
 *       known terms, so nothing counts as shouted
 *   "Does NOT include 1st year Premium Support" 1 shouted word
 */
export const isLikelyBadlyCapitalised = (desc: string | null | undefined): boolean => {
  if (!desc) return false;

  let candidates = 0;
  let shouted = 0;

  for (const word of desc.split(WORD_SPLIT)) {
    if (!word) continue;
    if (word.length < 3) continue;
    if (HAS_DIGIT.test(word)) continue;
    if (CANONICAL_UPPER.has(word.toLocaleUpperCase())) continue;
    candidates++;
    if (isShoutedWord(word)) shouted++;
  }

  if (candidates === 0) return false;
  return shouted >= 2 && shouted / candidates >= 0.5;
};

/**
 * Canonical form for "same text, different capitalisation".
 *
 * Reuses the search fold (accents, case, Greek final sigma) and additionally
 * collapses whitespace runs. Folding accents is deliberate rather than sloppy:
 * all-caps Greek drops its accents, so restoring them ("ΟΘΟΝΗ" to "Οθόνη") is
 * part of fixing the capitalisation, not a change of wording.
 */
export const foldForCaseCompare = (value: string): string =>
  normalizeSearchText(value).replace(/\s+/gu, ' ').trim();

/**
 * The invariant that makes this feature safe to run unattended over thousands of rows.
 *
 * Fixing capitalisation may only change letter case. No word may be added, dropped,
 * reworded or reordered, and no character may be substituted. Because that is
 * machine-checkable, a model that loses its place in a batch, hallucinates a
 * plausible product description, or copies an example out of its own prompt is
 * caught before anything reaches the database, instead of writing one product's
 * description onto another.
 */
export const isCaseOnlyRewrite = (original: string, candidate: string): boolean => {
  const foldedOriginal = foldForCaseCompare(original);
  if (!foldedOriginal) return false;
  return foldedOriginal === foldForCaseCompare(candidate);
};

/** Drops a ```json ... ``` wrapper, which models add even when told not to. */
export const stripJsonFence = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
};

/**
 * Parses the model's answer into a slot-per-input array.
 *
 * The model is asked for objects carrying the line number it is answering
 * ([{"n":1,"text":"..."}]), so a short, long or reordered answer lands in the right
 * slots instead of silently shifting every description by one. A bare array of
 * strings is still accepted, but only when its length matches exactly, since
 * position is the only thing identifying those.
 *
 * Slots with no usable answer come back as null and are retried one at a time.
 */
export const parseCapitalisationResponse = (
  raw: string,
  expectedCount: number,
): (string | null)[] => {
  const slots: (string | null)[] = new Array(expectedCount).fill(null);
  if (!raw.trim()) return slots;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch {
    return slots;
  }

  // Tolerate a wrapper object, e.g. { "descriptions": [...] } or { "results": [...] }
  let list: unknown = parsed;
  if (!Array.isArray(list) && parsed && typeof parsed === 'object') {
    const values = Object.values(parsed as Record<string, unknown>);
    list = values.find((value) => Array.isArray(value)) ?? parsed;
  }
  if (!Array.isArray(list)) return slots;

  const looksIndexed = list.some(
    (entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry),
  );

  if (looksIndexed) {
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const rawIndex = record.n ?? record.index ?? record.i ?? record.line;
      const index =
        typeof rawIndex === 'number'
          ? rawIndex
          : typeof rawIndex === 'string'
            ? Number.parseInt(rawIndex, 10)
            : NaN;
      const rawText = record.text ?? record.description ?? record.value;
      if (!Number.isInteger(index) || index < 1 || index > expectedCount) continue;
      if (typeof rawText !== 'string' || !rawText.trim()) continue;
      slots[index - 1] = rawText.trim();
    }
    return slots;
  }

  // Bare string array: position is the only identifier, so demand an exact length.
  if (list.length !== expectedCount) return slots;
  for (let i = 0; i < expectedCount; i++) {
    const entry = list[i];
    if (typeof entry === 'string' && entry.trim()) slots[i] = entry.trim();
  }
  return slots;
};

const RULES: string[] = [
  'You re-capitalise product descriptions for a B2B AV equipment catalogue.',
  '',
  'HARD CONSTRAINT: letter case is the ONLY thing you may change. Never add, remove, reword,',
  'translate or reorder a word. Never change a digit, a symbol or any punctuation. Never change',
  'spacing except to collapse a run of spaces. If you cannot fix a line under that constraint,',
  'return it exactly as given. Answers that alter the wording are discarded, so a line returned',
  'unchanged is always better than a line rewritten.',
  '',
  'RULES:',
  '- Turn shouted ALL-CAPS English text into Title Case.',
  '- Major words (nouns, verbs, adjectives, adverbs) take a capital.',
  '- Minor words (a, an, the, and, but, or, nor, for, so, yet, at, by, in, of, on, to, up, as, if, it, is, with, from, into, onto, per) stay lower case unless they are the first or last word.',
  '- Greek text is not title-cased. Use sentence case (capital on the first word and on proper nouns only) and restore the accents that all-caps Greek drops, so "ΟΘΟΝΗ ΑΦΗΣ" becomes "Οθόνη αφής".',
  `- These terms are always written exactly like this, whatever their position in the line: ${CANONICAL_TERMS.join(', ')}.`,
  '- Any other acronym, unit or measurement stays untouched (1080p, 2.4GHz, 50W, 8-port, 3m, cd/m2).',
  '- Part numbers, model numbers and alphanumeric codes keep their exact case (G60-W10, R9832753, CS-100).',
  '- Brand names take their own house capitalisation: ClickShare, BrightSign, ClearOne, Biamp, Crestron, Extron, Shure, Sennheiser, Beyerdynamic, Barco, Christie, Epson, Panasonic, Sony, Samsung, Cisco, Poly, Logitech, Huddly, Yealink, Neumann, Televic.',
  '- A line that is already correctly capitalised comes back byte for byte identical.',
];

const BATCH_OUTPUT: string[] = [
  'OUTPUT: a JSON array with one object per input line, each {"n": <the line number>, "text": "<the re-cased line>"}.',
  'Answer every line, in any order, using the number the line was given. No prose, no markdown, no code fence.',
];

const SINGLE_OUTPUT: string[] = [
  'OUTPUT: the re-cased line as plain text and nothing else. No quotes, no JSON, no numbering, no explanation.',
];

const EXAMPLE: string[] = [
  'Worked example. These lines are illustrative only: never copy text from them into a real answer.',
  'Given the lines',
  '  1. WIRELESS PRESENTATION HUB EU WITH 2 BUTTONS',
  '  2. Barco G60-W10 Single Lamp Projector 10000 Lumen WUXGA',
  '  3. ΚΑΛΩΔΙΟ HDMI ΜΗΚΟΥΣ 3 ΜΕΤΡΩΝ',
  'the answer is',
  '  [{"n":1,"text":"Wireless Presentation Hub EU with 2 Buttons"},{"n":2,"text":"Barco G60-W10 Single Lamp Projector 10000 Lumen WUXGA"},{"n":3,"text":"Καλώδιο HDMI μήκους 3 μέτρων"}]',
  'Line 1 was shouted, so it is title-cased. Line 2 was already correct, so it is returned unchanged.',
  'Line 3 is Greek, so it is sentence-cased with its accents restored.',
];

/** System prompt for the batched call: many numbered lines in, index-keyed objects out. */
export const CAPITALISATION_SYSTEM_PROMPT: string = [
  ...RULES,
  '',
  ...BATCH_OUTPUT,
  '',
  ...EXAMPLE,
].join('\n');

/**
 * System prompt for the one-at-a-time repair pass.
 *
 * Used for lines the batch could not answer, or answered with something that failed
 * {@link isCaseOnlyRewrite}. A single line cannot be misaligned and carries no worked
 * example to copy from, so the plain-text form is the safer retry.
 */
export const CAPITALISATION_SINGLE_SYSTEM_PROMPT: string = [
  ...RULES,
  '',
  ...SINGLE_OUTPUT,
].join('\n');

/** Numbered user message for the batched call. */
export const buildCapitalisationUserMessage = (descriptions: string[]): string =>
  [
    'Re-capitalise these lines.',
    '',
    ...descriptions.map((desc, idx) => `${idx + 1}. ${desc.replace(/\s+/gu, ' ').trim()}`),
  ].join('\n');
