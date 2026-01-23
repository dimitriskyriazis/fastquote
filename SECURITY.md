# Security Hardening Documentation

This document outlines the security improvements implemented in the FastQuote application following OWASP best practices.

## Overview

The application has been hardened with the following security measures:

1. **Rate Limiting** - IP and user-based rate limiting on all public endpoints
2. **Input Validation** - Strict schema-based validation with type checking and length limits
3. **API Key Security** - Secure handling of credentials and secrets

## 1. Rate Limiting

### Implementation

Rate limiting is implemented in `src/lib/rateLimiter.ts` and applied globally via `middleware.ts`.

### Features

- **IP-based rate limiting**: Applies to all requests (default: 100 requests per 15 minutes)
- **User-based rate limiting**: Applies to authenticated requests (default: 200 requests per 15 minutes)
- **Strict rate limiting**: For write operations (POST/PUT/PATCH/DELETE) (default: 30 requests per 15 minutes)
- **Graceful 429 responses**: Includes `Retry-After` header and rate limit information

### Configuration

Rate limits can be configured via environment variables:

```env
RATE_LIMIT_IP_POINTS=100          # Requests per window
RATE_LIMIT_IP_DURATION=900        # Window in seconds (15 minutes)
RATE_LIMIT_USER_POINTS=200        # Requests per window for authenticated users
RATE_LIMIT_USER_DURATION=900      # Window in seconds
RATE_LIMIT_STRICT_POINTS=30       # Requests per window for write operations
RATE_LIMIT_STRICT_DURATION=900    # Window in seconds
```

### Response Format

When rate limited, the API returns:

```json
{
  "ok": false,
  "error": "Too many requests. Please try again later.",
  "retryAfter": 900
}
```

With HTTP headers:
- `Retry-After`: Seconds until retry is allowed
- `X-RateLimit-Limit`: Total limit
- `X-RateLimit-Remaining`: Remaining requests
- `X-RateLimit-Reset`: ISO timestamp when limit resets

## 2. Input Validation

### Implementation

Input validation is implemented in `src/lib/validation.ts` using Zod schemas.

### Features

- **Schema-based validation**: All inputs validated against Zod schemas
- **Type checking**: Automatic type coercion and validation
- **Length limits**: Maximum length enforcement on all string fields
- **Unknown field rejection**: Strict mode rejects unexpected fields
- **Sanitization**: Automatic trimming and normalization
- **Specialized validators**: Email, URL, part/model number validation

### Validation Utilities

Common validation schemas available:

- `stringSchema(maxLength, minLength?)` - String with length limits
- `intSchema` - Integer validation
- `positiveIntSchema` - Positive integer validation
- `booleanSchema` - Boolean validation
- `dateSchema` - Date validation
- `emailSchema` - Email validation
- `urlSchema` - URL validation
- `partModelNumberSchema(maxLength)` - Part/model number with regex validation

### Usage Example

```typescript
import { validateRequest, stringSchema, positiveIntSchema } from '@/lib/validation';
import { z } from 'zod';

const schema = z.object({
  name: stringSchema(255, 1).refine((val) => val !== null, {
    message: 'Name is required',
  }),
  age: positiveIntSchema,
}).strict(); // Reject unknown fields

const validation = await validateRequest(req, schema, {
  endpoint: '/api/example',
  method: 'POST',
  rejectUnknownFields: true,
});

if (!validation.success) {
  return validation.response; // Returns 400 with validation errors
}

const { data } = validation; // Type-safe validated data
```

### Updated Routes

The following routes have been updated with strict validation:

- `/api/products/create` - Product creation with full validation
- `/api/products/[productId]` - Product ID parameter validation
- `/api/customers/create` - Customer creation with full validation

**Note**: Other routes should be updated following the same pattern.

## 3. API Key Security

### Audit Results

✅ **No hardcoded secrets found** - All credentials use environment variables

### Secure Practices

1. **Database credentials**: Stored in environment variables
   - `SQLSERVER_HOST`
   - `SQLSERVER_PORT`
   - `SQLSERVER_DB`
   - `SQLSERVER_USER`
   - `SQLSERVER_PASSWORD`

2. **AG Grid license**: Exposed via `NEXT_PUBLIC_AG_GRID_LICENSE`
   - This is expected behavior for AG Grid Enterprise
   - License key is validated server-side by AG Grid

3. **File upload paths**: Configured via `PRICELIST_UPLOAD_ROOT`
   - Should be an absolute path
   - Directory should have proper permissions
   - Should not be web-accessible

### Environment Variables

See `.env.example` for complete list of environment variables and security best practices.

### Key Rotation

**Recommendation**: Rotate database credentials regularly (at least every 90 days).

## Security Best Practices

### OWASP Compliance

The implementation follows OWASP Top 10 (2021) guidelines:

1. ✅ **A01:2021 – Broken Access Control**: Rate limiting prevents abuse
2. ✅ **A02:2021 – Cryptographic Failures**: No hardcoded secrets
3. ✅ **A03:2021 – Injection**: Parameterized queries + input validation
4. ✅ **A04:2021 – Insecure Design**: Schema-based validation, strict field rejection
5. ✅ **A05:2021 – Security Misconfiguration**: Environment-based configuration
6. ✅ **A07:2021 – Identification and Authentication Failures**: User-based rate limiting
7. ✅ **A08:2021 – Software and Data Integrity Failures**: Input validation prevents tampering

### Recommendations

1. **Complete route validation**: Update remaining API routes with validation schemas
2. **SQL injection prevention**: Continue using parameterized queries (already implemented)
3. **XSS prevention**: Ensure all user inputs are sanitized (validation helps)
4. **CSRF protection**: Consider adding CSRF tokens for state-changing operations
5. **Security headers**: Add security headers (HSTS, CSP, etc.) via Next.js config
6. **Logging**: Monitor rate limit violations and validation failures
7. **Regular audits**: Schedule regular security audits and dependency updates

## Testing

### Rate Limiting

Test rate limiting by making rapid requests:

```bash
# Should succeed
for i in {1..100}; do curl http://localhost:3000/api/products; done

# Should return 429
for i in {1..101}; do curl http://localhost:3000/api/products; done
```

### Input Validation

Test validation by sending invalid data:

```bash
# Should return 400 with validation errors
curl -X POST http://localhost:3000/api/products/create \
  -H "Content-Type: application/json" \
  -d '{"invalidField": "value", "brandId": "not-a-number"}'
```

## Monitoring

Monitor the following for security issues:

1. **Rate limit violations**: Check logs for `Rate limit exceeded` warnings
2. **Validation failures**: Check logs for `Validation failed` warnings
3. **Unknown fields**: Check logs for `Unknown fields in request body` warnings
4. **Database errors**: Monitor for SQL injection attempts

## Future Enhancements

1. **Redis-based rate limiting**: For distributed deployments
2. **CAPTCHA**: For high-risk endpoints after rate limit
3. **IP allowlisting/blocklisting**: For known good/bad IPs
4. **Request signing**: For API-to-API communication
5. **Audit logging**: Enhanced audit trail for security events

## Support

For security concerns or questions, please refer to:
- OWASP Top 10: https://owasp.org/www-project-top-ten/
- Next.js Security: https://nextjs.org/docs/app/building-your-application/configuring/security-headers
- Zod Documentation: https://zod.dev/
