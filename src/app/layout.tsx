import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Tracklibute",
  description: "AI Sales Operations for small B2B teams.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        <main className="mx-auto max-w-2xl px-4 py-10">{children}</main>
      </body>
    </html>
  );
}
