import type { Metadata } from 'next';
import './globals.css';
import { Shell } from '@/components/Shell';
import { siteUrl } from '@/lib/siteUrl';

const url = siteUrl();

export const metadata: Metadata = {
  metadataBase: new URL(url),
  title: { default: 'clerk.ai', template: '%s · clerk.ai' },
  description: 'Clerk reads each supplier invoice against the quote, the purchase order, and the mail. A person still has to approve. Clerk cannot pay.',
  applicationName: 'clerk.ai',
  openGraph: {
    type: 'website',
    siteName: 'clerk.ai',
    title: 'clerk.ai',
    description: 'Checks every supplier invoice against what was agreed before any money moves.',
    url,
  },
  twitter: {
    card: 'summary',
    title: 'clerk.ai',
    description: 'Checks every supplier invoice against what was agreed before any money moves.',
  },
  robots: { index: true, follow: true },
};

const ORG = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Marlow & Finch Builders',
  email: 'ap@marlowfinch.example',
  address: {
    '@type': 'PostalAddress',
    streetAddress: '1418 Oakview Ln',
    addressLocality: 'Fremont',
    addressRegion: 'CA',
    addressCountry: 'US',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ORG) }} />
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
