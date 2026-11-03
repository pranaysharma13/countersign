import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/siteUrl';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/sneak', '/api/'] },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
