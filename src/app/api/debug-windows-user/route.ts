import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../lib/apiHelpers';

export async function GET(request: NextRequest) {
  logRequest(request, '/api/debug-windows-user');
  const raw = request.headers.get('x-windows-user');
  return NextResponse.json({ xWindowsUser: raw });
}
