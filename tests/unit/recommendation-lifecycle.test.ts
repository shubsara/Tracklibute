import { describe, expect, it } from "vitest";

import { decideTransition } from "@/domain/recommendations/lifecycle";

const NOW = new Date("2026-10-16T12:00:00Z");
const later = new Date(NOW.getTime() + 86_400_000);
const earlier = new Date(NOW.getTime() - 86_400_000);
const det = (fingerprint: string) => ({ fingerprint });
const rec = (status: "OPEN" | "ACCEPTED" | "DISMISSED" | "SNOOZED" | "RESOLVED", fingerprint = "NEEDS_ATTENTION|INACTIVE", snoozedUntil: Date | null = null) => ({
  status,
  fingerprint,
  snoozedUntil,
});

describe("recommendation lifecycle", () => {
  it("creates once, then refreshes in place (dedup)", () => {
    expect(decideTransition(null, det("NEEDS_ATTENTION|INACTIVE"), NOW)).toEqual({ kind: "create" });
    expect(decideTransition(rec("OPEN"), det("AT_RISK|INACTIVE"), NOW)).toEqual({ kind: "refresh", keepFingerprint: false });
    expect(decideTransition(null, null, NOW)).toEqual({ kind: "noop" });
  });

  it("resolves anything unresolved when the problem is gone", () => {
    for (const s of ["OPEN", "ACCEPTED", "DISMISSED", "SNOOZED"] as const) {
      expect(decideTransition(rec(s), null, NOW)).toEqual({ kind: "resolve" });
    }
    expect(decideTransition(rec("RESOLVED"), null, NOW)).toEqual({ kind: "noop" });
  });

  it("snooze holds until it expires, then reopens", () => {
    expect(decideTransition(rec("SNOOZED", undefined, later), det("NEEDS_ATTENTION|INACTIVE"), NOW)).toEqual({ kind: "refresh", keepFingerprint: false });
    expect(decideTransition(rec("SNOOZED", undefined, earlier), det("NEEDS_ATTENTION|INACTIVE"), NOW)).toEqual({ kind: "reopen" });
  });

  it("dismissed / accepted stay put unless the problem escalates", () => {
    for (const s of ["DISMISSED", "ACCEPTED"] as const) {
      expect(decideTransition(rec(s), det("NEEDS_ATTENTION|INACTIVE"), NOW)).toEqual({ kind: "refresh", keepFingerprint: true });
      expect(decideTransition(rec(s), det("AT_RISK|INACTIVE"), NOW)).toEqual({ kind: "reopen" });
      expect(decideTransition(rec(s), det("NEEDS_ATTENTION|INACTIVE,NO_NEXT_ACTIVITY"), NOW)).toEqual({ kind: "reopen" });
    }
  });

  it("a resolved recommendation reopens as a new episode when the problem returns", () => {
    expect(decideTransition(rec("RESOLVED"), det("NEEDS_ATTENTION|INACTIVE"), NOW)).toEqual({ kind: "reopen" });
  });
});
