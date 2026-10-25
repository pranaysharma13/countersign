import 'server-only';
import { cookies } from 'next/headers';

const COOKIE = 'cs_gmail';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

export interface GmailTokens {
  access_token: string;
  refresh_token?: string;
  expiry: number;
  email: string;
}

export function gmailConfigured(): boolean {
  return !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);
}

export function gmailRedirect(): string {
  return process.env.GMAIL_REDIRECT_URI || 'http://localhost:3001/api/gmail/callback';
}

export function authUrl(state: string): string {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', process.env.GMAIL_CLIENT_ID || '');
  u.searchParams.set('redirect_uri', gmailRedirect());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('state', state);
  return u.toString();
}

export async function readTokens(): Promise<GmailTokens | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  try { return JSON.parse(raw) as GmailTokens; } catch { return null; }
}

export async function writeTokens(t: GmailTokens): Promise<void> {
  (await cookies()).set(COOKIE, JSON.stringify(t), {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 14,
  });
}

export async function clearTokens(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

async function tokenRequest(body: Record<string, string>): Promise<Record<string, string>> {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID || '',
      client_secret: process.env.GMAIL_CLIENT_SECRET || '',
      ...body,
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || 'Google token failed');
  return j;
}

export async function exchangeCode(code: string): Promise<GmailTokens> {
  const j = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: gmailRedirect() });
  const email = await emailOf(j.access_token);
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expiry: Date.now() + (Number(j.expires_in || 3600) - 60) * 1000,
    email,
  };
}

export async function liveTokens(): Promise<GmailTokens | null> {
  const t = await readTokens();
  if (!t) return null;
  if (t.expiry > Date.now()) return t;
  if (!t.refresh_token) return null;
  const j = await tokenRequest({ refresh_token: t.refresh_token, grant_type: 'refresh_token' });
  const next: GmailTokens = {
    ...t,
    access_token: j.access_token,
    expiry: Date.now() + (Number(j.expires_in || 3600) - 60) * 1000,
  };
  await writeTokens(next);
  return next;
}

async function emailOf(access: string): Promise<string> {
  const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${access}` },
  });
  const j = await r.json();
  return String(j.email || '');
}

export interface GmailLetter {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  at: string;
}

function header(headers: { name: string; value: string }[], name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

export async function listInbox(access: string, limit = 12): Promise<GmailLetter[]> {
  const list = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}&q=${encodeURIComponent('in:inbox')}`,
    { headers: { Authorization: `Bearer ${access}` } },
  ).then(r => r.json());
  const ids: string[] = (list.messages || []).map((m: { id: string }) => m.id);
  const letters: GmailLetter[] = [];
  for (const id of ids) {
    const m = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${access}` } },
    ).then(r => r.json());
    const headers = m.payload?.headers || [];
    letters.push({
      id,
      from: header(headers, 'From'),
      subject: header(headers, 'Subject') || '(no subject)',
      snippet: String(m.snippet || '').replace(/\s+/g, ' ').trim(),
      at: header(headers, 'Date') || '',
    });
  }
  return letters;
}
