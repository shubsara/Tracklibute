import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DealRecommendations } from "@/app/opportunities/[dealId]/deal-recommendations";
import { partitionDealRecommendations } from "@/domain/recommendations/display";

const rec = (id: string, status: string, title: string, createdAt: string, resolvedAt: string | null = null) => ({
  id,
  status,
  title,
  summary: `${title} summary`,
  severity: "MEDIUM",
  createdAt: new Date(createdAt),
  resolvedAt: resolvedAt ? new Date(resolvedAt) : null,
});

describe("partitionDealRecommendations", () => {
  it("never returns a RESOLVED recommendation as the active one", () => {
    const r = partitionDealRecommendations([rec("a", "RESOLVED", "Deal has no next step scheduled", "2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z")]);
    expect(r.active).toBeNull();
    expect(r.resolved.map((x) => x.id)).toEqual(["a"]);
  });

  it("picks the newest unresolved recommendation and lists resolved ones newest first", () => {
    const r = partitionDealRecommendations([
      rec("old-res", "RESOLVED", "x", "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"),
      rec("open", "OPEN", "y", "2026-10-05T00:00:00Z"),
      rec("new-res", "RESOLVED", "z", "2026-10-03T00:00:00Z", "2026-10-10T00:00:00Z"),
    ]);
    expect(r.active?.id).toBe("open");
    expect(r.resolved.map((x) => x.id)).toEqual(["new-res", "old-res"]);
  });

  it("snoozed / accepted / dismissed recommendations are still unresolved", () => {
    for (const status of ["SNOOZED", "ACCEPTED", "DISMISSED"]) {
      expect(partitionDealRecommendations([rec("s", status, "t", "2026-10-01T00:00:00Z")]).active?.id).toBe("s");
    }
  });
});

const dto = (status: string, title: string) => ({ id: `${status}-id`, status, title, summary: `${title} summary`, severity: "MEDIUM", resolvedAt: status === "RESOLVED" ? "2026-10-21T00:00:00.000Z" : null });

describe("<DealRecommendations>", () => {
  it("a resolved recommendation is rendered only in the subdued Resolved section", () => {
    const html = renderToStaticMarkup(<DealRecommendations active={null} resolved={[dto("RESOLVED", "Tracklibute Test Deal 01 has no next step scheduled")]} />);
    expect(html).not.toContain('data-testid="active-recommendation"');
    expect(html).not.toContain("Recommendation status");
    expect(html).toContain('data-testid="resolved-recommendations"');
    expect(html).toContain("Resolved (1)");
    expect(html).toMatch(/line-through[^>]*>Tracklibute Test Deal 01 has no next step scheduled/);
  });

  it("an open recommendation is rendered as the active issue, with the way to act on it", () => {
    const html = renderToStaticMarkup(<DealRecommendations active={dto("OPEN", "Deal has no contacts to track")} resolved={[]} />);
    expect(html).toContain('data-testid="active-recommendation"');
    expect(html).toContain("Deal has no contacts to track");
    expect(html).toContain("Recommendation status: open");
    expect(html).toContain('href="/recommendations?status=OPEN"');
    expect(html).not.toContain("resolved-recommendations");
  });

  it("renders nothing when there are no recommendations", () => {
    expect(renderToStaticMarkup(<DealRecommendations active={null} resolved={[]} />)).toBe("");
  });
});
