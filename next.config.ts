import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg and the Prisma adapter must stay server-side Node modules.
  serverExternalPackages: ["pg", "@prisma/adapter-pg"],
  poweredByHeader: false,
};

export default nextConfig;
