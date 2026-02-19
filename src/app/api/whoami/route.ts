import os from 'os';
import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../lib/apiHelpers';
import { getWindowsIdentityFromHeaders } from '../../../lib/windowsIdentity';

export async function GET(req: NextRequest) {
  logRequest(req, '/api/whoami');
  try {
    const headerUser = getWindowsIdentityFromHeaders(req.headers);
    if (headerUser) {
      return NextResponse.json({ ok: true, username: headerUser, source: 'header' });
    }

    const username = os.userInfo?.().username ?? process.env.USERNAME ?? 'unknown';
    return NextResponse.json({ ok: true, username, source: 'os' });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to resolve the current Windows user';
    return NextResponse.json(
      { ok: false, error: message },
      {
        status: 500,
      },
    );
  }
}
