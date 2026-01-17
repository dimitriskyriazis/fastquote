# API Production Utilities

This directory contains utilities for production-grade API handling in a local network environment.

## Features

### 1. Structured Logging (`logger.ts`)
- Centralized logging with timestamps and log levels
- Contextual information (request ID, user ID, endpoint)
- Error stack traces in development, sanitized in production

**Usage:**
```typescript
import { logger } from './logger';

logger.info('Operation completed', { requestId, userId, endpoint });
logger.error('Operation failed', { requestId }, error);
```

### 2. Request ID Tracking (`requestId.ts`)
- Unique request ID for each API call
- Automatically added via middleware
- Included in all logs and error responses

**Usage:**
```typescript
import { getRequestId } from './requestId';

const requestId = getRequestId(req);
```

### 3. Error Handling (`errorHandler.ts`)
- Sanitized error messages (no stack traces in production)
- Consistent error response format
- Automatic logging of errors

**Usage:**
```typescript
import { handleApiError, createErrorResponse } from './errorHandler';

try {
  // ... code
} catch (err) {
  return handleApiError(err, { requestId, endpoint, method, userId });
}

// Or for explicit errors:
return createErrorResponse('Invalid input', 400, { requestId, endpoint, method, userId });
```

### 4. API Helpers (`apiHelpers.ts`)
- Convenience functions for common API patterns
- Reduces boilerplate code

**Usage:**
```typescript
import { createApiContext, handleApiErrorResponse, logApiSuccess } from './apiHelpers';

export async function GET(req: NextRequest) {
  const ctx = createApiContext(req, '/api/products');
  
  try {
    // ... code
    logApiSuccess(ctx, 'Product fetched', { productId });
    return NextResponse.json({ ok: true, product });
  } catch (err) {
    return handleApiErrorResponse(err, ctx);
  }
}
```

### 5. Database Timeouts (`sql.ts`)
- Configurable request timeout (default: 30 seconds)
- Set via `SQLSERVER_REQUEST_TIMEOUT` environment variable
- Prevents hanging database queries

**Usage:**
```typescript
const request = pool.request();
request.timeout = 30000; // 30 seconds
```

### 6. Health Check Endpoint (`/api/health`)
- Database connectivity check
- Response time measurement
- Request ID tracking

**Access:** `GET /api/health`

## Migration Guide

To update existing API routes:

1. **Import utilities:**
```typescript
import { getRequestId } from '../../../../lib/requestId';
import { handleApiError, createErrorResponse } from '../../../../lib/errorHandler';
import { logger } from '../../../../lib/logger';
import { resolveAuditUserId } from '../../../../lib/auditTrail';
```

2. **Add context at start of handler:**
```typescript
const requestId = getRequestId(req);
const userId = resolveAuditUserId(req);
```

3. **Replace console.error with logger:**
```typescript
// Old:
console.error('Error', err);

// New:
logger.error('Error', { requestId, endpoint, userId }, err);
```

4. **Replace error responses:**
```typescript
// Old:
return NextResponse.json({ ok: false, error: message }, { status: 500 });

// New:
return handleApiError(err, { requestId, endpoint, method, userId });
```

5. **Add timeouts to database queries:**
```typescript
const request = pool.request();
request.timeout = 30000; // Add this line
```

## Environment Variables

- `SQLSERVER_REQUEST_TIMEOUT` - Database query timeout in milliseconds (default: 30000)
- `NODE_ENV` - Set to 'production' to enable error sanitization

## Example: Complete Route

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getRequestId } from '../../../../lib/requestId';
import { handleApiError, createErrorResponse } from '../../../../lib/errorHandler';
import { logger } from '../../../../lib/logger';
import { resolveAuditUserId } from '../../../../lib/auditTrail';
import { getPool } from '../../../../lib/sql';
import sql from 'mssql';

export async function GET(req: NextRequest) {
  const requestId = getRequestId(req);
  const userId = resolveAuditUserId(req);
  const endpoint = '/api/products';
  
  try {
    const pool = await getPool();
    const request = pool.request();
    request.timeout = 30000;
    
    const result = await request.query('SELECT * FROM Products');
    
    logger.info('Products fetched', { requestId, endpoint, userId });
    return NextResponse.json({ ok: true, products: result.recordset });
  } catch (err) {
    return handleApiError(err, { requestId, endpoint, method: 'GET', userId });
  }
}
```
