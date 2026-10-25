import type { Row, Tables } from './client';

// Where a document came from is recorded on its reading job (`job_doc_<document id>`), e.g.
// {"document_id": "...", "source": "gmail", "gmail_message_id": "..."} for a Gmail import.

interface Origin { document_id?: string; source?: string; gmail_message_id?: string }

function origin(job: Row | undefined): Origin {
  if (!job) return {};
  try {
    const p = JSON.parse(String(job.payload_json || '{}'));
    return p && typeof p === 'object' ? p as Origin : {};
  } catch {
    return {};
  }
}

/** True when the document was imported from Gmail (shown as "From Gmail"). */
export function fromGmail(t: Tables, documentId: string | undefined): boolean {
  return !!documentId && origin((t.job || []).find(j => j.id === `job_doc_${documentId}`)).source === 'gmail';
}

/** The documents one Gmail message became, each with its reading job, body first. */
export function gmailImports(t: Tables, messageId: string): { job: Row; doc?: Row }[] {
  return (t.job || [])
    .filter(j => j.kind === 'process_document')
    .map(job => ({ job, o: origin(job) }))
    .filter(({ o }) => o.source === 'gmail' && o.gmail_message_id === messageId)
    .map(({ job, o }) => ({ job, doc: (t.document || []).find(d => d.id === o.document_id) }))
    .sort((a, b) => (a.doc?.kind === 'email' ? -1 : b.doc?.kind === 'email' ? 1 : 0));
}

/** A document's reading status in plain words. */
export function readingStatus(job: Row, doc?: Row): { text: string; tone: 'ok' | 'hold' | 'stop' | 'idle' } {
  if (doc?.status === 'needs_review') return { text: 'Needs a person', tone: 'hold' };
  if (job.status === 'failed' || doc?.status === 'failed') return { text: 'Failed', tone: 'stop' };
  if (job.status === 'done') return { text: 'Read and checked', tone: 'ok' };
  return { text: 'Reading…', tone: 'idle' };
}
