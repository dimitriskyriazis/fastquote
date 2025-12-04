"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import UserIdControl from "./UserIdControl";

type NavItem = {
  label: string;
  href: string;
  icon: ReactNode;
};

const navItems: NavItem[] = [
  {
    label: "Offers",
    href: "/offers",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M4.5 5.5h15v13h-15z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path
          d="M7.5 3.9h9v3.3h-9z"
          stroke="currentColor"
          strokeWidth="1.8"
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
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M8 4h10v16H6V6z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
          fill="none"
        />
        <path d="M10 8h6m-6 4h6m-6 4h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path
          d="M6 6h2v4H4V8a2 2 0 0 1 2-2z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    ),
  },
  {
    label: "Products",
    href: "/products",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <rect x="14" y="14" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.6" fill="none" />
      </svg>
    ),
  },
  {
    label: "Customers",
    href: "/customers",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <circle cx="16" cy="8" r="3" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <path
          d="M4.5 19c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5"
          stroke="currentColor"
          strokeWidth="1.6"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M11 18.5c0-2.3 1.8-4.2 4-4.2s4 1.9 4 4.2"
          stroke="currentColor"
          strokeWidth="1.6"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
];

export default function SideNav() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(true);

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
        {navItems.map((item) => {
          const active = pathname?.startsWith(item.href);
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
