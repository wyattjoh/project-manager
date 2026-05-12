import { Cache } from "@raycast/api";
import * as child_process from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const CACHE_KEY = "project-disk-sizes:v2";
const cache = new Cache({ namespace: "project-manager" });
const execFile = promisify(child_process.execFile);
const FALLBACK_CONCURRENCY = 8;

export type DiskSizeMap = Record<string, string>;

export type DiskSizeProject = {
  pathname: string;
  lastCommitTime: number | null;
};

type DiskSizeCacheEntry = {
  size: string;
  lastCommitTime: number | null;
};

type DiskSizeCache = Record<string, DiskSizeCacheEntry>;

type DiskSizeSource = {
  projects: DiskSizeProject[];
};

type StreamOptions = {
  onSize: (pathname: string, size: string) => void;
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

function parseDuLine(line: string) {
  const match = line.match(/^(\S+)\s+(.+)$/);
  if (!match) {
    return null;
  }

  return {
    pathname: path.resolve(match[2].replace(/\/$/, "")),
    size: match[1],
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

async function getDiskSize(pathname: string) {
  try {
    const { stdout } = await execFile("du", ["-sh", pathname]);
    return parseDuLine(stdout.trim());
  } catch {
    return null;
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

async function getMissingDiskSizes(pathnames: string[]) {
  const entries = await mapWithConcurrency(pathnames, FALLBACK_CONCURRENCY, getDiskSize);
  return entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

function streamDiskSizesForSource(source: DiskSizeSource, options: StreamOptions) {
  const pathnames = source.projects.map((project) => project.pathname);
  const child = child_process.spawn("du", ["-sh", ...pathnames]);
  let pending = "";

  const processLine = (line: string) => {
    const entry = parseDuLine(line);
    if (!entry) {
      return;
    }

    options.onSize(entry.pathname, entry.size);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";

    for (const line of lines) {
      processLine(line);
    }
  });

  child.on("error", () => {});
  child.on("close", () => {
    if (pending) {
      processLine(pending);
      pending = "";
    }
  });

  return child;
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
  const nextCache = { ...parseCache() };
  const projectsByPathname = new Map(
    sources.flatMap((source) => source.projects.map((project) => [project.pathname, project])),
  );
  const refreshProjects = sources.flatMap((source) =>
    source.projects.filter((project) => shouldRefreshDiskSize(project, nextCache[project.pathname])),
  );
  const expectedPathnames = new Set(refreshProjects.map((project) => project.pathname));
  const seenPathnames = new Set<string>();
  let canceled = false;

  if (refreshProjects.length === 0) {
    options.onComplete?.(getSizeMap(nextCache));
    return () => {};
  }

  const children = [
    streamDiskSizesForSource(
      {
        projects: refreshProjects,
      },
      {
        onSize: (pathname, size) => {
          if (canceled) {
            return;
          }

          nextCache[pathname] = {
            size,
            lastCommitTime: projectsByPathname.get(pathname)?.lastCommitTime ?? null,
          };
          seenPathnames.add(pathname);
          options.onSize(pathname, size);
        },
      },
    ),
  ];
  let remaining = children.length;

  for (const child of children) {
    child.on("close", () => {
      if (canceled) {
        return;
      }

      remaining -= 1;

      if (remaining === 0) {
        const missingPathnames = Array.from(expectedPathnames).filter((pathname) => !seenPathnames.has(pathname));

        void getMissingDiskSizes(missingPathnames).then((sizes) => {
          if (canceled) {
            return;
          }

          for (const { pathname, size } of sizes) {
            nextCache[pathname] = {
              size,
              lastCommitTime: projectsByPathname.get(pathname)?.lastCommitTime ?? null,
            };
            options.onSize(pathname, size);
          }

          writeCache(nextCache);
          options.onComplete?.(getSizeMap(nextCache));
        });
      }
    });
  }

  return () => {
    canceled = true;

    for (const child of children) {
      child.kill();
    }
  };
}
