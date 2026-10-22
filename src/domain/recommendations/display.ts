/**
 * How a deal's recommendations are presented. A RESOLVED recommendation is
 * history, never an active issue: it is separated from the active ones so a
 * page can show it (subdued, labelled "Resolved") or omit it.
 * Pure — no lifecycle rules live here (see lifecycle.ts).
 */
export interface DisplayRecommendation {
  id: string;
  status: string;
  title: string;
  summary: string;
  severity: string;
  createdAt: Date;
  resolvedAt: Date | null;
}

export function partitionDealRecommendations<T extends DisplayRecommendation>(recs: readonly T[]): { active: T | null; resolved: T[] } {
  const byNewest = [...recs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const resolved = byNewest
    .filter((r) => r.status === "RESOLVED")
    .sort((a, b) => (b.resolvedAt ?? b.createdAt).getTime() - (a.resolvedAt ?? a.createdAt).getTime());
  return { active: byNewest.find((r) => r.status !== "RESOLVED") ?? null, resolved };
}
