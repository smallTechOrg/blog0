import type { Metadata } from 'next';
import { JetBrains_Mono, Source_Serif_4, Space_Grotesk } from 'next/font/google';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';

import { THEME_SCRIPT } from '@/components/site/head-script';

import '@/styles/index.css';

// Root layout: self-hosted design fonts, the no-flash theme + intro script (head-script.ts), icons,
// global CSS.
// Reads no config and no DB, so `next build` stays env-free. In production the proxy puts a
// per-request CSP nonce on the request (`x-nonce`); the theme script carries it so it still runs
// before first paint under the strict script policy (spec/architecture.md §6).

const head = Space_Grotesk({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--nf-head', display: 'swap' });
const body = Source_Serif_4({
  subsets: ['latin'],
  weight: ['400', '600'],
  style: ['normal', 'italic'],
  variable: '--nf-body',
  display: 'swap',
});
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--nf-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'blog0',
  description: "smallTech's blog on all things AI",
  // Stage A (spec/ui.md §3 "head and share metadata"): designer-replaceable files in public/.
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32.png', type: 'image/png', sizes: '32x32' },
      { url: '/favicon.ico', sizes: '16x16 32x32' },
    ],
  },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" className={`${head.variable} ${body.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
