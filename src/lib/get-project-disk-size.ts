import { Cache } from "@raycast/api";
import * as child_process from "node:child_process";
import path from "node:path";

import { getProfileDuration, getProfileStart, logProfile } from "./profile-log";

const CACHE_KEY = "project-disk-sizes:v1";
const cache = new Cache({ namespace: "project-manager" });

export type DiskSizeMap = Record<string, string>;

type DiskSizeSource = {
  directory: string;
  directoriesOnly: boolean;
};

type StreamOptions = {
  onSize: (pathname: string, size: string) => void;
  onComplete?: (sizes: DiskSizeMap) => void;
};

function parseCache() {
  const cached = cache.get(CACHE_KEY);
  if (!cached) {
    return {};
  }

  try {
    return JSON.parse(cached) as DiskSizeMap;
  } catch {
    return {};
  }
}

function writeCache(sizes: DiskSizeMap) {
  cache.set(CACHE_KEY, JSON.stringify(sizes));
}

function parseDuLine(directory: string, line: string) {
  const match = line.match(/^(\S+)\s+(.+)$/);
  if (!match) {
    return null;
  }

  return {
    pathname: path.join(directory, match[2].replace(/\/$/, "")),
    size: match[1],
  };
}

function streamDiskSizesForSource(source: DiskSizeSource, options: StreamOptions) {
  const start = getProfileStart();
  const pattern = source.directoriesOnly ? "*/" : "*";
  const child = child_process.spawn("sh", ["-c", `du -sh -- ${pattern}`], {
    cwd: source.directory,
  });
  let pending = "";
  let entries = 0;
  let settled = false;

  const finish = (error?: Error) => {
    if (settled) {
      return;
    }

    settled = true;

    if (error) {
      logProfile("du stream failed", {
        directory: source.directory,
        pattern,
        entries,
        durationMs: getProfileDuration(start),
        error: error.message,
      });
      return;
    }

    logProfile("du stream complete", {
      directory: source.directory,
      pattern,
      entries,
      durationMs: getProfileDuration(start),
    });
  };

  const processLine = (line: string) => {
    const entry = parseDuLine(source.directory, line);
    if (!entry) {
      return;
    }

    entries += 1;
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

  child.on("error", finish);
  child.on("close", (code) => {
    if (pending) {
      processLine(pending);
      pending = "";
    }

    finish(code === 0 ? undefined : new Error(`du exited with code ${code}`));
  });

  return child;
}

export function getCachedProjectDiskSizes() {
  return parseCache();
}

export function streamProjectDiskSizes(sources: DiskSizeSource[], options: StreamOptions) {
  const start = getProfileStart();
  const nextSizes = { ...parseCache() };
  let remaining = sources.length;
  let canceled = false;

  logProfile("disk size stream started", {
    sources,
  });

  if (remaining === 0) {
    options.onComplete?.(nextSizes);
    return () => {};
  }

  const children = sources.map((source) =>
    streamDiskSizesForSource(source, {
      onSize: (pathname, size) => {
        if (canceled) {
          return;
        }

        nextSizes[pathname] = size;
        options.onSize(pathname, size);
      },
    }),
  );

  for (const child of children) {
    child.on("close", () => {
      if (canceled) {
        return;
      }

      remaining -= 1;

      if (remaining === 0) {
        writeCache(nextSizes);
        logProfile("disk size stream complete", {
          entries: Object.keys(nextSizes).length,
          durationMs: getProfileDuration(start),
        });
        options.onComplete?.(nextSizes);
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
