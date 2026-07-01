import { showToastMessage } from "./toast";

type FolderResponse = {
  ok?: boolean;
  folder?: string;
  fileUrl?: string;
  exists?: boolean;
  error?: string;
};

// Synchronous clipboard write via execCommand. Unlike the async Clipboard API
// (navigator.clipboard.*), this does NOT require the document to have focus, so it works
// when invoked from an AG Grid context-menu click (where the async API rejects silently).
// Falls back to the async API for browsers that have dropped execCommand support.
//
// Returns whether the copy actually succeeded. This matters because openMailFolder resolves
// the path via an awaited fetch first: on a slow share the click's transient activation can
// expire before we reach this point, and both copy paths can then fail. The caller must not
// claim "copied to clipboard" unless this returns true.
const copyTextToClipboard = async (text: string): Promise<boolean> => {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.cssText = "position:fixed;left:-9999px;top:0;";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    if (ok) return true;
  } catch {
    /* fall through to async API */
  }
  try {
    // navigator.clipboard is undefined in non-secure (plain http) contexts, so guard it
    // explicitly — otherwise `await undefined` would resolve and we'd falsely report success.
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

// Best-effort open of a file:// URL in Windows Explorer. Chrome/Edge only hand file:// URLs
// off to the OS when the site sits in the Local Intranet zone; otherwise the click is
// silently ignored, which is why openMailFolder always copies the path as a fallback.
const tryOpenFileUrl = (fileUrl: string): void => {
  try {
    const a = document.createElement("a");
    a.href = fileUrl;
    a.target = "_blank";
    a.rel = "noopener,noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    /* blocked by the browser — the clipboard copy is the fallback */
  }
};

// Resolve a mail list's export folder on the shared drive, copy its path to the clipboard,
// and (when the folder exists) attempt to open it in Explorer.
export async function openMailFolder(mailId: number): Promise<void> {
  let data: FolderResponse | null = null;
  try {
    const res = await fetch(`/api/marketing/mails/${encodeURIComponent(String(mailId))}/folder`);
    data = (await res.json().catch(() => null)) as FolderResponse | null;
    if (!res.ok || !data?.ok || !data.folder) {
      showToastMessage(data?.error ?? "Could not resolve the mail folder", "error");
      return;
    }
  } catch (err) {
    console.error("Failed to resolve mail folder", err);
    showToastMessage("Could not resolve the mail folder", "error");
    return;
  }

  const { folder, fileUrl, exists } = data;
  const copied = await copyTextToClipboard(folder);
  // Always surface the path itself so the user can act on it even when the clipboard write
  // failed; only claim it was copied when it actually was.
  const pathNote = copied ? `Path copied to clipboard: ${folder}` : `Folder: ${folder}`;

  if (!exists) {
    showToastMessage(
      `This list hasn't been exported yet — export it first to create the folder. ${pathNote}`,
      "error",
    );
    return;
  }

  if (fileUrl) tryOpenFileUrl(fileUrl);
  showToastMessage(`Opening folder… ${pathNote}`, "success");
}
