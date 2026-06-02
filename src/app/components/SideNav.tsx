"use client";

import Image from "next/image";
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
  MarketingIcon,
  UserInfoIcon,
  AdminIcon,
} from "./NavIcons";

type SubItem = {
  label: string;
  href: string;
  requiresRoles?: string[];
};

type NavItem = {
  label: string;
  href: string;
  icon: ReactNode;
  requiresRoles?: string[];
  subItems?: SubItem[];
};

const navItems: NavItem[] = [
  { label: "Home", href: "/", icon: <HomeIcon /> },
  {
    label: "Offers", href: "/offers", icon: <OffersIcon />,
    subItems: [
      { label: "Offered Products", href: "/offered-products" },
    ],
  },
  {
    label: "Price Lists", href: "/price-lists", icon: <PriceListsIcon />,
    subItems: [
      { label: "Farnell Pricing Lookup", href: "/price-lists/farnell" },
      {
        label: "Pricelist Cleanup",
        href: "/price-lists/cleanup",
        requiresRoles: ["Administrator", "Developer"],
      },
    ],
  },
  { label: "Pricing Policies", href: "/pricing-policies", icon: <PricingPoliciesIcon /> },
  {
    label: "Products", href: "/products", icon: <ProductsIcon />,
    subItems: [
      { label: "Brands", href: "/brands" },
    ],
  },
  { label: "Standard Packages", href: "/standard-packages", icon: <StandardPackagesIcon /> },
  { label: "Customers", href: "/customers", icon: <CustomersIcon /> },
  { label: "Contacts", href: "/contacts", icon: <ContactsIcon /> },
  {
    label: "Suppliers", href: "/suppliers", icon: <SuppliersIcon />,
    subItems: [
      { label: "Manufacturer's Pipeline", href: "/manufacturers-pipeline" },
      { label: "Countries", href: "/countries" },
    ],
  },
  {
    label: "Marketing", href: "/marketing", icon: <MarketingIcon />,
    subItems: [
      { label: "Contact Groups", href: "/marketing/contact-groups" },
    ],
  },
  { label: "User Info", href: "/user-info", icon: <UserInfoIcon /> },
  {
    label: "Admin", href: "/user-management", icon: <AdminIcon />, requiresRoles: ["Administrator", "Developer"],
    subItems: [
      { label: "Markets", href: "/markets" },
      { label: "Customer Groups", href: "/customer-groups" },
      { label: "Logs", href: "/logs" },
    ],
  },
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

  const canSee = useCallback(
    (requiresRoles?: string[]) =>
      !requiresRoles ||
      requiresRoles.length === 0 ||
      requiresRoles.some((role) => roles.includes(role)),
    [roles],
  );

  const visibleNavItems = useMemo(
    () => navItems.filter((item) => canSee(item.requiresRoles)),
    [canSee],
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
        <Image
          src="/telmaco_logo_transparent_negative.png"
          alt="Telmaco"
          width={110}
          height={28}
          className="side-nav__brand"
          priority
        />
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
          const visibleSubItems = item.subItems?.filter((sub) => canSee(sub.requiresRoles)) ?? [];
          const subActive = visibleSubItems.some((sub) => pathname?.startsWith(sub.href));
          const expanded = active || subActive;
          return (
            <div key={item.href} className="side-nav__group">
              <Link
                href={item.href}
                className="side-nav__link"
                data-active={active && !subActive}
                title={item.label}
              >
                <span className="side-nav__icon">{item.icon}</span>
                <span className="side-nav__label">{item.label}</span>
              </Link>
              {visibleSubItems.length > 0 && expanded && (
                <div className="side-nav__sub-items">
                  {visibleSubItems.map((sub) => {
                    const subItemActive = pathname?.startsWith(sub.href);
                    return (
                      <Link
                        key={sub.href}
                        href={sub.href}
                        className="side-nav__sub-link"
                        data-active={subItemActive}
                        title={sub.label}
                      >
                        <span className="side-nav__sub-icon" aria-hidden="true">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 4v12h12" />
                          </svg>
                        </span>
                        <span className="side-nav__sub-label">{sub.label}</span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <div className="side-nav__divider" aria-hidden="true" />
      <UserIdControl collapsed={collapsed} />
    </aside>
  );
}
