import { Cache } from "@raycast/api";
import * as child_process from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { exists } from "./exists";
import { createLogger } from "./log";

const execFile = promisify(child_process.execFile);
const cache = new Cache({ namespace: "project-manager" });
const COMMIT_TIME_CACHE_PREFIX = "git-last-commit:v1:";
const log = createLogger("project-manager:git");

type ProjectGitDetails = {
  branch: string | null;
  dirty: boolean;
  lastCommitTime: number | null;
  worktreeCount: number;
  upstream: string | null;
  ahead: number;
  behind: number;
};

type GitStatus = {
  headOid: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
};

const EMPTY_DETAILS: ProjectGitDetails = {
  branch: null,
  dirty: false,
  lastCommitTime: null,
  worktreeCount: 0,
  upstream: null,
  ahead: 0,
  behind: 0,
};

async function execGit(dir: string, args: string[]) {
  const { stdout } = await execFile("git", args, { cwd: dir });
  return stdout.trim();
}

async function getGitDir(dir: string) {
  const dotGitPath = path.join(dir, ".git");
  const stats = await fs.lstat(dotGitPath);

  if (stats.isDirectory()) {
    return dotGitPath;
  }

  const dotGitFile = await fs.readFile(dotGitPath, "utf8");
  const gitDir = dotGitFile.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();

  if (!gitDir) {
    return null;
  }

  return path.isAbsolute(gitDir) ? gitDir : path.resolve(dir, gitDir);
}

async function getCommonGitDir(gitDir: string) {
  try {
    const commonDir = (await fs.readFile(path.join(gitDir, "commondir"), "utf8")).trim();
    return path.isAbsolute(commonDir) ? commonDir : path.resolve(gitDir, commonDir);
  } catch {
    return gitDir;
  }
}

async function readRefOid(commonGitDir: string, refPath: string): Promise<string | null> {
  const loose = await fs.readFile(path.join(commonGitDir, refPath), "utf8").catch(() => null);
  if (loose) {
    return loose.trim();
  }

  const packed = await fs.readFile(path.join(commonGitDir, "packed-refs"), "utf8").catch(() => null);
  if (!packed) {
    return null;
  }

  for (const line of packed.split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("^")) {
      continue;
    }

    const space = line.indexOf(" ");
    if (space === -1) {
      continue;
    }

    if (line.slice(space + 1) === refPath) {
      return line.slice(0, space);
    }
  }

  return null;
}

async function getGitStatus(dir: string): Promise<GitStatus | null> {
  try {
    const stdout = await execGit(dir, ["status", "--porcelain=v2", "--branch"]);
    const status: GitStatus = {
      headOid: null,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      dirty: false,
    };

    for (const line of stdout.split("\n")) {
      if (line.startsWith("# branch.oid ")) {
        const oid = line.slice("# branch.oid ".length);
        if (oid !== "(initial)") {
          status.headOid = oid;
        }
      } else if (line.startsWith("# branch.head ")) {
        const value = line.slice("# branch.head ".length);
        if (value !== "(detached)") {
          status.branch = value;
        }
      } else if (line.startsWith("# branch.upstream ")) {
        status.upstream = line.slice("# branch.upstream ".length);
      } else if (line.startsWith("# branch.ab ")) {
        const match = line.match(/\+(\d+) -(\d+)/);
        if (match) {
          status.ahead = Number(match[1]);
          status.behind = Number(match[2]);
        }
      } else if (line && !line.startsWith("#")) {
        status.dirty = true;
      }
    }

    return status;
  } catch {
    return null;
  }
}

function readCachedCommitTime(cacheKey: string): number | null {
  const cached = cache.get(COMMIT_TIME_CACHE_PREFIX + cacheKey);
  if (cached === undefined) {
    return null;
  }

  const value = Number(cached);
  return Number.isFinite(value) ? value : null;
}

function writeCachedCommitTime(cacheKey: string, timestamp: number) {
  cache.set(COMMIT_TIME_CACHE_PREFIX + cacheKey, String(timestamp));
}

async function shellLastCommitTime(dir: string, upstream: string | null): Promise<number | null> {
  const args = ["log", "-1", "--format=%ct"];
  if (upstream) {
    args.push("HEAD", upstream);
  }

  const stdout = await execGit(dir, args).catch(() => null);
  if (!stdout) {
    return null;
  }

  const timestamp = Number(stdout) * 1000;
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function getWorktreeCount(commonGitDir: string) {
  const worktrees = await fs.readdir(path.join(commonGitDir, "worktrees")).catch(() => []);
  return worktrees.length + 1;
}

export async function getProjectGitDetails(dir: string): Promise<ProjectGitDetails> {
  const start = Date.now();

  try {
    if (!(await exists(path.join(dir, ".git")))) {
      log("probe path=%s totalMs=%d no-git", dir, Date.now() - start);
      return EMPTY_DETAILS;
    }

    const gitDir = await getGitDir(dir);
    if (!gitDir) {
      log("probe path=%s totalMs=%d no-gitdir", dir, Date.now() - start);
      return EMPTY_DETAILS;
    }

    const commonGitDir = await getCommonGitDir(gitDir);

    const statusStart = Date.now();
    const [status, worktreeCount] = await Promise.all([getGitStatus(dir), getWorktreeCount(commonGitDir)]);
    const statusMs = Date.now() - statusStart;

    if (!status) {
      log("probe path=%s totalMs=%d statusMs=%d status-failed", dir, Date.now() - start, statusMs);
      return { ...EMPTY_DETAILS, worktreeCount };
    }

    const oidStart = Date.now();
    const upstreamOid = status.upstream ? await readRefOid(commonGitDir, `refs/remotes/${status.upstream}`) : null;
    const oidMs = Date.now() - oidStart;

    let lastCommitTime: number | null = null;
    let logMs = 0;
    let cacheState: "hit" | "miss" | "no-head" = "no-head";

    if (status.headOid) {
      const cacheKey = upstreamOid ? `${status.headOid}:${upstreamOid}` : status.headOid;
      const cached = readCachedCommitTime(cacheKey);
      if (cached !== null) {
        lastCommitTime = cached;
        cacheState = "hit";
      } else {
        cacheState = "miss";
        const logStart = Date.now();
        lastCommitTime = await shellLastCommitTime(dir, status.upstream);
        logMs = Date.now() - logStart;

        if (lastCommitTime !== null) {
          writeCachedCommitTime(cacheKey, lastCommitTime);
        }
      }
    }

    log(
      "probe path=%s totalMs=%d statusMs=%d oidMs=%d logMs=%d cache=%s dirty=%s ahead=%d behind=%d worktrees=%d",
      dir,
      Date.now() - start,
      statusMs,
      oidMs,
      logMs,
      cacheState,
      status.dirty,
      status.ahead,
      status.behind,
      worktreeCount,
    );

    return {
      branch: status.branch,
      dirty: status.dirty,
      lastCommitTime,
      worktreeCount,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
    };
  } catch (err) {
    log("probe path=%s totalMs=%d error=%s", dir, Date.now() - start, err instanceof Error ? err.message : String(err));
    return EMPTY_DETAILS;
  }
}
