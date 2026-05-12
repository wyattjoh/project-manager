import { Cache } from "@raycast/api";
import * as child_process from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { exists } from "./exists";

const execFile = promisify(child_process.execFile);
const cache = new Cache({ namespace: "project-manager" });
const COMMIT_TIME_CACHE_PREFIX = "git-last-commit:v1:";

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

async function resolveLastCommitTime(
  dir: string,
  headOid: string | null,
  upstream: string | null,
  upstreamOid: string | null,
): Promise<number | null> {
  if (!headOid) {
    return null;
  }

  const cacheKey = upstreamOid ? `${headOid}:${upstreamOid}` : headOid;
  const cached = readCachedCommitTime(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const args = ["log", "-1", "--format=%ct"];
  if (upstream) {
    args.push("HEAD", upstream);
  }

  const stdout = await execGit(dir, args).catch(() => null);
  if (!stdout) {
    return null;
  }

  const timestamp = Number(stdout) * 1000;
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  writeCachedCommitTime(cacheKey, timestamp);
  return timestamp;
}

async function getWorktreeCount(commonGitDir: string) {
  const worktrees = await fs.readdir(path.join(commonGitDir, "worktrees")).catch(() => []);
  return worktrees.length + 1;
}

export async function getProjectGitDetails(dir: string): Promise<ProjectGitDetails> {
  try {
    if (!(await exists(path.join(dir, ".git")))) {
      return EMPTY_DETAILS;
    }

    const gitDir = await getGitDir(dir);
    if (!gitDir) {
      return EMPTY_DETAILS;
    }

    const commonGitDir = await getCommonGitDir(gitDir);
    const [status, worktreeCount] = await Promise.all([getGitStatus(dir), getWorktreeCount(commonGitDir)]);

    if (!status) {
      return { ...EMPTY_DETAILS, worktreeCount };
    }

    const upstreamOid = status.upstream ? await readRefOid(commonGitDir, `refs/remotes/${status.upstream}`) : null;
    const lastCommitTime = await resolveLastCommitTime(dir, status.headOid, status.upstream, upstreamOid);

    return {
      branch: status.branch,
      dirty: status.dirty,
      lastCommitTime,
      worktreeCount,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
    };
  } catch {
    return EMPTY_DETAILS;
  }
}
