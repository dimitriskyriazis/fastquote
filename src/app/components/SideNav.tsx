"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import UserIdControl from "./UserIdControl";
import { useAuditUser } from "./AuditUserProvider";
import {
  HomeIcon,
  OffersIcon,
  PriceListsIcon,
  PricingPoliciesIcon,
  ProductsIcon,
  StandardPackagesIcon,
  CustomersIcon,
  ContactsIcon,
  SuppliersIcon,
  AdminIcon,
} from "./NavIcons";

type NavItem = {
  label: string;
  href: string;
  icon: ReactNode;
  requiresRoles?: string[];
};

const navItems: NavItem[] = [
  { label: "Home", href: "/", icon: <HomeIcon /> },
  { label: "Offers", href: "/offers", icon: <OffersIcon /> },
  { label: "Price Lists", href: "/price-lists", icon: <PriceListsIcon /> },
  { label: "Pricing Policies", href: "/pricing-policies", icon: <PricingPoliciesIcon /> },
  { label: "Products", href: "/products", icon: <ProductsIcon /> },
  { label: "Standard Packages", href: "/standard-packages", icon: <StandardPackagesIcon /> },
  { label: "Customers", href: "/customers", icon: <CustomersIcon /> },
  { label: "Contacts", href: "/contacts", icon: <ContactsIcon /> },
  { label: "Suppliers", href: "/suppliers", icon: <SuppliersIcon /> },
  { label: "Admin", href: "/user-management", icon: <AdminIcon />, requiresRoles: ["Administrator", "Developer"] },
];

const SIDENAV_COLLAPSED_COOKIE_NAME = "fastquote_sidenav_collapsed";

type SideNavProps = {
  initialCollapsed?: boolean;
};

export default function SideNav({ initialCollapsed = false }: SideNavProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const { roles } = useAuditUser();

  useEffect(() => {
    document.cookie = `${SIDENAV_COLLAPSED_COOKIE_NAME}=${collapsed ? "true" : "false"}; path=/; SameSite=Lax`;
  }, [collapsed]);

  const openSearch = useCallback(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  }, []);

  const visibleNavItems = useMemo(
    () =>
      navItems.filter((item) => {
        if (!item.requiresRoles || item.requiresRoles.length === 0) return true;
        return item.requiresRoles.some((role) => roles.includes(role));
      }),
    [roles],
  );

  return (
    <aside className="side-nav" data-collapsed={collapsed}>
      <div className="side-nav__header">
        <button
          type="button"
          className="side-nav__toggle"
          aria-pressed={collapsed}
          aria-label={collapsed ? "Expand menu" : "Collapse menu"}
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed}
        >
          <span aria-hidden="true" className="side-nav__toggle-icon">
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path
                d="M9 6l6 6-6 6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </button>
        <span className="side-nav__brand">FastQuote</span>
      </div>
      <button
        type="button"
        className="side-nav__link side-nav__search-trigger"
        onClick={openSearch}
        title="Search (Ctrl+K)"
        aria-label="Search"
      >
        <span className="side-nav__icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </span>
        <span className="side-nav__label">Search<span style={{ marginLeft: 8, fontSize: '0.72rem', opacity: 0.55 }}>Ctrl+K</span></span>
      </button>
      <div className="side-nav__divider" aria-hidden="true" />
      <nav className="side-nav__items" aria-label="Primary">
        {visibleNavItems.map((item) => {
        const active =
          item.href === '/'
            ? pathname === '/' || pathname === ''
            : pathname?.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className="side-nav__link"
              data-active={active}
              title={item.label}
            >
              <span className="side-nav__icon">{item.icon}</span>
              <span className="side-nav__label">{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="side-nav__divider" aria-hidden="true" />
      <UserIdControl collapsed={collapsed} />
    </aside>
  );
}
