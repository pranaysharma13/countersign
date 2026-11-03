import { NextResponse } from 'next/server';
import { mode } from '@/lib/server/backend';
import { coreBase } from '@/lib/server/core';
import type { BooksHealth } from '@/lib/books';

export const dynamic = 'force-dynamic';

export async function GET() {
  const source = mode();
  const body: BooksHealth = {
    source,
    shared: source === 'live',
    core: !!coreBase(),
    hosted: process.env.VERCEL === '1' || process.env.NODE_ENV === 'production',
  };
  return NextResponse.json(body);
}
