"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import UserIdControl from "./UserIdControl";
import { useAuditUser } from "./AuditUserProvider";

type NavItem = {
  label: string;
  href: string;
  icon: ReactNode;
  requiresRoles?: string[];
};

const navItems: NavItem[] = [
  {
    label: "Home",
    href: "/",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M4 11.5L12 4l8 7.5v8a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        <path
          d="M7 21v-6.5h10V21"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    label: "Offers",
    href: "/offers",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M4.5 5.5h15v13h-15z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path
          d="M7.5 3.9h9v3.3h-9z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M8 10.5h4m-4 3h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: "Price Lists",
    href: "/price-lists",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="4.5" y="4.8" width="10.8" height="14.4" rx="1.6" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <path d="M7.2 8h5.8M7.2 11.1h5.8M7.2 14.2h4.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path
          d="M14.6 12.4h5l2 2-5.4 5.4-3-3V12.4z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
          fill="none"
        />
        <circle cx="17.6" cy="14.4" r="0.9" stroke="currentColor" strokeWidth="1.4" fill="none" />
      </svg>
    ),
  },
  {
    label: "Pricing Policies",
    href: "/pricing-policies",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M12 3.5l6 2.4v5.2c0 4.2-2.7 7.7-6 9.4-3.3-1.7-6-5.2-6-9.4V5.9L12 3.5z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
          fill="none"
        />
        <path
          d="M8.5 9.2h7M9.8 12h4.4M8.5 14.8h7"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <circle cx="9.3" cy="9.2" r="0.9" fill="currentColor" />
        <circle cx="14.8" cy="14.8" r="0.9" fill="currentColor" />
      </svg>
    ),
  },
  {
    label: "Products",
    href: "/products",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M12 4.3l7.5 4-7.5 4-7.5-4 7.5-4z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
          fill="none"
        />
        <path
          d="M4.5 8.3v7.8L12 20.7v-7.8M19.5 8.3v7.8L12 20.7"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    ),
  },
  {
    label: "Customers",
    href: "/customers",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="7.4" r="3.1" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <circle cx="6.4" cy="9.1" r="2.1" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <circle cx="17.6" cy="9.1" r="2.1" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <path
          d="M6.6 20c0-3 2.4-5.4 5.4-5.4s5.4 2.4 5.4 5.4"
          stroke="currentColor"
          strokeWidth="1.6"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M2.6 20c0-1.9 1.5-3.4 3.4-3.4M21.4 20c0-1.9-1.5-3.4-3.4-3.4"
          stroke="currentColor"
          strokeWidth="1.6"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    label: "Suppliers",
    href: "/suppliers",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M2 8h11v8H2z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
          fill="none"
        />
        <path
          d="M13 8h5l3 3v5h-8V8z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
          fill="none"
        />
        <circle cx="6.5" cy="18.5" r="2" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <circle cx="17.5" cy="18.5" r="2" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <path
          d="M13 16h-2.5M21 16h-1.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    label: "Countries & Cities",
    href: "/countries-cities",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <path
          d="M4 12h16M12 4a12 12 0 0 1 0 16M12 4a12 12 0 0 0 0 16"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    ),
  },
  {
    label: "User Management",
    href: "/user-management",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="3.5" y="4.5" width="17" height="15" rx="2" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <circle cx="8.5" cy="10" r="2.2" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <path
          d="M5.8 16c0-1.6 1.3-2.9 2.9-2.9s2.9 1.3 2.9 2.9"
          stroke="currentColor"
          strokeWidth="1.6"
          fill="none"
          strokeLinecap="round"
        />
        <path d="M14 9.2h4.5M14 12.2h4.5M14 15.2h3.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
    requiresRoles: ["Administrator", "Developer"],
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
