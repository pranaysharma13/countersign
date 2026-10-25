// File preview: same-origin /api/files proxies the Python file API on port 8000.
// Prefer the document id — seed PDFs resolve that way. source_file_id is the fallback.

export function fileHref(
  ref?: string | { id?: string | null; source_file_id?: string | null } | null,
  page?: number,
): string | null {
  const id = typeof ref === 'string' ? ref : (ref?.id || ref?.source_file_id || '');
  if (!id) return null;
  const url = `/api/files/${encodeURIComponent(id)}`;
  return page && Number(page) > 0 ? `${url}#page=${page}` : url;
}
