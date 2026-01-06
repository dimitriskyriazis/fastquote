import os from 'os';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const username = os.userInfo?.().username ?? process.env.USERNAME ?? 'unknown';
    return NextResponse.json({ ok: true, username });
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
