import type { Metadata } from 'next';
import './globals.css';
import PWAInstallBridge from '../components/PWAInstallBridge';

export const metadata: Metadata = {
  title: 'HSWare Studio',
  description: 'Private software operations workspace',
  robots: { index: false, follow: false, nocache: true },
  icons: { icon: '/favicon-32.png', apple: '/icon-192.png' },
  manifest: '/manifest.webmanifest',
  applicationName: 'HSWare Studio'
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><PWAInstallBridge />{children}</body></html>;
}
