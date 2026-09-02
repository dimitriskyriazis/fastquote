// Live end-to-end check of the "fix capitalisation" prompt (real OpenAI calls).
// OPT-IN: it costs API calls and needs network, so it is skipped unless you ask for it:
//
//   FIXCAP_LIVE=1 npx vitest run src/lib/__tests__/descriptionCapitalisationLive.test.ts --reporter=verbose
//
// Run it after touching CAPITALISATION_SYSTEM_PROMPT or the parser. It drives the exact
// prompt, parser and guard that /api/products/fix-capitalisation uses, so it cannot
// quietly diverge from production, and it prints every answer the guard threw away.
//
// The point of the guard is that a bad answer is DROPPED rather than written, so the
// assertion here is about the acceptance rate, not about matching a golden string.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import {
  CAPITALISATION_SINGLE_SYSTEM_PROMPT,
  CAPITALISATION_SYSTEM_PROMPT,
  buildCapitalisationUserMessage,
  isCaseOnlyRewrite,
  parseCapitalisationResponse,
} from '../descriptionCapitalisation';

const LIVE = process.env.FIXCAP_LIVE === '1';

const loadEnv = () => {
  const file = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
};

// Shouted lines in the shapes that actually turn up in supplier price lists, plus a few
// already-correct ones that must come back untouched.
const FIXTURES: string[] = [
  'CLICKSHARE HUB PRO EU WITH 2 BUTTONS',
  'CLICKSHARE BAR CB CORE EU WITH 1 BUTTON',
  '4K HDMI DISTRIBUTION AMPLIFIER 1X4 WITH EDID',
  'BARCO G60-W10 SINGLE LAMP PROJECTOR 10000 LUMEN WUXGA',
  'WIRELESS CONFERENCE MICROPHONE, DECT 1880-1900 MHZ, EU VERSION',
  'CEILING SPEAKER 8 OHMS / 20 WATTS WHITE, IP54',
  'RACK SHELF 1RU FOR 19" CABINET, BLACK',
  'DANTE NETWORK AUDIO INTERFACE 16X16 WITH POE',
  'ClickShare Hub Pro EU with 2 Buttons',
  'Short-throw zoom lens, 0.65-0.75:1 throw ratio, WUXGA resolution',
  'ΚΑΛΩΔΙΟ HDMI ΜΗΚΟΥΣ 3 ΜΕΤΡΩΝ',
  'ΟΘΟΝΗ ΑΦΗΣ 55 ΙΝΤΣΩΝ ΓΙΑ ΑΙΘΟΥΣΑ ΣΥΣΚΕΨΕΩΝ',
];

describe.skipIf(!LIVE)('fix-capitalisation prompt, live', () => {
  it('returns a pure re-casing for every line in a batch', async () => {
    loadEnv();
    const apiKey = process.env.OPENAI_API_KEY;
    expect(apiKey, 'OPENAI_API_KEY missing from environment and .env.local').toBeTruthy();

    const openai = new OpenAI({ apiKey, timeout: 60_000, maxRetries: 2 });

    const res = await openai.responses.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      input: [
        { role: 'system', content: CAPITALISATION_SYSTEM_PROMPT },
        { role: 'user', content: buildCapitalisationUserMessage(FIXTURES) },
      ],
      stream: false,
    });

    const answers = parseCapitalisationResponse(res.output_text ?? '', FIXTURES.length);

    const accepted: string[] = [];
    const rejected: string[] = [];
    FIXTURES.forEach((original, i) => {
      const answer = answers[i];
      if (answer && isCaseOnlyRewrite(original, answer)) {
        accepted.push(`  OK       ${original}\n           ${answer}`);
      } else {
        rejected.push(`  REJECTED ${original}\n           ${answer ?? '(no answer)'}`);
      }
    });

    console.log(`\nbatch pass: ${accepted.length} accepted, ${rejected.length} rejected`);
    console.log([...accepted, ...rejected].join('\n'));

    // Anything the batch could not answer gets the same one-at-a-time retry the route does.
    const repaired: string[] = [];
    for (let i = 0; i < FIXTURES.length; i++) {
      const answer = answers[i];
      if (answer && isCaseOnlyRewrite(FIXTURES[i], answer)) continue;
      const single = await openai.responses.create({
        model: 'gpt-4o-mini',
        temperature: 0,
        input: [
          { role: 'system', content: CAPITALISATION_SINGLE_SYSTEM_PROMPT },
          { role: 'user', content: FIXTURES[i] },
        ],
        stream: false,
      });
      const text = single.output_text?.trim() ?? '';
      const ok = text && isCaseOnlyRewrite(FIXTURES[i], text);
      repaired.push(`  ${ok ? 'OK      ' : 'REJECTED'} ${FIXTURES[i]}\n           ${text || '(no answer)'}`);
      if (ok) accepted.push(FIXTURES[i]);
    }
    if (repaired.length) {
      console.log(`\nretry pass (${repaired.length} line(s)):`);
      console.log(repaired.join('\n'));
    }

    // The guard drops bad answers instead of writing them, so a stray rejection is safe.
    // A low acceptance rate, though, means the prompt has regressed.
    expect(accepted.length).toBeGreaterThanOrEqual(FIXTURES.length - 2);
  }, 180_000);
});
