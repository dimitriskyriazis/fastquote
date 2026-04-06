import { headers } from "next/headers";
import MailContactGroupsClient from "./MailContactGroupsClient";

async function fetchMailDescription(mailId: string): Promise<string | null> {
  try {
    const hdrs = await headers();
    const cookie = hdrs.get("cookie") ?? "";
    const proto = hdrs.get("x-forwarded-proto") ?? "http";
    const host = hdrs.get("host") ?? "localhost:3000";
    const res = await fetch(`${proto}://${host}/api/marketing/mails/${encodeURIComponent(mailId)}`, {
      headers: { cookie },
      cache: "no-store",
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; mail?: { Description?: string | null } } | null;
    return data?.ok ? (data.mail?.Description ?? null) : null;
  } catch {
    return null;
  }
}

export default async function Page({ params }: { params: Promise<{ mailId: string }> }) {
  const { mailId } = await params;
  const description = await fetchMailDescription(mailId);
  return <MailContactGroupsClient mailId={mailId} description={description} />;
}
