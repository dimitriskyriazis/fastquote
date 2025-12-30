import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "ag-grid-community/styles/ag-theme-quartz.css";
import SideNav from "./components/SideNav";
import { AuditUserProvider } from "./components/AuditUserProvider";
import AuditUserPrompt from "./components/AuditUserPrompt";
import DisableAutofill from "./components/DisableAutofill";
import PreventBackspaceNavigation from "./components/PreventBackspaceNavigation";
import CaretVisibilityManager from "./components/CaretVisibilityManager";

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

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <CaretVisibilityManager />
        <AuditUserProvider>
          <AuditUserPrompt />
          <DisableAutofill />
          <PreventBackspaceNavigation />
          <div className="app-shell">
            <SideNav />
            <div className="app-content">{children}</div>
          </div>
        </AuditUserProvider>
      </body>
    </html>
  );
}
