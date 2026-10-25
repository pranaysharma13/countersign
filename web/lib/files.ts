// File preview lives on the Python core (port 8000). Fragments are always shown as quoted
// text; this only builds a link when NEXT_PUBLIC_CORE_URL is set and a source_file exists.
export function fileHref(sourceFileId?: string | null, page?: number): string | null {
  const base = (process.env.NEXT_PUBLIC_CORE_URL ?? '').replace(/\/$/, '');
  if (!base || !sourceFileId) return null;
  const url = `${base}/files/${encodeURIComponent(sourceFileId)}`;
  return page && page > 0 ? `${url}#page=${page}` : url;
}
