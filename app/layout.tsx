import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { buildMetadata } from '@/lib/link-preview';
import './globals.css';

/** نولّد وسوم المعاينة (og:image / og:video) بروابط مطلقة حسب دومين الطلب */
export async function generateMetadata(): Promise<Metadata> {
  const h = await headers();
  return buildMetadata(h);
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#070b10',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
