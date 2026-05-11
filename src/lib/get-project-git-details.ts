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
  lastCommitTime: number | null;
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

export async function getProjectGitDetails(dir: string): Promise<ProjectGitDetails> {
  const start = getProfileStart();

  try {
    if (!(await exists(path.join(dir, ".git")))) {
      return { branch: null, lastCommitTime: null };
    }

    const [branch, lastCommitTimestamp] = await Promise.all([
      getGitBranch(dir),
      execGit(dir, ["log", "-1", "--format=%ct"]).catch(() => null),
    ]);

    const duration = getProfileDuration(start);
    if (duration >= SLOW_GIT_THRESHOLD_MS) {
      logProfile("slow git metadata", {
        directory: dir,
        durationMs: duration,
        branch,
        hasCommit: Boolean(lastCommitTimestamp),
      });
    }

    return {
      branch,
      lastCommitTime: lastCommitTimestamp ? Number(lastCommitTimestamp) * 1000 : null,
    };
  } catch (error) {
    logProfile("git metadata failed", {
      directory: dir,
      durationMs: getProfileDuration(start),
      error: error instanceof Error ? error.message : String(error),
    });

    return { branch: null, lastCommitTime: null };
  }
}
