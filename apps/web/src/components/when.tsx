import { ago } from '../lib/paper';

/**
 * A timestamp shown as a relative age with the exact UTC instant available on hover and to
 * assistive technology (§20.24 "UTC/source timestamps available on hover while displaying
 * operator-local time by default"). Renders "never" for a missing instant rather than a fake age.
 */
export function When({ iso, now, label }: { iso: string | null | undefined; now: number; label?: string }) {
  if (!iso) return <span className="muted">never</span>;
  const utc = new Date(iso).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  return (
    <time dateTime={iso} title={`${label ? `${label} ` : ''}${utc}`}>
      {ago(iso, now)}
    </time>
  );
}
