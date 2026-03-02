import path from "node:path";
import { promises as fs } from "node:fs";
import { getDataStoreMode, shouldUseFilesystem } from "@/lib/db/config";
import { DATA_ROOT } from "@/lib/paths";

const RESOLVED_DATA_ROOT = path.resolve(DATA_ROOT);

function isInsideDataRoot(targetPath: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  return (
    resolvedTarget === RESOLVED_DATA_ROOT ||
    resolvedTarget.startsWith(`${RESOLVED_DATA_ROOT}${path.sep}`)
  );
}

export function assertDataPath(targetPath: string): void {
  if (!isInsideDataRoot(targetPath)) {
    const resolvedTarget = path.resolve(targetPath);
    throw new Error(
      `Refusing filesystem access outside DATA_ROOT (${RESOLVED_DATA_ROOT}): ${resolvedTarget}`,
    );
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  assertDataPath(dirPath);
  if (!shouldUseFilesystem(getDataStoreMode())) {
    return;
  }

  await fs.mkdir(dirPath, { recursive: true });
}

export async function removeDir(dirPath: string): Promise<void> {
  assertDataPath(dirPath);
  await fs.rm(dirPath, { recursive: true, force: true });
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  assertDataPath(filePath);
  if (!shouldUseFilesystem(getDataStoreMode())) {
    await fs.rm(filePath, { force: true });
    return;
  }

  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

export async function writeText(filePath: string, value: string): Promise<void> {
  assertDataPath(filePath);
  if (!shouldUseFilesystem(getDataStoreMode())) {
    await fs.rm(filePath, { force: true });
    return;
  }

  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, value, "utf8");
}

export async function readJson<T>(
  filePath: string,
  fallback: T | null = null,
): Promise<T | null> {
  assertDataPath(filePath);
  if (!shouldUseFilesystem(getDataStoreMode())) {
    return fallback;
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  assertDataPath(filePath);
  if (!shouldUseFilesystem(getDataStoreMode())) {
    return false;
  }

  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readText(
  filePath: string,
  fallback: string | null = null,
): Promise<string | null> {
  assertDataPath(filePath);
  if (!shouldUseFilesystem(getDataStoreMode())) {
    return fallback;
  }

  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
