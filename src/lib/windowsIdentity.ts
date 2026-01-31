const WINDOWS_USER_HEADER = 'x-windows-user';

export const normalizeWindowsIdentity = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replaceAll('/', '\\');
};

export const getWindowsIdentityFromHeaders = (headers: Headers): string | null => {
  const raw = headers.get(WINDOWS_USER_HEADER);
  return normalizeWindowsIdentity(raw);
};
