# FastQuote

FastQuote is a Next.js application for managing commercial offers, pricing, and supporting data (products, customers, price lists, payment terms, markets, and approvals). It provides a dashboard for recent offers and workflow-focused pages for quoting, pricing, marketing, and Soft1 ERP integration.

## Features

- **Offers**: dashboard with recent activity, offer creation, versioning, copy and draft offers, status history, currency support, PDF export with per-offer settings, priced services and comments, project form (.docx) fill, and AVC4 / EP LINC export templates
- **Offer Products**: AG Grid editing with undo, paste-in of product lists, AI product search and suggestions, requested-product matching, a pivot panel by brand and category, and per-line pricing driven by the pricing engine
- **Offered Products**: cross-offer grid of every offered line, filterable to latest offer versions only
- **Products**: catalogue with history, lookup tools, AI description enhancement, shortening and capitalisation fixes, weblink finder (Serper search plus rendered-page verification), model number maintenance, and Farnell component search
- **Services**: printable and non-printable service line items that can be added to offers alongside products, including per-day decimal quantities
- **Customers**: customer master data, customer groups, contacts, ERP customer linking, standing payment term, duplicate detection, and a merge tool
- **Price Lists**: Excel import with header detection, date validation and scheduled activation, brand/supplier association, status tracking, replacement sweeps, an AI-assisted cleanup workflow for PDF price lists, and a Farnell pricing lookup page
- **Pricing Policies**: rule matrices and brand-level pricing management
- **Payment Terms**: catalogue of payment terms assignable to customers and offers, gated to Finance Manager and Administrator
- **Standard Packages**: pre-configured product bundles
- **Marketing**: contact groups, mail lists with export, merge and restore
- **Manufacturer's Pipeline**: per-brand view of offered products for supplier reporting
- **Reference Data**: brands, suppliers, markets, countries, cities, and titles
- **User Management**: user administration with role assignment, plus a User Info page for the signed-in user
- **Logs**: audit logging with request ID tracking and timestamp filtering
- **Search**: command palette (Ctrl+K) across pages and entities
- **Role-Based Access Control**: 7 roles and 16 permission types across all modules
- **Single Sign-On**: Windows authentication through IIS, mapped to application users and a signed session cookie
- **Rate Limiting**: per-IP, per-user, and strict-operation throttling for API endpoints
- **Soft1 ERP Integration**: draft order wizard that creates ERP items, manufacturers, projects, and draft orders via the Soft1 Web Services API, with a completion email
- **Real-time Updates**: Server-Sent Events (SSE) channel for pushing live status changes to the browser
- **User Guide**: generated Word document served from `public/FastQuoteUserGuide.docx`

## Tech Stack

- **Framework:** Next.js 16 (App Router) with React 19 and TypeScript 5
- **Runtime:** Node.js 22.22.0 (pinned in `package.json` engines)
- **Database:** Microsoft SQL Server via `mssql`, with optional Windows integrated auth through `msnodesqlv8`
- **Data Grids:** AG Grid Enterprise 34
- **Styling:** CSS Modules
- **Validation:** zod
- **PDF Generation:** pdfmake
- **Spreadsheets:** SheetJS `xlsx` (pinned to the SheetJS CDN tarball, see `DEPENDENCIES.md`) and jszip
- **Email:** nodemailer over SMTP
- **AI Integration:** OpenAI API (product suggestions and reranking, description enhancement, weblink proposals, price-list cleanup, ERP item categorisation)
- **External APIs:** Farnell component lookup, Serper search
- **Headless Browser:** Playwright, loaded at runtime to render JavaScript-only catalogue pages during weblink discovery
- **Rate Limiting:** rate-limiter-flexible
- **Authentication:** session cookies signed with HMAC-SHA256, sliding renewal with an absolute cap
- **ERP Integration:** Soft1 Web Services (login, setItem, setProject, setDocs) plus direct reads from the ERP database
- **Testing:** vitest unit tests, ESLint, and `tsc --noEmit`
- **Hosting:** PM2 process behind an IIS reverse proxy

## Architecture Overview

FastQuote uses the Next.js App Router with server-side route handlers for data access and mutations. Most pages are client components that render data-heavy grids and modals, backed by API routes that apply authentication, authorization, rate limiting, validation, and database queries.

Key architectural elements:

- Dual database connectivity (`FastQuote` and `SOFT1_ERP`) with pooled SQL connections
- 130+ API route handlers for CRUD, workflow actions, and integrations
- Shared validation, formatting, and search utilities in `src/lib` (Greek accent-insensitive and punctuation-insensitive search included)
- Role-aware authorization with 7 roles (Developer, Administrator, Back Office User, Finance Manager, Sales Manager, Sales Team, Simple User) and 16 permission types
- Windows SSO: IIS stamps an `X-Windows-User` header that `/api/me` and `/api/sso` resolve to an application user before minting the session cookie
- Session cookies with cryptographic signing, configurable TTL, and renewal in middleware without a new Active Directory round-trip
- Rate limiting at the API boundary keyed per user when a session exists and per IP otherwise
- Audit trail for all mutations with request ID traceability
- Server-Sent Events (`/api/realtime`) for live progress updates to the client
- Soft1 ERP integration layer (`src/lib/softone.ts`, `itemCreationWS.ts`, `orderCreationWS.ts`, `projectCreationWS.ts`) for creating ERP entities from accepted offers
- Core pricing engine (`src/lib/pricing.ts`) with eight resolution scenarios, single-field cascade rules, an additional customer discount, and a Keep Net / Keep Margin toggle

## Project Structure

```
src/
  app/
    api/                    API route handlers (offers, products, customers, price-lists, marketing, realtime, sso, ...)
    components/             Shared UI (SideNav, CommandPalette, DatePicker, AgGridAll, LookupModal, ...)
    hooks/                  Custom hooks (useFormDraft, useUndoStack, useGridUrlState, useRealtimeGridUpdates, ...)
    lib/                    Client-side utilities and formatting
    styles/                 Global styles
    offers/                 Offer list, create page, basic data (with the draft order wizard), and products grid
    offered-products/       Cross-offer grid of offered lines
    products/               Product pages with history components
    customers/              Customer pages, duplicates, and merge tool
    price-lists/            Price list pages, import, cleanup, and Farnell pricing lookup
    pricing-policies/       Pricing policy pages
    payment-terms/          Payment term catalogue
    standard-packages/      Standard package management
    marketing/              Mail lists and contact groups
    manufacturers-pipeline/ Per-brand offered products
    user-management/        User administration
    user-info/              Signed-in user details
    logs/                   Audit log viewer
    [reference data]        brands, suppliers, markets, countries, contacts, customer-groups, customer-contacts
  lib/                      Server-side: DB pools, auth, roles, validation, PDF, ERP integration, pricing engine
types/                      Ambient type declarations (mssql, jszip, exceljs)
public/                     Static assets and the generated user guide
docs/user-guide/            Source for the user guide (content/*.js and screenshots, built with npm run build)
scripts/
  iis/                      Deploy script, web.config, maintenance page, Windows user header module
  sql/                      One-off SQL scripts to run against the database (archived after use)
  telquote-import/          Legacy TelQuote offer migration tooling
middleware.ts               Authentication, session renewal, rate limiting, request tracking
ecosystem.config.cjs        PM2 process definition (gitignored, holds production environment)
DEPENDENCIES.md             Why the non-obvious package.json entries and overrides exist
```

## Data Flow

1. A page client requests data via an internal API route.
2. Middleware verifies the session cookie, renews it when due, applies rate limiting, and attaches a request ID.
3. The API route validates inputs and checks the caller's permissions.
4. The route queries SQL Server (FastQuote and/or ERP) and writes an audit record for mutations.
5. Results are normalized and returned to the client for rendering.
6. For ERP operations (draft order creation), the route calls Soft1 Web Services to create items, manufacturers, a project, and an order, then sends a completion email and emits an SSE event to update the browser.

## ERP Integration (Draft Order Wizard)

When an offer is accepted, the **Draft Order Wizard** on the offer's basic data page walks through these steps via Soft1 Web Services:

1. **Customer**: resolves the FastQuote customer to a Soft1 customer (TRDR) and loads the offer's discount and option-line state.
2. **Options** (only when the offer has option lines): choose whether option lines go on the order.
3. **Brands**: checks which brands exist in the ERP as manufacturers and creates the missing ones.
4. **Products**: matches FastQuote products to ERP items by part number / model number, with manual search for unmatched lines.
5. **Compare**: side-by-side review of offer lines against ERP items, where per-line comments (Σχόλια) for the order are authored.
6. **Categories**: AI-assisted category, subcategory, and type assignment for items that must be created.
7. **Discount** (only when the offer carries an additional discount): choose whether the discount goes into the unit prices or onto the document header.
8. **Summary**: review of everything that will be created or linked.
9. **Execute**: creates items, the project (PRJC), and the draft sales order (FINDOC), then sends the completion email. SSE events keep the wizard updated with live progress.

Services are never sent to the ERP; only product lines become order lines.

## Pricing Engine

The pricing engine (`src/lib/pricing.ts`) resolves a full `PricingSnapshot` (list price, customer discount, additional customer discount, Telmaco discount, net unit price, net cost, margin) from whatever the user has provided:

- **Eight resolution scenarios** (A to H) cover the combinations of provided fields when a valid list price anchors the row, used for bulk paste, row creation, and import.
- **Single-field cascade** handles the common one-cell edit with a fixed table of which fields hold and which recompute.
- **Keep Net / Keep Margin** is the single behaviour toggle (offer default, optionally overridden per row). On cost-side edits Keep Net holds the net unit price and customer discount while margin floats; Keep Margin holds margin and recomputes the net price and discount.
- **Additional customer discount** stacks on the customer discount before it is applied to the list price.
- **Rounding**: monetary values round to 4 decimals; a sell price derived from a typed margin gets magnitude-based commercial rounding. Percent columns are clamped to what the DECIMAL(5,2) storage allows.
- **Markup** is never stored; it is derived from margin and edits are routed through the margin column.

## Environment Variables

Key configuration (set in `.env.local` for development; production values live in `ecosystem.config.cjs`, which is gitignored):

| Variable | Purpose |
|---|---|
| `FASTQUOTE_HOST`, `FASTQUOTE_PORT`, `FASTQUOTE_DB`, `FASTQUOTE_USER`, `FASTQUOTE_PASSWORD` | Primary database connection |
| `FASTQUOTE_INTEGRATED`, `FASTQUOTE_ENCRYPT`, `FASTQUOTE_TRUST_CERT`, `FASTQUOTE_REQUEST_TIMEOUT` | Primary connection options (Windows auth, TLS, timeout) |
| `SOFT1_ERP_HOST`, `SOFT1_ERP_PORT`, `SOFT1_ERP_DB`, `SOFT1_ERP_USER`, `SOFT1_ERP_PASSWORD` | ERP database connection (same option variables as above with the `SOFT1_ERP_` prefix) |
| `SOFTONE_WS_ENDPOINT`, `SOFTONE_WS_API_ENDPOINT` | Soft1 Web Services URLs |
| `SOFTONE_WS_USERNAME`, `SOFTONE_WS_PASSWORD`, `SOFTONE_WS_APP_ID` | Soft1 Web Services credentials |
| `SESSION_SECRET` | Required. Signs session cookies; without it every request falls back to the anonymous IP bucket |
| `SESSION_TTL_SECONDS`, `SESSION_RENEW_WINDOW_SECONDS`, `SESSION_ABSOLUTE_TTL_SECONDS`, `SESSION_COOKIE_SECURE` | Session lifetime, sliding renewal window, absolute cap, cookie Secure flag |
| `AUTH_REQUIRE_SESSION` | When `true`, middleware rejects API calls without a valid session |
| `RATE_LIMIT_IP_POINTS`, `RATE_LIMIT_IP_DURATION` | Anonymous per-IP bucket |
| `RATE_LIMIT_USER_POINTS`, `RATE_LIMIT_USER_DURATION` | Authenticated per-user bucket |
| `RATE_LIMIT_STRICT_POINTS`, `RATE_LIMIT_STRICT_DURATION` | Bucket for expensive or destructive operations |
| `OPENAI_API_KEY`, `WEBLINK_SEARCH_MODEL`, `WEBLINK_JUDGE_MODEL` | AI features and model overrides for the weblink finder |
| `FARNELL_API_KEY` | Farnell component lookup |
| `SERPER_API_KEY` | Google search via Serper |
| `PRICELIST_UPLOAD_ROOT` | Price list file upload directory |
| `MAILS_EXPORT_ROOT` | Marketing mail export directory |
| `PROJECT_FORM_TEMPLATE_PATH` | Empty project form .docx used by the project form fill |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Email for draft order completion notifications |
| `NEXT_PUBLIC_AG_GRID_LICENSE` | AG Grid Enterprise licence key |
| `AUDIT_DEFAULT_USER_ID`, `DEFAULT_ASPNET_USER_ID` | Fallback identities for audit rows written outside a user session |
| `DEV_AUTO_USER_ID`, `DEV_MOCK_USERS` | Development only: auto sign-in user id and mock user list when no IIS or DB is present |

## Getting Started

```bash
npm install
npm run dev
```

The app runs on `http://localhost:3000` by default. Under `next dev` there is no IIS to provide a Windows identity, so set `DEV_AUTO_USER_ID` to an existing `AspNetUsers` id to be signed in automatically.

Useful scripts:

```bash
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit (cleans stale Next type stubs first)
npm test            # lint + typecheck
npx vitest run      # unit tests (src/**/*.test.ts)
```

## Deployment

Production runs as a PM2 process (`ecosystem.config.cjs`) listening on 127.0.0.1:3000 behind an IIS site that reverse-proxies to it. The IIS pieces live in `scripts/iis`:

- `deploy.ps1` pulls, builds, and restarts under a maintenance gate, keeping the previous build for rollback if anything fails.
- `fastquote.web.config` holds the proxy rules, the maintenance-mode rewrite, and error pass-through so JSON error bodies reach the browser.
- `WindowsUserHeaderModule.cs` stamps the authenticated Windows user onto the request for SSO.

## Notes

- Integrated SQL auth requires the native driver (`msnodesqlv8`) and a Windows environment with trusted connection support.
- `/api/health` is an anonymous liveness probe for IIS and uptime monitors. `/api/erp/smoke-test` verifies ERP connectivity.
- AG Grid requires an enterprise licence for grouping, pivoting, filtering, and export features.
- `/api/realtime` uses Server-Sent Events, so no WebSocket infrastructure is needed, but the reverse proxy must allow long-lived HTTP connections.
- Never run `npm audit fix --force`; it downgrades Next.js. See `DEPENDENCIES.md` for the overrides and why they exist.
- The user guide is generated. Edit `docs/user-guide/content` and rebuild rather than editing the .docx by hand.
