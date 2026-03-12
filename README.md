# FastQuote

FastQuote is a Next.js application for managing commercial offers, pricing, and the supporting data (products, customers, price lists, markets, and approvals). It provides a dashboard for recent offers and workflow-focused pages for quote and pricing operations.

## Features

- **Offers** — Dashboard with recent activity, offer creation, versioning, status tracking, PDF export, and draft workflows
- **Products** — Catalog with history, lookup tools, AI-powered suggestions, and description enhancement
- **Customers** — Customer master data, customer groups, and contact management
- **Price Lists** — Import support, date validation, brand/supplier association, and status tracking
- **Pricing Policies** — Rule matrices and brand-level pricing management
- **Standard Packages** — Pre-configured product bundles
- **Marketing** — Contact groups, email campaigns, and export functionality
- **Reference Data** — Brands, suppliers, markets, countries, cities, and titles
- **User Management** — User administration with role assignment
- **Logs** — Audit logging with request ID tracking and timestamp filtering
- **Role-Based Access Control** — 6 roles with granular permissions across all modules
- **Rate Limiting** — Per-IP and per-user throttling for API endpoints

## Tech Stack

- **Framework:** Next.js 16 (App Router) with React 19 and TypeScript
- **Database:** Microsoft SQL Server via `mssql` with optional Windows auth (`msnodesqlv8`)
- **Data Grids:** AG Grid Enterprise
- **Styling:** CSS Modules
- **Validation:** Zod
- **PDF Generation:** pdfmake
- **Spreadsheets:** xlsx
- **Date Handling:** date-fns
- **AI Integration:** OpenAI API (product suggestions and description enhancement)
- **External APIs:** Farnell component lookup, Serper search
- **Rate Limiting:** rate-limiter-flexible
- **Authentication:** Session-based with HMAC-SHA256 signed cookies

## Architecture Overview

FastQuote uses the Next.js App Router with server-side route handlers for data access and mutations. Most pages are client components that render data-heavy grids and modals, backed by API routes that apply authentication, rate limiting, validation, and database queries.

Key architectural elements:

- Dual database connectivity (`FastQuote` + `Soft1 ERP`) with pooled SQL connections
- 100+ API route handlers for CRUD, workflow actions, and integrations
- Shared validation and formatting utilities in `src/lib`
- Role-aware authorization with 6 roles and 10 permission types
- Session cookies with cryptographic signing and configurable TTL
- Rate limiting at the API boundary for read/write throttling
- Audit trail for all mutations with request ID traceability

## Project Structure

```
src/
├── app/
│   ├── api/              — API route handlers (offers, products, pricing, marketing, etc.)
│   ├── components/       — Shared UI components (SideNav, CommandPalette, DatePicker, etc.)
│   ├── hooks/            — Custom hooks (useFormDraft, useUndoStack, useCaretKeeper, etc.)
│   ├── lib/              — Client-side utilities and formatting
│   ├── styles/           — Global styles
│   ├── offers/           — Offer pages and detail views
│   ├── products/         — Product pages with history components
│   ├── customers/        — Customer management pages
│   ├── price-lists/      — Price list pages with import
│   ├── pricing-policies/ — Pricing policy pages
│   ├── standard-packages/— Standard package management
│   ├── marketing/        — Contact groups and email campaigns
│   ├── user-management/  — User administration
│   ├── logs/             — Audit log viewer
│   └── [reference data]  — Brands, suppliers, markets, countries, contacts
├── lib/                  — Server-side: DB connections, auth, roles, validation, PDF, export
├── types/                — TypeScript type definitions
public/                   — Static assets
middleware.ts             — Authentication, rate limiting, request tracking
```

## Data Flow

1. A page client requests data via an internal API route.
2. The API route validates inputs, applies authorization and rate limiting.
3. The route queries SQL Server (FastQuote and/or ERP).
4. Results are normalized and returned to the client for rendering.

## Environment Variables

Key configuration (set in `.env.local`):

| Variable | Purpose |
|---|---|
| `FASTQUOTE_HOST`, `FASTQUOTE_PORT`, `FASTQUOTE_DB` | Primary database connection |
| `SOFT1_ERP_HOST`, `SOFT1_ERP_PORT`, `SOFT1_ERP_DB` | ERP database connection |
| `OPENAI_API_KEY` | AI product suggestions and descriptions |
| `FARNELL_API_KEY` | Farnell component lookup |
| `SERPER_API_KEY` | Google search integration |
| `RATE_LIMIT_IP_POINTS`, `RATE_LIMIT_IP_DURATION` | Rate limiting configuration |
| `PRICELIST_UPLOAD_ROOT` | Price list file upload directory |

## Getting Started

```bash
npm install
npm run dev
```

The app runs on `http://localhost:3000` by default.

## Notes

- Integrated SQL auth requires the native driver (`msnodesqlv8`) and a Windows environment with trusted connection support.
- The ERP smoke test endpoint (`/api/erp/smoke-test`) can verify ERP connectivity.
- AG Grid requires an enterprise license for grouping, filtering, and export features.
