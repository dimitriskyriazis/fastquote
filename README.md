# FastQuote

FastQuote is a Next.js application for managing commercial offers, pricing, and the supporting data (products, customers, price lists, markets, and approvals). It provides a dashboard for recent offers and workflow-focused pages for quote and pricing operations.

## Features

- Offers dashboard with recent activity, actions, and drill‑downs
- Offer detail flow (basic data, products, contacts, requested items)
- Products catalog with history and product lookup tools
- Customer, customer group, and contact management
- Price lists with import support and validation
- Pricing policies and rule matrices
- Market and reference data management
- Role-aware access control for protected routes and actions
- Rate limiting and audit user resolution for sensitive endpoints

## Tech Stack

- Next.js (App Router)
- React + TypeScript
- MSSQL via `mssql` with optional integrated Windows auth (`msnodesqlv8`)
- AG Grid Enterprise for data-heavy grids
- CSS Modules and project styles
- Zod for request validation
- date-fns for date handling
- rate-limiter-flexible for API rate limiting

## What It Does

FastQuote centralizes quote creation and pricing workflows. Users can browse and manage offers, attach products, import price lists, and reference customers and market data. The UI surfaces recent work and provides dedicated screens for data-intensive tasks (offers, products, pricing policies).

API routes back the UI with typed data retrieval and mutation endpoints, including offer creation, product matching, price list imports, and reference data lookups. The app connects to two SQL Server databases: the primary FastQuote database and a Soft1 ERP database for integration and lookups.

## Architecture Overview

FastQuote uses the Next.js App Router with server-side route handlers for data access and mutations. Most pages are client components that render data-heavy grids and modals, backed by API routes that apply authentication, rate limiting, validation, and database queries.

Key architectural elements:

- Dual database connectivity (`FastQuote` + `Soft1 ERP`) with pooled SQL connections
- API route handlers for CRUD and workflow actions
- Shared validation and formatting utilities in `src/lib`
- Role-aware authorization utilities and session cookies
- Rate limiting at the API boundary for read/write throttling

## Project Structure

- `src/app` — App Router pages, route handlers, and UI
- `src/app/api` — API route handlers (data access, mutations, imports)
- `src/app/components` — shared UI components
- `src/app/hooks` — UI hooks and grid helpers
- `src/app/*/*Client.tsx` — primary page clients and feature modules
- `src/app/*/*.module.css` — CSS Modules per feature
- `src/lib` — database access, auth, validation, formatting, utilities
- `public` — static assets

## Data Flow

1. A page client requests data via an internal API route.
2. The API route validates inputs, applies authorization and rate limiting.
3. The route queries SQL Server (FastQuote and/or ERP).
4. Results are normalized and returned to the client for rendering.

## Notes

- Integrated SQL auth requires the proper native driver (`msnodesqlv8`) and a Windows environment with trusted connection support.
