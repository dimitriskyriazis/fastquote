import { NextRequest, NextResponse } from "next/server";
import { buildAuditContext } from "../../../lib/auditTrail";
import type { RecentOfferSummary } from "../../../lib/recentOfferTypes";
import { RECENT_OFFERS_MAX } from "../../../lib/recentOfferTypes";

const getStore = () => {
  const globalRef = globalThis as typeof globalThis & {
    __fastquoteRecentOffersStore?: Map<string, RecentOfferSummary[]>;
  };
  if (!globalRef.__fastquoteRecentOffersStore) {
    globalRef.__fastquoteRecentOffersStore = new Map();
  }
  return globalRef.__fastquoteRecentOffersStore;
};

const resolveUserId = (req: NextRequest) => {
  const audit = buildAuditContext(req);
  return audit.userId ?? "anon";
};

const normalizeText = (value: unknown): string => {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value == null) return "";
  return String(value).trim();
};

const normalizeEntry = (payload: unknown): RecentOfferSummary | null => {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as {
    id?: unknown;
    label?: unknown;
    customerName?: unknown;
    description?: unknown;
    title?: unknown;
    openedAt?: unknown;
  };
  const id = normalizeText(data.id);
  const label = normalizeText(data.label);
  if (!id || !label) return null;
  const now = new Date();
  const openedAtValue = typeof data.openedAt === "string"
    ? new Date(data.openedAt)
    : now;
  const resolvedOpenedAt = Number.isNaN(openedAtValue.getTime())
    ? now
    : openedAtValue;
  const description = normalizeText(data.description);
  const title = normalizeText(data.title);
  const customerName = normalizeText(data.customerName);
  return {
    id,
    label,
    customerName: customerName.length > 0 ? customerName : null,
    description: description.length > 0 ? description : null,
    title: title.length > 0 ? title : null,
    openedAt: resolvedOpenedAt.toISOString(),
  };
};

const getRecentOffersForUser = (userId: string) => {
  const store = getStore();
  return store.get(userId) ?? [];
};

const saveRecentOfferForUser = (userId: string, entry: RecentOfferSummary) => {
  const store = getStore();
  const current = store.get(userId) ?? [];
  const next = [entry, ...current.filter((item) => item.id !== entry.id)].slice(
    0,
    RECENT_OFFERS_MAX,
  );
  store.set(userId, next);
  return next;
};

export async function GET(req: NextRequest) {
  const userId = resolveUserId(req);
  const offers = getRecentOffersForUser(userId);
  return NextResponse.json({ ok: true, offers });
}

export async function POST(req: NextRequest) {
  const userId = resolveUserId(req);
  const payload = await req.json().catch(() => null);
  const entry = normalizeEntry(payload);
  if (!entry) {
    return NextResponse.json(
      { ok: false, error: "Invalid recent offer payload" },
      { status: 400 },
    );
  }
  const next = saveRecentOfferForUser(userId, entry);
  return NextResponse.json({ ok: true, offers: next });
}
