# FastQuote

FastQuote is a Next.js application for managing commercial offers, pricing, and supporting data (products, customers, price lists, markets, and approvals). It provides a dashboard for recent offers and workflow-focused pages for quoting, pricing, and ERP integration.

## Features

- **Offers** — Dashboard with recent activity, offer creation, versioning, status tracking, currency support, PDF export, and draft workflows
- **Products** — Catalog with history, lookup tools, AI-powered suggestions, description enhancement, and Farnell component search
- **Services** — Printable and non-printable service line items that can be added to offers alongside products
- **Customers** — Customer master data, customer groups, and contact management
- **Price Lists** — Import support, date validation, brand/supplier association, and status tracking
- **Pricing Policies** — Rule matrices and brand-level pricing management with configurable sell anchors and margin hold behaviour
- **Standard Packages** — Pre-configured product bundles
- **Marketing** — Contact groups, email campaigns, and export functionality
- **Reference Data** — Brands, suppliers, markets, countries, cities, and titles
- **User Management** — User administration with role assignment
- **Logs** — Audit logging with request ID tracking and timestamp filtering
- **Role-Based Access Control** — 6 roles with granular permissions across all modules
- **Rate Limiting** — Per-IP and per-user throttling for API endpoints
- **Soft1 ERP Integration** — Draft order wizard that creates ERP items, manufacturers, projects, and orders via the Soft1 Web Services API, with completion email notification
- **Real-time Updates** — Server-Sent Events (SSE) channel for pushing live status changes to the browser

## Tech Stack

- **Framework:** Next.js (App Router) with React and TypeScript
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
- **ERP Integration:** Soft1 ERP via REST web services (login, setItem, setProject, createOrder, etc.)

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
- Server-Sent Events (`/api/realtime`) for live progress updates to the client
- Soft1 ERP integration layer (`src/lib/softone.ts`, `itemCreationWS.ts`, `orderCreationWS.ts`, `projectCreationWS.ts`) for creating ERP entities (items, manufacturers, projects, draft orders) from accepted offers
- Core pricing engine (`src/lib/pricing.ts`) supporting 8 resolution scenarios, configurable sell anchors (`netUnitPrice` / `customerDiscount` / `margin`), additional customer discounts, and hold-margin-on-cost behaviour

## Project Structure

```
src/
├── app/
│   ├── api/              — API route handlers (offers, products, pricing, marketing, realtime, etc.)
│   ├── components/       — Shared UI components (SideNav, CommandPalette, DatePicker, AgGridAll, etc.)
│   ├── hooks/            — Custom hooks (useFormDraft, useUndoStack, useCaretKeeper, useFarnellSearch, etc.)
│   ├── lib/              — Client-side utilities and formatting
│   ├── styles/           — Global styles
│   ├── offers/           — Offer pages and detail views (basic data, products, PDF export, draft order wizard)
│   ├── products/         — Product pages with history components
│   ├── customers/        — Customer management pages
│   ├── price-lists/      — Price list pages with import
│   ├── pricing-policies/ — Pricing policy pages
│   ├── standard-packages/— Standard package management
│   ├── marketing/        — Contact groups and email campaigns
│   ├── user-management/  — User administration
│   ├── logs/             — Audit log viewer
│   └── [reference data]  — Brands, suppliers, markets, countries, contacts
├── lib/                  — Server-side: DB connections, auth, roles, validation, PDF, ERP integration, pricing engine
├── types/                — TypeScript type definitions
public/                   — Static assets
middleware.ts             — Authentication, rate limiting, request tracking
```

## Data Flow

1. A page client requests data via an internal API route.
2. The API route validates inputs, applies authorization and rate limiting.
3. The route queries SQL Server (FastQuote and/or ERP).
4. Results are normalized and returned to the client for rendering.
5. For ERP operations (draft order creation), the route calls Soft1 Web Services to create items, manufacturers, a project, and an order — then sends a completion email and emits a real-time SSE event to update the browser.

## ERP Integration (Draft Order Wizard)

When an offer is accepted, the **Draft Order Wizard** walks through the following steps via Soft1 Web Services:

1. **Product sync** — matches FastQuote products to ERP items by part number / model number; creates new ERP items (and manufacturers if needed) for unmatched products using AI-assisted categorisation.
2. **Project creation** — creates or links to a Soft1 project (`PRJC`) using offer metadata (customer, salesman, order value, assign date, etc.).
3. **Order creation** — creates a draft sales order (`FINDOC`) with line items, prices, and quantities.
4. **Completion email** — sends a summary email (brands created, products created/linked, order reference).
5. **Real-time feedback** — SSE events keep the wizard UI updated with live progress as each step completes.

## Pricing Engine

The pricing engine (`src/lib/pricing.ts`) resolves a full `PricingSnapshot` from any combination of user-provided fields:

- **8 resolution scenarios** covering all combinations of list price, customer discount, Telmaco discount, net unit price, net cost, and margin.
- **Sell anchor** — controls which field is held when list price is edited: `netUnitPrice` (default), `customerDiscount`, or `margin`.
- **Additional customer discount** — an extra percentage stacked on top of the customer discount before applying to list price.
- **Hold margin on cost change** — when enabled, changing net cost recomputes the net price to preserve the current margin.

## Environment Variables

Key configuration (set in `.env.local`):

| Variable | Purpose |
|---|---|
| `FASTQUOTE_HOST`, `FASTQUOTE_PORT`, `FASTQUOTE_DB` | Primary database connection |
| `SOFT1_ERP_HOST`, `SOFT1_ERP_PORT`, `SOFT1_ERP_DB` | ERP database connection |
| `SOFT1_ENDPOINT`, `SOFT1_API_ENDPOINT` | Soft1 Web Services URLs |
| `SOFT1_USERNAME`, `SOFT1_PASSWORD`, `SOFT1_APP_ID` | Soft1 authentication credentials |
| `OPENAI_API_KEY` | AI product suggestions and descriptions |
| `FARNELL_API_KEY` | Farnell component lookup |
| `SERPER_API_KEY` | Google search integration |
| `RATE_LIMIT_IP_POINTS`, `RATE_LIMIT_IP_DURATION` | Rate limiting configuration |
| `PRICELIST_UPLOAD_ROOT` | Price list file upload directory |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Email (draft order completion notifications) |

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
- The `/api/realtime` endpoint uses Server-Sent Events (SSE) — no WebSocket infrastructure needed, but long-lived HTTP connections must be supported by any reverse proxy.
