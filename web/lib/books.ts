export interface BooksHealth {
  source: 'live' | 'local';
  shared: boolean;
  core: boolean;
  hosted: boolean;
}

export function booksLine(h: BooksHealth): string {
  if (h.source === 'local') {
    return h.hosted
      ? 'These books live on this server process. They reset when it sleeps. Shared writes need the live database.'
      : 'These books live on this machine. They will not follow you to a public domain.';
  }
  if (!h.core) return 'Shared books. PDF preview, Why, and mail import stay off until the file service is set on this host.';
  return 'Shared books. Writes persist. PDF preview is on.';
}
