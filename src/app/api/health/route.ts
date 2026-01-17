import { NextResponse } from 'next/server';
import { getPool } from '../../../lib/sql';
import { logger } from '../../../lib/logger';
import { getRequestId } from '../../../lib/requestId';

export async function GET() {
  const requestId = await getRequestId();
  const startTime = Date.now();

  try {
    const pool = await getPool();
    
    if (!pool.connected) {
      return NextResponse.json(
        {
          ok: false,
          status: 'unhealthy',
          database: 'disconnected',
          requestId,
        },
        { status: 503 },
      );
    }

    const request = pool.request();
    request.timeout = 5000;
    
    await request.query('SELECT 1 AS health_check');

    const responseTime = Date.now() - startTime;

    return NextResponse.json({
      ok: true,
      status: 'healthy',
      database: 'connected',
      responseTime: `${responseTime}ms`,
      timestamp: new Date().toISOString(),
      requestId,
    });
  } catch (err) {
    const responseTime = Date.now() - startTime;
    logger.error('Health check failed', {
      requestId,
      responseTime: `${responseTime}ms`,
    }, err instanceof Error ? err : undefined);

    return NextResponse.json(
      {
        ok: false,
        status: 'unhealthy',
        database: 'error',
        responseTime: `${responseTime}ms`,
        timestamp: new Date().toISOString(),
        requestId,
      },
      { status: 503 },
    );
  }
}
