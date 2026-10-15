import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { getPageIdentity } from "@/server/auth/page-session";

import "./globals.css";

export const metadata: Metadata = {
  title: "Tracklibute",
  description: "AI Sales Operations for small B2B teams.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const identity = await getPageIdentity();
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        <header className="border-b border-neutral-200 dark:border-neutral-800">
          <nav className="mx-auto flex max-w-3xl items-center gap-4 px-4 py-3 text-sm">
            <Link href="/" className="font-semibold">
              Tracklibute
            </Link>
            {identity?.organizationId && (
              <>
                <Link href="/email">Email</Link>
                <Link href="/settings/integrations">Integrations</Link>
              </>
            )}
            <span className="flex-1" />
            {identity && (
              <form method="post" action="/api/auth/logout">
                <button type="submit" className="underline">
                  Sign out
                </button>
              </form>
            )}
          </nav>
        </header>
        <main className="mx-auto max-w-3xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
