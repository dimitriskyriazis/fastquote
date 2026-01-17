import { NextRequest } from 'next/server';
import { headers } from 'next/headers';

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_LENGTH = 16;

function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    return Array.from(crypto.getRandomValues(new Uint8Array(REQUEST_ID_LENGTH)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}

export async function getRequestId(req?: NextRequest | Request): Promise<string> {
  if (req && req instanceof Request) {
    const headerId = req.headers.get(REQUEST_ID_HEADER);
    if (headerId && headerId.trim()) {
      return headerId.trim();
    }
  }
  
  try {
    const headersList = await headers();
    const headerId = headersList.get(REQUEST_ID_HEADER);
    if (headerId && headerId.trim()) {
      return headerId.trim();
    }
  } catch {
    // headers() only works in Server Components/Route Handlers
  }

  return generateRequestId();
}

export function setRequestIdHeader(response: Response, requestId: string): void {
  response.headers.set(REQUEST_ID_HEADER, requestId);
}
