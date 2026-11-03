import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/siteUrl';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  return [
    { url: base, changeFrequency: 'weekly', priority: 1 },
    { url: `${base}/login`, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${base}/proof`, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${base}/bills`, changeFrequency: 'daily', priority: 0.8 },
    { url: `${base}/office`, changeFrequency: 'daily', priority: 0.7 },
  ];
}
