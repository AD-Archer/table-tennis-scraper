export type DataStoreMode = "postgres";

export function getDataStoreMode(): DataStoreMode {
  return "postgres";
}

export function isPostgresConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0);
}

export function shouldUsePostgres(mode = getDataStoreMode()): boolean {
  return mode === "postgres";
}

export function shouldUseFilesystem(mode = getDataStoreMode()): boolean {
  return mode !== "postgres";
}
