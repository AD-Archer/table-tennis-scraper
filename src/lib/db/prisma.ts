import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const globalScope = globalThis as typeof globalThis & {
  __ttblPrismaClient?: PrismaClient;
};

function withPgSslCompatFlag(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    const sslmode = parsed.searchParams.get("sslmode")?.toLowerCase() ?? "";
    const needsCompat =
      sslmode === "prefer" || sslmode === "require" || sslmode === "verify-ca";
    if (needsCompat && !parsed.searchParams.has("uselibpqcompat")) {
      parsed.searchParams.set("uselibpqcompat", "true");
      return parsed.toString();
    }
  } catch {
    // Keep original connection string when URL parsing fails.
  }

  return connectionString;
}

export function getPrismaClient(): PrismaClient | null {
  const rawConnectionString = process.env.DATABASE_URL?.trim() ?? "";
  if (!rawConnectionString) {
    return null;
  }
  const connectionString = withPgSslCompatFlag(rawConnectionString);

  if (!globalScope.__ttblPrismaClient) {
    const adapter = new PrismaPg({ connectionString });
    globalScope.__ttblPrismaClient = new PrismaClient({
      adapter,
      transactionOptions: {
        maxWait: 10_000,
        timeout: 120_000,
      },
    });
  }

  return globalScope.__ttblPrismaClient;
}
