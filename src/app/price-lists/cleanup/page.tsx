import { redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { resolveAuditUserId } from "../../../lib/auditTrail";
import { fetchUserRoles } from "../../../lib/authz";
import PriceListCleanupClient from "./PriceListCleanupClient";

export const metadata = {
  title: "Pricelist Cleanup",
};

// Needs the per-request user to resolve roles.
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = ["Administrator", "Developer"];

export default async function PriceListCleanupPage() {
  let roles: string[] = [];
  try {
    const [hdrs, cookieStore] = await Promise.all([headers(), cookies()]);
    const userId = resolveAuditUserId({ headers: hdrs as unknown as Headers, cookies: cookieStore });
    roles = await fetchUserRoles(userId);
  } catch (err) {
    console.error("Failed to resolve roles for pricelist cleanup", err);
  }

  // Restricted to Administrator / Developer (deny on any resolution error).
  if (!roles.some((role) => ALLOWED_ROLES.includes(role))) {
    redirect("/");
  }

  return <PriceListCleanupClient />;
}
