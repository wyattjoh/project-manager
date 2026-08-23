import { Cache } from "@raycast/api";
import * as child_process from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { createLogger } from "./log";

const CACHE_KEY = "project-disk-sizes:v3";
const cache = new Cache({ namespace: "project-manager" });
const execFile = promisify(child_process.execFile);

/**
 * `du` walks the roots it is given strictly serially, so measuring many
 * projects is far faster as one process per project than as a single process
 * given every path at once.
 */
const CONCURRENCY = 8;
const log = createLogger("project-manager:disk");

/** Project sizes in bytes, keyed by pathname. */
export type DiskSizeMap = Record<string, number>;

export type DiskSizeProject = {
  pathname: string;
  lastCommitTime: number | null;
};

type DiskSizeCacheEntry = {
  size: number;
  lastCommitTime: number | null;
};

type DiskSizeCache = Record<string, DiskSizeCacheEntry>;

type DiskSizeSource = {
  projects: DiskSizeProject[];
};

type StreamOptions = {
  onSize: (pathname: string, size: number) => void;
  onComplete?: (sizes: DiskSizeMap) => void;
};

function parseCache() {
  const cached = cache.get(CACHE_KEY);
  if (!cached) {
    return {} satisfies DiskSizeCache;
  }

  try {
    return JSON.parse(cached) as DiskSizeCache;
  } catch {
    return {} satisfies DiskSizeCache;
  }
}

function writeCache(cacheEntries: DiskSizeCache) {
  cache.set(CACHE_KEY, JSON.stringify(cacheEntries));
}

function getSizeMap(cacheEntries: DiskSizeCache) {
  return Object.fromEntries(Object.entries(cacheEntries).map(([pathname, entry]) => [pathname, entry.size]));
}

function shouldRefreshDiskSize(project: DiskSizeProject, cacheEntry: DiskSizeCacheEntry | undefined) {
  if (!cacheEntry) {
    return true;
  }

  if (project.lastCommitTime === null) {
    return true;
  }

  return cacheEntry.lastCommitTime !== project.lastCommitTime;
}

/** Parses a `du -sk` line, whose size column counts 1024-byte blocks. */
function parseDuLine(line: string) {
  const match = line.trim().match(/^(\d+)\s+(.+)$/);
  if (!match) {
    return null;
  }

  return {
    pathname: path.resolve(match[2].replace(/\/$/, "")),
    size: Number.parseInt(match[1], 10) * 1024,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));

  return results;
}

function getErrorStdout(err: unknown) {
  if (typeof err !== "object" || err === null) {
    return null;
  }

  const { stdout } = err as { stdout?: unknown };
  return typeof stdout === "string" ? stdout : null;
}

async function getDiskSize(pathname: string, signal?: AbortSignal) {
  try {
    const { stdout } = await execFile("du", ["-sk", pathname], { signal });
    return parseDuLine(stdout);
  } catch (err) {
    if (signal?.aborted) {
      return null;
    }

    log("du error path=%s msg=%s", pathname, err instanceof Error ? err.message : String(err));

    // `du` exits non-zero when a subdirectory is unreadable but still reports a
    // total for everything it could walk, so prefer that partial size over none.
    const stdout = getErrorStdout(err);
    return stdout ? parseDuLine(stdout) : null;
  }
}

export async function refreshProjectDiskSize(project: DiskSizeProject) {
  const entry = await getDiskSize(project.pathname);
  if (!entry) {
    return null;
  }

  const nextCache = {
    ...parseCache(),
    [entry.pathname]: {
      size: entry.size,
      lastCommitTime: project.lastCommitTime,
    },
  };
  writeCache(nextCache);

  return entry.size;
}

export function getCachedProjectDiskSizes() {
  return getSizeMap(parseCache());
}

export function invalidateProjectDiskSizes(pathnames: string[]) {
  const nextCache = { ...parseCache() };

  for (const pathname of pathnames) {
    delete nextCache[pathname];
  }

  writeCache(nextCache);
}

export function streamProjectDiskSizes(sources: DiskSizeSource[], options: StreamOptions) {
  const start = Date.now();
  const nextCache = { ...parseCache() };
  const projects = sources.flatMap((source) => source.projects);
  const refreshProjects = projects.filter((project) => shouldRefreshDiskSize(project, nextCache[project.pathname]));
  const controller = new AbortController();

  log(
    "stream begin requested=%d cached=%d refresh=%d",
    projects.length,
    Object.keys(nextCache).length,
    refreshProjects.length,
  );

  if (refreshProjects.length === 0) {
    options.onComplete?.(getSizeMap(nextCache));
    log("stream done all-cached durationMs=%d", Date.now() - start);
    return () => {};
  }

  let measured = 0;

  void mapWithConcurrency(refreshProjects, CONCURRENCY, async (project) => {
    if (controller.signal.aborted) {
      return;
    }

    const entry = await getDiskSize(project.pathname, controller.signal);
    if (!entry || controller.signal.aborted) {
      return;
    }

    measured += 1;
    nextCache[entry.pathname] = {
      size: entry.size,
      lastCommitTime: project.lastCommitTime,
    };
    options.onSize(entry.pathname, entry.size);
  }).then(() => {
    if (controller.signal.aborted) {
      return;
    }

    writeCache(nextCache);
    options.onComplete?.(getSizeMap(nextCache));
    log("stream done refreshed=%d measured=%d durationMs=%d", refreshProjects.length, measured, Date.now() - start);
  });

  return () => {
    controller.abort();
  };
}
