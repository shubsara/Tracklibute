import Link from "next/link";

import { requirePageAuth } from "@/server/auth/page-session";
import { getMe } from "@/server/me/me.service";
import { listResponsibilities } from "@/server/responsibilities/responsibilities.service";

export const dynamic = "force-dynamic";

/** Minimal shell: proves auth boundary + organization context. Not the product cockpit. */
export default async function HomePage() {
  const auth = await requirePageAuth();
  const [me, responsibilities] = await Promise.all([getMe(auth), listResponsibilities(auth)]);
  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">{me.organization.name}</h1>
      <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
        <dt className="text-neutral-500">User</dt>
        <dd>{me.user.email}</dd>
        <dt className="text-neutral-500">Role</dt>
        <dd>{me.role}</dd>
      </dl>
      <p className="text-sm">
        <Link className="underline" href="/settings/integrations">
          Connect Gmail
        </Link>{" "}
        ·{" "}
        <Link className="underline" href="/email">
          View email context
        </Link>
      </p>
      <div>
        <h2 className="mb-2 font-medium">Responsibilities</h2>
        <ul className="list-disc pl-5 text-sm">
          {responsibilities.map((r) => (
            <li key={r.id}>
              {r.name} <span className="text-neutral-500">({r.type.toLowerCase()}, {r.status.toLowerCase()})</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
