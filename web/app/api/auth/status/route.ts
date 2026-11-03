import { NextResponse } from 'next/server';
import { supabaseConfigured, supabaseIssuer, supabaseJwks } from '@/lib/authRole';

export const dynamic = 'force-dynamic';

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  return NextResponse.json({
    configured: supabaseConfigured(),
    issuer: url ? supabaseIssuer(url) : null,
    jwks: url ? supabaseJwks(url) : null,
    note: url
      ? 'Turn on asymmetric JWT signing keys in the Supabase project so SpacetimeDB can check the JWKS. Legacy HS256 tokens cannot be verified by Spacetime.'
      : 'Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY. Until then the four desks still work.',
  });
}
