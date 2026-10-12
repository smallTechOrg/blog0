import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '@/styles/index.css';

// Minimal root layout (scaffold). S1.4 takes over: fonts, theme init script, design CSS.

export const metadata: Metadata = {
  title: 'log0',
  description: "smallTech's blog on all things AI",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
