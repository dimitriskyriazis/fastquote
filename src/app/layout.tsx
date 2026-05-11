import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";
import "ag-grid-community/styles/ag-theme-quartz.css";
import SideNav from "./components/SideNav";
import { AuditUserProvider } from "./components/AuditUserProvider";
import DisableAutofill from "./components/DisableAutofill";
import PreventBackspaceNavigation from "./components/PreventBackspaceNavigation";
import CaretVisibilityManager from "./components/CaretVisibilityManager";
import StorageVersionManager from "./components/StorageVersionManager";
import SpellcheckManager from "./components/SpellcheckManager";
import CommandPalette from "./components/CommandPalette";
import ScrollToBottomButton from "./components/ScrollToBottomButton";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "FastQuote",
};

const SIDENAV_COLLAPSED_COOKIE_NAME = "fastquote_sidenav_collapsed";

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const initialCollapsed = cookieStore.get(SIDENAV_COLLAPSED_COOKIE_NAME)?.value === "true";

  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <CaretVisibilityManager />
        <StorageVersionManager />
        <AuditUserProvider>
          <DisableAutofill />
          <SpellcheckManager />
          <PreventBackspaceNavigation />
          <CommandPalette />
          <div className="app-shell">
            <SideNav initialCollapsed={initialCollapsed} />
            <div className="app-content">{children}</div>
          </div>
          <ScrollToBottomButton />
        </AuditUserProvider>
      </body>
    </html>
  );
}
