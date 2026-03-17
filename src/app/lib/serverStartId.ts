import fs from 'fs';
import path from 'path';

// In dev mode: always "development" — localStorage is never cleared on rebuild.
// In production: uses the Next.js build ID — only clears on new deployments.
function getBuildId(): string {
  if (process.env.NODE_ENV === 'development') {
    return 'development';
  }
  try {
    return fs.readFileSync(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

export const serverStartId = getBuildId();
