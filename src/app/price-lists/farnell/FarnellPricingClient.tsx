"use client";

import { useState, useCallback, type FormEvent } from "react";
import Link from "next/link";
import PageHeader from "../../components/PageHeader";
import layoutStyles from "../priceListDetail.module.css";
import styles from "./FarnellPricingClient.module.css";
import { getUserNumberLocale } from "../../../lib/localeNumber";

type FarnellPriceTier = {
  from: number;
  to: number;
  cost: number;
};

type FarnellProductResult = {
  sku: string;
  displayName: string;
  manufacturerPartNumber: string | null;
  brandName: string | null;
  description: string | null;
  productURL: string | null;
  stock: number | null;
  prices: FarnellPriceTier[];
  matchedPrice: number | null;
};

export default function FarnellPricingClient() {
  const [sku, setSku] = useState("");
  const [searchBy, setSearchBy] = useState<"code" | "description">("code");
  const [products, setProducts] = useState<FarnellProductResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const handleSearch = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      const trimmed = sku.trim();
      if (!trimmed) return;

      setLoading(true);
      setError(null);
      setProducts([]);
      setSearched(true);

      try {
        const searchType = searchBy === "description" ? "keyword" : "auto";
        const params = new URLSearchParams({ sku: trimmed, searchType, quantity: "1" });
        const res = await fetch(`/api/farnell/lookup?${params.toString()}`);
        const data = await res.json().catch(() => null);

        if (res.ok && data?.ok) {
          const list = Array.isArray(data.products)
            ? (data.products as FarnellProductResult[])
            : data.product
              ? [data.product as FarnellProductResult]
              : [];
          setProducts(list);
          return;
        }

        if (!res.ok && res.status !== 404) {
          setError(data?.error ?? `Request failed (${res.status})`);
          return;
        }

        setProducts([]);
      } catch {
        setError("Failed to reach the server. Please try again.");
      } finally {
        setLoading(false);
      }
    },
    [sku, searchBy],
  );

  const formatPrice = (value: number) =>
    `€ ${new Intl.NumberFormat(getUserNumberLocale(), {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value)}`;

  return (
    <main className={styles.page}>
      <PageHeader
        title="Farnell Pricing Lookup"
        leftActions={
          <Link
            href="/price-lists"
            className={`${layoutStyles.backLink} page-header-button`}
          >
            Back to Price Lists
          </Link>
        }
      >
        <div className={styles.searchCard}>
          <form className={styles.searchForm} onSubmit={handleSearch}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="farnell-search-by">
                Search by
              </label>
              <select
                id="farnell-search-by"
                className={styles.input}
                value={searchBy}
                onChange={(e) => setSearchBy(e.target.value as "code" | "description")}
              >
                <option value="code">Order Code / Part Number</option>
                <option value="description">Description</option>
              </select>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="farnell-sku">
                {searchBy === "code" ? "Order Code / Part Number" : "Description"}
              </label>
              <input
                id="farnell-sku"
                type="text"
                className={`${styles.input} ${styles.skuInput}`}
                placeholder={searchBy === "code" ? "Enter order code or part number" : "Enter product description keywords"}
                value={sku}
                onChange={(e) => setSku(e.target.value)}
              />
            </div>

            <button
              type="submit"
              className={styles.searchButton}
              disabled={loading || !sku.trim()}
            >
              {loading ? "Searching..." : "Search"}
            </button>
          </form>
        </div>

        <div className={styles.resultsPanel}>
          {!searched && !loading && (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </div>
              <p className={styles.emptyTitle}>Search Farnell Products</p>
              <p className={styles.emptyDescription}>
                Enter a Farnell order code, manufacturer part number, or description keywords to look up product details, stock levels, and pricing.
              </p>
            </div>
          )}

          {loading && (
            <div className={styles.emptyState}>
              <p className={styles.emptyTitle}>Searching...</p>
            </div>
          )}

          {error && <p className={`${styles.message} ${styles.error}`}>{error}</p>}

          {!loading && searched && products.length === 0 && !error && (
            <div className={styles.emptyState}>
              <p className={styles.emptyTitle}>No product found</p>
              <p className={styles.emptyDescription}>
                Try a different order code, part number, or description.
              </p>
            </div>
          )}

          {products.map((product) => (
            <div key={product.sku} className={styles.productCard}>
              <h2 className={styles.productName}>{product.displayName}</h2>

              <div className={styles.infoGrid}>
                <div className={styles.infoItem}>
                  <span className={styles.infoLabel}>Order Code</span>
                  <span className={styles.infoValue}>{product.sku}</span>
                </div>

                {product.manufacturerPartNumber && (
                  <div className={styles.infoItem}>
                    <span className={styles.infoLabel}>Manufacturer Part No.</span>
                    <span className={styles.infoValue}>
                      {product.manufacturerPartNumber}
                    </span>
                  </div>
                )}

                {product.brandName && (
                  <div className={styles.infoItem}>
                    <span className={styles.infoLabel}>Brand</span>
                    <span className={styles.infoValue}>{product.brandName}</span>
                  </div>
                )}

                <div className={styles.infoItem}>
                  <span className={styles.infoLabel}>Stock</span>
                  <span
                    className={
                      product.stock != null && product.stock > 0
                        ? styles.stockInStock
                        : styles.stockOutOfStock
                    }
                  >
                    {product.stock != null ? product.stock.toLocaleString() : "N/A"}
                  </span>
                </div>

                {product.description && (
                  <div className={`${styles.infoItem} ${styles.description}`}>
                    <span className={styles.infoLabel}>Description</span>
                    <span className={styles.infoValue}>{product.description}</span>
                  </div>
                )}

                <div className={styles.infoItem}>
                  <span className={styles.infoLabel}>Product Page</span>
                  <a
                    href={`https://be.farnell.com/en-BE/search?st=${encodeURIComponent(product.sku)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.productLink}
                  >
                    View on Farnell
                  </a>
                </div>
              </div>

              <div className={styles.priceTiersSection}>
                <span className={styles.sectionHeading}>Price Tiers</span>
                {product.prices.length > 0 ? (
                  <table className={styles.priceTiersTable}>
                    <thead>
                      <tr>
                        <th>Quantity</th>
                        <th>List Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {product.prices.map((tier, idx) => {
                        const isMatched =
                          product.matchedPrice != null &&
                          tier.cost === product.matchedPrice;
                        const isLast = idx === product.prices.length - 1;
                        return (
                          <tr
                            key={`${tier.from}-${tier.to}`}
                            className={isMatched ? styles.matchedRow : undefined}
                          >
                            <td>{isLast ? `${tier.from}+` : `${tier.from} – ${tier.to}`}</td>
                            <td>
                              {formatPrice(tier.cost)}
                              {isMatched && (
                                <span className={styles.matchedBadge}>
                                  Our Price
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <p className={styles.noPricing}>
                    No pricing data available for this product.
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </PageHeader>
    </main>
  );
}
