import 'server-only';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { supabaseConfigured } from '@/lib/authRole';

export function authReady(): boolean {
  return supabaseConfigured();
}

export async function supabaseServer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const jar = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (rows: { name: string; value: string; options: CookieOptions }[], _headers?: Record<string, string>) => {
        try {
          rows.forEach(({ name, value, options }) => jar.set(name, value, options));
        } catch {
          /* Server Components cannot set cookies; route handlers can. */
        }
      },
    },
  });
}

export async function supabaseUser() {
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data, error } = await sb.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}
