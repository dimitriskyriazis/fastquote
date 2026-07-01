import path from "node:path";
import { pathToFileURL } from "node:url";

// Shared logic for locating a marketing mail list's export folder on the shared drive.
// Used by both the export route (which writes into the folder) and the folder route
// (which just resolves/opens it), so the naming stays byte-for-byte identical.

// Marketing list exports are written into a per-list folder on the shared drive,
// so everyone works from the same canonical copy instead of scattered downloads.
export const requireMailsExportRoot = (): string => {
  const raw = process.env.MAILS_EXPORT_ROOT;
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    throw new Error(
      "Missing MAILS_EXPORT_ROOT. Set it in your environment (e.g. .env.local) to the marketing list export folder.",
    );
  }
  return value;
};

// Characters that are illegal in Windows file/folder names: < > : " / \ | ? *
const ILLEGAL_FOLDER_CHARS = /[<>:"/\\|?*]/g;
// ASCII control characters (U+0000–U+001F), built via fromCharCode to keep the source ASCII.
const CONTROL_CHARS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}]`, "g");

// Strip characters illegal in Windows folder names, collapse whitespace, and drop
// trailing dots/spaces (also illegal on Windows).
export const sanitizeFolderSegment = (value: string): string =>
  value
    .replace(ILLEGAL_FOLDER_CHARS, "")
    .replace(CONTROL_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");

// Folder name: "<MailID> - <Description>" (or just "<MailID>" when there is no usable description).
export const buildMailFolderName = (mailId: number, description: string | null | undefined): string => {
  const cleaned = sanitizeFolderSegment(description ?? "");
  const namePart = (cleaned.length > 100 ? cleaned.slice(0, 100) : cleaned).replace(/[. ]+$/, "");
  return namePart ? `${mailId} - ${namePart}` : `${mailId}`;
};

// Absolute path to a list's export folder on the shared drive.
export const buildMailFolderPath = (mailId: number, description: string | null | undefined): string => {
  // The export root is a runtime env var (an external network share), not a build-time
  // path. Without this turbopackIgnore hint, NFT tries to statically resolve the unknown
  // base and ends up globbing the whole project into the route's file trace.
  return path.join(/*turbopackIgnore: true*/ requireMailsExportRoot(), buildMailFolderName(mailId, description));
};

// file:// URL for the folder so the browser can hand it to Windows Explorer. Handles both
// UNC shares (\\server\share\... -> file://server/share/...) and drive letters
// (C:\... -> file:///C:/...), and percent-encodes spaces and other special characters.
export const buildMailFolderFileUrl = (folderPath: string): string => pathToFileURL(folderPath).href;
