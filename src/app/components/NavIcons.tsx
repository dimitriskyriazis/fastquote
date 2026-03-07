import type { ReactNode } from "react";

type IconProps = { size?: number };

const s = (size: number) => ({ width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": true as const, focusable: false as const });

export function HomeIcon({ size = 22 }: IconProps): ReactNode {
  return (
    <svg {...s(size)}>
      <path d="M3 10.5L12 3l9 7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M5 9.5v9a1.5 1.5 0 001.5 1.5h4V15h3v5h4a1.5 1.5 0 001.5-1.5v-9" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export function OffersIcon({ size = 22 }: IconProps): ReactNode {
  return (
    <svg {...s(size)}>
      <path d="M14 3H6.5A1.5 1.5 0 005 4.5v15A1.5 1.5 0 006.5 21h11a1.5 1.5 0 001.5-1.5V8z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
      <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
      <path d="M8 13h8M8 16.5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function PriceListsIcon({ size = 22 }: IconProps): ReactNode {
  return (
    <svg {...s(size)}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <path d="M7 8.5h10M7 12h10M7 15.5h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="17" cy="17" r="0" stroke="none" fill="none" />
    </svg>
  );
}

export function PricingPoliciesIcon({ size = 22 }: IconProps): ReactNode {
  return (
    <svg {...s(size)}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <path d="M14.5 9.5c-.4-1-1.3-1.5-2.5-1.5-1.7 0-2.5.9-2.5 2s.8 1.7 2.5 2c1.7.3 2.5 1 2.5 2s-.8 2-2.5 2c-1.2 0-2.1-.5-2.5-1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M12 6.5v1.5M12 16v1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function ProductsIcon({ size = 22 }: IconProps): ReactNode {
  return (
    <svg {...s(size)}>
      <path d="M21 8l-9-4.5L3 8l9 4.5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
      <path d="M3 8v8l9 4.5V12M21 8v8l-9 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
      <path d="M12 12.5v8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function StandardPackagesIcon({ size = 22 }: IconProps): ReactNode {
  return (
    <svg {...s(size)}>
      <rect x="4" y="8" width="16" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <path d="M4 12h16" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10 12v8M14 12v8" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 8V5.5A1.5 1.5 0 019.5 4h5A1.5 1.5 0 0116 5.5V8" stroke="currentColor" strokeWidth="1.6" fill="none" />
    </svg>
  );
}

export function CustomersIcon({ size = 22 }: IconProps): ReactNode {
  return (
    <svg {...s(size)}>
      <circle cx="9" cy="7.5" r="3" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <circle cx="17.5" cy="8.5" r="2.2" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <path d="M16 14.2c.5-.1 1-.2 1.5-.2 2.5 0 4.5 2 4.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function ContactsIcon({ size = 22 }: IconProps): ReactNode {
  return (
    <svg {...s(size)}>
      <rect x="4" y="3" width="16" height="18" rx="2" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <circle cx="12" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <path d="M8 17c0-2.2 1.8-4 4-4s4 1.8 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M2 7h2M2 12h2M2 17h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function SuppliersIcon({ size = 22 }: IconProps): ReactNode {
  return (
    <svg {...s(size)}>
      <path d="M1.5 14.5h13v-8h-13z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
      <path d="M14.5 9h4l3.5 3.5v2h-7.5V9z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
      <circle cx="5.5" cy="17" r="2.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <circle cx="18" cy="17" r="2.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <path d="M8 14.5h6.5M20.5 14.5H22" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function AdminIcon({ size = 22 }: IconProps): ReactNode {
  return (
    <svg {...s(size)}>
      <path d="M12 15.5A3.5 3.5 0 1012 8.5a3.5 3.5 0 000 7z" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1.08-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1.08 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export function LogsIcon({ size = 22 }: IconProps): ReactNode {
  return (
    <svg {...s(size)}>
      <rect x="4" y="3" width="16" height="18" rx="2" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
