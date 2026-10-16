/** Shown when the deal owner has no connected Gmail: email signals are incomplete. */
export function LimitedSignalNote({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <span className="text-xs text-neutral-500" title="The deal owner has not connected Gmail, so their emails are not counted.">
        · limited signal
      </span>
    );
  }
  return (
    <p className="rounded border border-dashed p-2 text-xs text-neutral-600">
      Limited signal: the deal owner has not connected Gmail (or is not mapped to a teammate), so their emails are not
      counted. &ldquo;Gone quiet&rdquo; may be a false alarm until they connect.
    </p>
  );
}
