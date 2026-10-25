import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

// Gmail, read-only. Tokens live only in an httpOnly cookie on this server's responses; they're never logged,
// never put in NEXT_PUBLIC_*, and never sent to the browser's JavaScript.

const COOKIE = 'cs_gmail';
export const STATE_COOKIE = 'cs_gmail_state';
const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const SCOPES = READ_SCOPE; // read-only; the address comes from Gmail's own profile
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_RAW_CHARS = Math.ceil((40 * 1024 * 1024 * 4) / 3); // 40 MB once decoded, the core's limit

export interface GmailTokens {
  access_token: string;
  refresh_token?: string;
  expiry: number;
  email: string;
}

/** A problem the person can fix, in plain words. It never carries a token. `reconnect`: the sign-in is no good. */
export class GmailError extends Error {
  constructor(message: string, readonly code: string, readonly status = 502, readonly reconnect = false) {
    super(message);
  }
}

export function gmailRedirect(): string {
  return (process.env.GMAIL_REDIRECT_URI || 'http://localhost:3001/api/gmail/callback').trim();
}

/** What's wrong with the Gmail settings, without ever showing a value. */
export function gmailConfigProblem(): string | null {
  const id = (process.env.GMAIL_CLIENT_ID || '').trim();
  const secret = (process.env.GMAIL_CLIENT_SECRET || '').trim();
  if (!id || !secret) {
    return 'Add GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET to web/.env.local (not the root .env), then restart the web app.';
  }
  if (id.startsWith('AIza') || secret.startsWith('AIza')) {
    return 'GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET holds a Google API key (it starts with AIza). Gmail needs an OAuth client: ' +
      'Credentials → Create credentials → OAuth client ID → Web application.';
  }
  if (!id.endsWith('.apps.googleusercontent.com')) {
    return "GMAIL_CLIENT_ID doesn't look like an OAuth client ID: it should end in .apps.googleusercontent.com.";
  }
  if (!/^https?:\/\/[^/]+\/api\/gmail\/callback$/.test(gmailRedirect())) {
    return 'GMAIL_REDIRECT_URI must end in /api/gmail/callback, for example http://localhost:3001/api/gmail/callback.';
  }
  return null;
}

export function gmailConfigured(): boolean {
  return gmailConfigProblem() === null;
}

export function cookieOptions(maxAge: number) {
  return { httpOnly: true, sameSite: 'lax' as const, path: '/', maxAge, secure: gmailRedirect().startsWith('https://') };
}

export function authUrl(state: string): string {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', (process.env.GMAIL_CLIENT_ID || '').trim());
  u.searchParams.set('redirect_uri', gmailRedirect());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent'); // always returns a refresh token
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', state);
  return u.toString();
}

/** The state Google sent back is the one this browser was given, compared in constant time. */
export function sameState(expected: string | undefined, got: string | null): boolean {
  if (!expected || !got || expected.length !== got.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}

export async function readTokens(): Promise<GmailTokens | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as GmailTokens;
    return typeof t.access_token === 'string' && typeof t.expiry === 'number' ? t : null;
  } catch {
    return null;
  }
}

export async function writeTokens(t: GmailTokens): Promise<void> {
  (await cookies()).set(COOKIE, JSON.stringify(t), cookieOptions(60 * 60 * 24 * 14));
}

export async function clearTokens(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export const TOKEN_COOKIE = COOKIE;

function tokenError(code: string, description: string): GmailError {
  switch (code) {
    case 'invalid_grant':
      return new GmailError('Google says this Gmail sign-in expired or was revoked (in Testing mode Google ends it after 7 days). ' +
        'Connect Gmail again.', code, 401, true);
    case 'invalid_client':
    case 'unauthorized_client':
      return new GmailError('Google rejected the OAuth client. Check that GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in web/.env.local ' +
        'come from the same OAuth client, then restart the web app.', code, 400);
    case 'redirect_uri_mismatch':
      return new GmailError(`The OAuth client doesn't list this redirect URI. Add exactly ${gmailRedirect()} under ` +
        'Authorized redirect URIs.', code, 400);
    default:
      return new GmailError(`Google refused the sign-in (${code || 'unknown error'}${description ? `: ${description}` : ''}).`,
        code || 'token_failed');
  }
}

async function tokenRequest(body: Record<string, string>): Promise<Record<string, unknown>> {
  let r: Response;
  try {
    r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: (process.env.GMAIL_CLIENT_ID || '').trim(),
        client_secret: (process.env.GMAIL_CLIENT_SECRET || '').trim(),
        ...body,
      }),
      cache: 'no-store',
    });
  } catch {
    throw new GmailError("Couldn't reach Google to sign in. Check the internet connection.", 'network');
  }
  const j = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok) throw tokenError(String(j.error || ''), String(j.error_description || ''));
  return j;
}

export async function exchangeCode(code: string): Promise<GmailTokens> {
  const j = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: gmailRedirect() });
  if (!String(j.scope || '').split(' ').includes(READ_SCOPE)) {
    throw new GmailError("Google didn't grant read access to Gmail. Connect again and tick \"View your email messages and " +
      "settings\" on Google's screen.", 'scope_missing', 403);
  }
  const access = String(j.access_token);
  const me = await gmailGet(access, '/profile') as { emailAddress?: string };
  return {
    access_token: access,
    refresh_token: j.refresh_token ? String(j.refresh_token) : undefined,
    expiry: Date.now() + (Number(j.expires_in || 3600) - 60) * 1000,
    email: String(me.emailAddress || ''),
  };
}

/** The signed-in tokens, refreshed when the access token has expired. Null when nobody is connected.
 * A sign-in Google won't renew is cleared, and the error says to connect again. */
export async function liveTokens(): Promise<GmailTokens | null> {
  const t = await readTokens();
  if (!t) return null;
  if (t.expiry > Date.now()) return t;
  if (!t.refresh_token) {
    await clearTokens();
    throw new GmailError('Gmail access expired. Connect Gmail again.', 'expired', 401, true);
  }
  try {
    const j = await tokenRequest({ refresh_token: t.refresh_token, grant_type: 'refresh_token' });
    const next: GmailTokens = {
      ...t,
      access_token: String(j.access_token),
      refresh_token: j.refresh_token ? String(j.refresh_token) : t.refresh_token, // Google may rotate it
      expiry: Date.now() + (Number(j.expires_in || 3600) - 60) * 1000,
    };
    await writeTokens(next);
    return next;
  } catch (e) {
    if (e instanceof GmailError && e.reconnect) await clearTokens();
    throw e;
  }
}

interface GoogleApiError { message?: string; status?: string; errors?: { reason?: string }[] }

function gmailError(status: number, err: GoogleApiError | undefined): GmailError {
  const reason = err?.errors?.[0]?.reason || '';
  const message = String(err?.message || '');
  if (status === 401) return new GmailError('Gmail no longer accepts this sign-in. Connect Gmail again.', 'unauthorized', 401, true);
  if (status === 403 && (reason === 'accessNotConfigured' || /has not been used|is disabled|SERVICE_DISABLED/i.test(message))) {
    return new GmailError('The Gmail API is turned off in your Google Cloud project. Enable it (APIs & Services → Library → ' +
      'Gmail API → Enable), wait a minute, then reload this page.', 'api_disabled', 403);
  }
  if (status === 403 && (reason === 'insufficientPermissions' || /insufficient/i.test(message))) {
    return new GmailError("Google didn't grant read access to Gmail. Disconnect, connect again, and tick the Gmail box on " +
      "Google's screen.", 'scope_missing', 403, true);
  }
  if (status === 404) return new GmailError('That message is no longer in the mailbox.', 'not_found', 404);
  if (status === 429) return new GmailError('Gmail is limiting requests right now. Wait a minute and try again.', 'rate_limited', 429);
  return new GmailError(`Gmail returned an error (${status}${message ? `: ${message}` : ''}).`, 'gmail_error');
}

async function gmailGet(access: string, path: string): Promise<unknown> {
  let r: Response;
  try {
    r = await fetch(`${GMAIL}${path}`, { headers: { Authorization: `Bearer ${access}` }, cache: 'no-store' });
  } catch {
    throw new GmailError("Couldn't reach Gmail. Check the internet connection.", 'network');
  }
  if (r.ok) return r.json();
  const j = await r.json().catch(() => ({})) as { error?: GoogleApiError };
  throw gmailError(r.status, j.error);
}

export interface GmailLetter {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  at: string;
  pdf: boolean;
}

function header(headers: { name: string; value: string }[], name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

interface ListResponse { messages?: { id: string }[] }

export async function listInbox(access: string, limit = 12): Promise<GmailLetter[]> {
  const q = (s: string) => `/messages?maxResults=${limit}&q=${encodeURIComponent(s)}`;
  const [list, withPdf] = await Promise.all([
    gmailGet(access, q('in:inbox')) as Promise<ListResponse>,
    gmailGet(access, q('in:inbox has:attachment filename:pdf')) as Promise<ListResponse>,
  ]);
  const pdf = new Set((withPdf.messages || []).map(m => m.id));
  const letters: GmailLetter[] = [];
  for (const { id } of list.messages || []) {
    const m = await gmailGet(access,
      `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
    ) as { snippet?: string; payload?: { headers?: { name: string; value: string }[] } };
    const headers = m.payload?.headers || [];
    letters.push({
      id,
      from: header(headers, 'From'),
      subject: header(headers, 'Subject') || '(no subject)',
      snippet: String(m.snippet || '').replace(/\s+/g, ' ').trim(),
      at: header(headers, 'Date') || '',
      pdf: pdf.has(id),
    });
  }
  return letters;
}

/** One whole message as Gmail stores it (base64url), and when Gmail received it. */
export async function fetchRaw(access: string, id: string): Promise<{ raw: string; receivedAtIso: string }> {
  if (!MESSAGE_ID.test(id)) throw new GmailError('Unknown message.', 'bad_id', 400);
  const m = await gmailGet(access, `/messages/${id}?format=raw`) as { raw?: string; internalDate?: string };
  const raw = String(m.raw || '');
  if (!raw) throw new GmailError('Gmail returned an empty message.', 'empty', 502);
  if (raw.length > MAX_RAW_CHARS) throw new GmailError('That message is larger than 40 MB, so it isn\'t imported.', 'too_large', 413);
  const at = Number(m.internalDate);
  return { raw, receivedAtIso: Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : '' };
}
