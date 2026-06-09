import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { logRequest } from "../../../../../lib/apiHelpers";
import { requirePermission } from "../../../../../lib/authz";
import { Semaphore } from "../../../../../lib/concurrency";
import { serperSearch } from "../../../../../lib/serper";
import {
  PRODUCT_DESCRIPTION_SYSTEM_PROMPT,
  PRODUCT_DESCRIPTION_GROUP_SYSTEM_PROMPT,
  buildDescriptionUserMessage,
  buildGroupDescriptionUserMessage,
  stripModelPartTokens,
} from "../../../../../lib/productDescriptionPrompt";

export const runtime = "nodejs";

// Generous safety ceiling (the UI confirms before large runs; there is no per-batch cap).
const MAX_ROWS = 5000;

type DescribeRequestRow = {
  id: number;
  partNumber?: string | null;
  modelNumber?: string | null;
  description?: string | null;
  // Rows sharing a non-empty groupKey are variants of one product line: they are rewritten in a
  // single call so their descriptions stay consistent. Absent/empty → described independently.
  groupKey?: string | null;
};

type DescribeResultRow = {
  id: number;
  newDescription: string | null;
  status: "ok" | "skipped" | "error";
};

const openaiSemaphore = new Semaphore(5);

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const webContextFor = async (
  brand: string,
  modelNumber: string,
  partNumber: string,
  tag: string,
): Promise<string> => {
  try {
    const terms = [brand, modelNumber || partNumber, "product specifications"]
      .filter(Boolean)
      .join(" ");
    if (!terms.trim()) return "";
    const snippets = await serperSearch(terms, tag);
    if (snippets.length === 0) return "";
    return snippets.map((s) => `- ${s.title}: ${s.snippet}`).join("\n");
  } catch {
    return ""; // web context is best-effort
  }
};

// Rewrite a single product's description (the original, per-row path).
const describeSingle = async (
  openai: OpenAI,
  row: DescribeRequestRow,
  brand: string,
  useWeb: boolean,
): Promise<DescribeResultRow> => {
  const modelNumber = str(row.modelNumber);
  const partNumber = str(row.partNumber);
  const description = str(row.description);

  if (!description && !modelNumber && !partNumber) {
    return { id: row.id, newDescription: null, status: "skipped" };
  }

  const webSnippets = useWeb
    ? await webContextFor(brand, modelNumber, partNumber, `desc:${row.id}`)
    : "";

  await openaiSemaphore.acquire();
  let enhanced = "";
  try {
    const res = await openai.responses.create({
      model: "gpt-4o-mini",
      temperature: 0,
      input: [
        { role: "system", content: PRODUCT_DESCRIPTION_SYSTEM_PROMPT },
        {
          role: "user",
          content: buildDescriptionUserMessage({
            brand,
            modelNumber,
            partNumber,
            description,
            webSnippets,
          }),
        },
      ],
      stream: false,
    });
    enhanced = res.output_text?.trim() ?? "";
  } finally {
    openaiSemaphore.release();
  }

  if (enhanced) enhanced = stripModelPartTokens(enhanced, modelNumber, partNumber);
  if (!enhanced) return { id: row.id, newDescription: null, status: "skipped" };
  return { id: row.id, newDescription: enhanced.slice(0, 2000), status: "ok" };
};

const coerceGroupArray = (value: unknown): Array<{ id: number; description: string }> | null => {
  if (!Array.isArray(value)) return null;
  const out: Array<{ id: number; description: string }> = [];
  for (const item of value) {
    const id = (item as { id?: unknown })?.id;
    const description = (item as { description?: unknown })?.description;
    if (typeof id === "number" && Number.isFinite(id) && typeof description === "string") {
      out.push({ id, description: description.trim() });
    }
  }
  return out;
};

// Tolerant parse of the batched JSON. Parses the whole payload first (a bare array, or an object
// wrapper like {"items":[...]}); only when that fails does it fall back to slicing out the first
// [...] block — slicing can otherwise grab brackets from any prose the model prepends.
const parseGroupJson = (text: string): Array<{ id: number; description: string }> | null => {
  if (!text) return null;
  let payload = text.trim();
  const fence = payload.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) payload = fence[1].trim();

  try {
    const whole: unknown = JSON.parse(payload);
    const direct = coerceGroupArray(whole);
    if (direct) return direct;
    if (whole && typeof whole === "object") {
      for (const key of ["items", "results", "descriptions", "data"]) {
        const nested = coerceGroupArray((whole as Record<string, unknown>)[key]);
        if (nested) return nested;
      }
    }
  } catch {
    // fall through to the lenient slice
  }

  const start = payload.indexOf("[");
  const end = payload.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    return coerceGroupArray(JSON.parse(payload.slice(start, end + 1)));
  } catch {
    return null;
  }
};

// Rewrite a family of variants in one call so their descriptions stay consistent. Falls back to
// the per-row path for anything the batched response can't supply, so it never regresses.
const describeGroup = async (
  openai: OpenAI,
  members: DescribeRequestRow[],
  brand: string,
  useWeb: boolean,
): Promise<DescribeResultRow[]> => {
  // One shared web search for the whole family (anchored on a member that has a model number).
  const anchor = members.find((m) => str(m.modelNumber)) ?? members[0];
  const webSnippets = useWeb
    ? await webContextFor(brand, str(anchor.modelNumber), str(anchor.partNumber), `desc-group:${members[0].id}`)
    : "";

  await openaiSemaphore.acquire();
  let text = "";
  try {
    const res = await openai.responses.create({
      model: "gpt-4o-mini",
      temperature: 0,
      input: [
        { role: "system", content: PRODUCT_DESCRIPTION_GROUP_SYSTEM_PROMPT },
        {
          role: "user",
          content: buildGroupDescriptionUserMessage({
            brand,
            members: members.map((m) => ({
              id: m.id,
              modelNumber: str(m.modelNumber),
              partNumber: str(m.partNumber),
              description: str(m.description),
            })),
            webSnippets,
          }),
        },
      ],
      stream: false,
    });
    text = res.output_text?.trim() ?? "";
  } finally {
    openaiSemaphore.release();
  }

  const parsed = parseGroupJson(text);
  if (!parsed) {
    // Batched JSON unusable — recover each member via the per-row path.
    return Promise.all(members.map((m) => describeSingle(openai, m, brand, useWeb)));
  }

  const byId = new Map(parsed.map((p) => [p.id, p.description] as const));
  const results: DescribeResultRow[] = [];
  const missing: DescribeRequestRow[] = [];
  for (const member of members) {
    const raw = byId.get(member.id);
    if (raw == null) {
      missing.push(member);
      continue;
    }
    const stripped = stripModelPartTokens(raw, str(member.modelNumber), str(member.partNumber)).trim();
    if (!stripped) {
      // Batched answer was empty/echo-only for this variant — recover it via the per-row path
      // (its own web context + focused single-product prompt) rather than dropping it.
      missing.push(member);
      continue;
    }
    results.push({ id: member.id, newDescription: stripped.slice(0, 2000), status: "ok" });
  }
  if (missing.length > 0) {
    results.push(...(await Promise.all(missing.map((m) => describeSingle(openai, m, brand, useWeb)))));
  }
  return results;
};

export async function POST(req: NextRequest) {
  logRequest(req, "/api/price-lists/cleanup/describe");
  try {
    const auth = await requirePermission(req, "managePriceLists");
    if (!auth.ok) return auth.response;

    const body = await req.json();
    const brand = str(body?.brand);
    const useWeb: boolean = body?.useWeb !== false; // default on
    const rawRows: unknown = body?.rows;

    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      return NextResponse.json({ ok: false, error: "No rows provided." }, { status: 400 });
    }
    if (rawRows.length > MAX_ROWS) {
      return NextResponse.json(
        { ok: false, error: `Too many rows (${rawRows.length}). Limit is ${MAX_ROWS}.` },
        { status: 400 },
      );
    }

    const rows: DescribeRequestRow[] = rawRows
      .map((r) => {
        const id = (r as { id?: unknown })?.id;
        if (typeof id !== "number" || !Number.isFinite(id)) return null;
        return {
          id,
          partNumber: str((r as { partNumber?: unknown }).partNumber),
          modelNumber: str((r as { modelNumber?: unknown }).modelNumber),
          description: str((r as { description?: unknown }).description),
          groupKey: str((r as { groupKey?: unknown }).groupKey),
        } as DescribeRequestRow;
      })
      .filter((r): r is DescribeRequestRow => r !== null);

    // Bound each completion so a hung call can't hold a worker for the SDK's 10-minute default
    // timeout; the SDK still retries transient errors within that window.
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000 });

    // Partition into consistency groups (same non-empty groupKey, ≥2 members) and singletons.
    const groupsByKey = new Map<string, DescribeRequestRow[]>();
    const singles: DescribeRequestRow[] = [];
    for (const row of rows) {
      const key = str(row.groupKey);
      if (!key) {
        singles.push(row);
        continue;
      }
      const arr = groupsByKey.get(key);
      if (arr) arr.push(row);
      else groupsByKey.set(key, [row]);
    }

    type Task =
      | { kind: "single"; row: DescribeRequestRow }
      | { kind: "group"; members: DescribeRequestRow[] };
    const tasks: Task[] = singles.map((row) => ({ kind: "single", row }));
    for (const members of groupsByKey.values()) {
      if (members.length >= 2) tasks.push({ kind: "group", members });
      else tasks.push({ kind: "single", row: members[0] }); // lone keyed row → per-row path
    }

    const settled = await Promise.allSettled(
      tasks.map((task): Promise<DescribeResultRow[]> =>
        task.kind === "single"
          ? describeSingle(openai, task.row, brand, useWeb).then((r) => [r])
          : describeGroup(openai, task.members, brand, useWeb),
      ),
    );

    const results: DescribeResultRow[] = [];
    settled.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") {
        results.push(...outcome.value);
        return;
      }
      const task = tasks[i];
      const ids = task.kind === "single" ? [task.row.id] : task.members.map((m) => m.id);
      console.error(`[cleanup-describe] task failed (ids ${ids.join(",")}):`, outcome.reason);
      for (const id of ids) results.push({ id, newDescription: null, status: "error" });
    });

    const okCount = results.filter((r) => r.status === "ok").length;
    return NextResponse.json({ ok: true, okCount, results });
  } catch (err) {
    console.error("[cleanup-describe] failed", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
