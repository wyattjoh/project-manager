import fs from "node:fs/promises";
import path from "node:path";
import type { Stats as FsStats } from "node:fs";

type Stats = {
  totalSize: number;
  lastAccessTime: number;
  lastModifiedTime: number;
};

const DEFAULT_EXCLUDE_PATTERNS = [".git"];

function isSkippableFsError(error: unknown) {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }

  return ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(String(error.code));
}

async function lstat(pathname: string): Promise<FsStats | null> {
  try {
    return await fs.lstat(pathname);
  } catch (error) {
    if (isSkippableFsError(error)) {
      return null;
    }

    throw error;
  }
}

async function readdir(pathname: string): Promise<string[]> {
  try {
    return await fs.readdir(pathname);
  } catch (error) {
    if (isSkippableFsError(error)) {
      return [];
    }

    throw error;
  }
}

function normalizePattern(pattern: string) {
  return pattern
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
}

function createExcludeMatcher(root: string, exclude: string[]) {
  const patterns = [...DEFAULT_EXCLUDE_PATTERNS, ...exclude].map(normalizePattern).filter(Boolean);

  return (pathname: string) => {
    const basename = path.basename(pathname);
    const relativePath = path.relative(root, pathname).split(path.sep).join("/");

    return patterns.some((pattern) => {
      if (!pattern.includes("/")) {
        return basename === pattern;
      }

      return (
        relativePath === pattern || relativePath.startsWith(`${pattern}/`) || relativePath.includes(`/${pattern}/`)
      );
    });
  };
}

export async function getStats(dir: string, exclude: string[]): Promise<Stats> {
  const stack = [dir];

  let stats = await lstat(dir);
  if (!stats) {
    return {
      totalSize: 0,
      lastAccessTime: 0,
      lastModifiedTime: 0,
    };
  }

  if (stats.isFile() || stats.isSymbolicLink()) {
    return {
      totalSize: stats.size,
      lastAccessTime: stats.atimeMs,
      lastModifiedTime: stats.mtimeMs,
    };
  }

  const shouldExclude = createExcludeMatcher(dir, exclude);
  let lastModifiedTime = 0;
  let lastAccessTime = 0;
  let totalSize = 0;

  while (stack.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: we checked the stack is not empty
    const currentDir = stack.pop()!;
    const files = await readdir(currentDir);

    for (const file of files) {
      const filePath = path.join(currentDir, file);

      if (shouldExclude(filePath)) {
        continue;
      }

      stats = await lstat(filePath);
      if (!stats) {
        continue;
      }

      if (stats.isDirectory()) {
        stack.push(filePath);
      } else if (stats.isFile() || stats.isSymbolicLink()) {
        if (stats.mtimeMs > lastModifiedTime) {
          lastModifiedTime = stats.mtimeMs;
        }

        if (stats.atimeMs > lastAccessTime) {
          lastAccessTime = stats.atimeMs;
        }

        totalSize += stats.size;
      }
    }
  }

  return {
    totalSize,
    lastAccessTime,
    lastModifiedTime,
  };
}
