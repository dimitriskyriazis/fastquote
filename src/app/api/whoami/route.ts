import os from 'os';
import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  try {
    const forwardedUser =
      req.headers.get('x-remote-user') ??
      req.headers.get('x-forwarded-user') ??
      req.headers.get('remote-user');

    if (forwardedUser && forwardedUser.trim()) {
      return NextResponse.json({ ok: true, username: forwardedUser.trim(), source: 'header' });
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
