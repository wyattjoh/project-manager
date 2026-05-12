import * as child_process from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { exists } from "./exists";
import { getProfileDuration, getProfileStart, logProfile } from "./profile-log";

const execFile = promisify(child_process.execFile);
const SLOW_GIT_THRESHOLD_MS = 250;

type ProjectGitDetails = {
  branch: string | null;
  dirty: boolean;
  lastCommitTime: number | null;
  worktreeCount: number;
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

async function getGitBranch(dir: string) {
  try {
    const gitDir = await getGitDir(dir);
    if (!gitDir) {
      return null;
    }

    const head = await fs.readFile(path.join(gitDir, "HEAD"), "utf8");
    return head.match(/^ref:\s*refs\/heads\/(.+)$/m)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

async function getCommonGitDir(gitDir: string) {
  try {
    const commonDir = (await fs.readFile(path.join(gitDir, "commondir"), "utf8")).trim();
    return path.isAbsolute(commonDir) ? commonDir : path.resolve(gitDir, commonDir);
  } catch {
    return gitDir;
  }
}

async function getWorktreeCount(dir: string) {
  try {
    const gitDir = await getGitDir(dir);
    if (!gitDir) {
      return 0;
    }

    const commonGitDir = await getCommonGitDir(gitDir);
    const worktrees = await fs.readdir(path.join(commonGitDir, "worktrees")).catch(() => []);

    return worktrees.length + 1;
  } catch {
    return 0;
  }
}

export async function getProjectGitDetails(dir: string): Promise<ProjectGitDetails> {
  const start = getProfileStart();

  try {
    if (!(await exists(path.join(dir, ".git")))) {
      return { branch: null, dirty: false, lastCommitTime: null, worktreeCount: 0 };
    }

    const [branch, dirtyStatus, lastCommitTimestamp, worktreeCount] = await Promise.all([
      getGitBranch(dir),
      execGit(dir, ["status", "--porcelain"]).catch(() => ""),
      execGit(dir, ["log", "-1", "--format=%ct"]).catch(() => null),
      getWorktreeCount(dir),
    ]);
    const dirty = dirtyStatus.length > 0;

    const duration = getProfileDuration(start);
    if (duration >= SLOW_GIT_THRESHOLD_MS) {
      logProfile("slow git metadata", {
        directory: dir,
        durationMs: duration,
        branch,
        dirty,
        hasCommit: Boolean(lastCommitTimestamp),
        worktreeCount,
      });
    }

    return {
      branch,
      dirty,
      lastCommitTime: lastCommitTimestamp ? Number(lastCommitTimestamp) * 1000 : null,
      worktreeCount,
    };
  } catch (error) {
    logProfile("git metadata failed", {
      directory: dir,
      durationMs: getProfileDuration(start),
      error: error instanceof Error ? error.message : String(error),
    });

    return { branch: null, dirty: false, lastCommitTime: null, worktreeCount: 0 };
  }
}
