import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import type { AuthContext } from "@/domain/auth/auth-context";

import type { SessionIdentity } from "./provider";
import { contextFromIdentity, getSessionIdentity } from "./resolve";

/** For server components: the session identity (may lack an organization). */
export async function getPageIdentity(): Promise<SessionIdentity | null> {
  return getSessionIdentity(await headers());
}

/** For protected pages: redirects to /login or /onboarding as needed. */
export async function requirePageAuth(): Promise<AuthContext> {
  const identity = await getPageIdentity();
  if (!identity) redirect("/login");
  const auth = await contextFromIdentity(identity);
  if (!auth) redirect(identity.organizationId ? "/login" : "/onboarding");
  return auth;
}
