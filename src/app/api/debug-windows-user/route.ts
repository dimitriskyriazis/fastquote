import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const raw = request.headers.get('x-windows-user');
  return NextResponse.json({ xWindowsUser: raw });
}
