import type { Metadata } from 'next';
import { JetBrains_Mono, Source_Serif_4, Space_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';

import '@/styles/index.css';

// Root layout (S1.4): self-hosted design fonts, the no-flash theme script, global CSS.
// Reads no config and no DB, so `next build` stays env-free.

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
  title: 'log0',
  description: "smallTech's blog on all things AI",
};

/* The design's pre-paint theme script, extended with persistence (divergence 16):
   a stored 'light'|'dark' choice wins, otherwise the OS preference. It also marks the
   first load so the site chrome holds back until PrintIn prints it in (additions.css);
   a timeout lifts that hold if hydration never arrives. Reduced motion skips the hold. */
const THEME_SCRIPT = `(function(){try{var d=document.documentElement,t=null;try{t=window.localStorage.getItem('blog0.theme')}catch(e){}
if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}
d.setAttribute('data-theme',t);
if(!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)){d.setAttribute('data-printing','');window.setTimeout(function(){d.removeAttribute('data-printing')},2500)}
}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${head.variable} ${body.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
