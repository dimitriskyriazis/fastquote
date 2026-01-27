import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const raw = request.headers.get('x-user-identity');
  return NextResponse.json({ xUserIdentity: raw });
}