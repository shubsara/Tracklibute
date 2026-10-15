import { describe, expect, it } from "vitest";

import { issueSessionToken, verifySessionToken } from "@/server/auth/session-token";

const secret = "s".repeat(48);
const ids = { userId: "11111111-1111-4111-8111-111111111111", organizationId: "22222222-2222-4222-8222-222222222222" };

describe("session token", () => {
  it("verifies a token it issued", () => {
    const claims = verifySessionToken(issueSessionToken(ids, secret), secret);
    expect(claims).toMatchObject({ sub: ids.userId, org: ids.organizationId });
  });

  it("rejects a token signed with another secret", () => {
    expect(verifySessionToken(issueSessionToken(ids, "x".repeat(48)), secret)).toBeNull();
  });

  it("rejects a token whose payload was edited (e.g. swapping organization)", () => {
    const [, sig] = issueSessionToken(ids, secret).split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: ids.userId, org: "33333333-3333-4333-8333-333333333333", iat: 1, exp: 9e9 }),
    ).toString("base64url");
    expect(verifySessionToken(`${forged}.${sig}`, secret)).toBeNull();
  });

  it("rejects expired and malformed tokens", () => {
    const now = 1_000_000;
    expect(verifySessionToken(issueSessionToken(ids, secret, 60, now), secret, now + 61)).toBeNull();
    expect(verifySessionToken("not-a-token", secret)).toBeNull();
    expect(verifySessionToken("a.b.c", secret)).toBeNull();
  });
});
