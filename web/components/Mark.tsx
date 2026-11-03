import Link from 'next/link';

export function Mark({ href, size = 'app' }: { href?: string; size?: 'app' | 'cover' }) {
  const inner = <>clerk<span className="mark-ai">.ai</span></>;
  const cls = size === 'cover' ? 'mark mark-cover' : 'mark';
  if (href) return <Link href={href} className={cls} aria-label="clerk.ai">{inner}</Link>;
  return <div className={cls} aria-label="clerk.ai">{inner}</div>;
}
