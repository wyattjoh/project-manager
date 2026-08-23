import * as child_process from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { Project } from "../types/project";
import { getProjectGitDetails } from "./get-project-git-details";
import { createLogger } from "./log";

const execFile = promisify(child_process.execFile);
const log = createLogger("project-manager:scan");

type WorktreeInfo = {
  pathname: string;
  branch: string | null;
};

function parseWorktreeList(output: string) {
  const worktrees: WorktreeInfo[] = [];
  let current: WorktreeInfo | null = null;

  for (const line of output.split("\n")) {
    if (!line.trim()) {
      if (current) {
        worktrees.push(current);
        current = null;
      }

      continue;
    }

    if (line.startsWith("worktree ")) {
      current = {
        pathname: line.slice("worktree ".length),
        branch: null,
      };
      continue;
    }

    if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }

  if (current) {
    worktrees.push(current);
  }

  return worktrees;
}

export async function getProjectWorktrees(project: Project): Promise<Project[]> {
  const start = Date.now();
  const { stdout } = await execFile("git", ["--no-optional-locks", "worktree", "list", "--porcelain"], {
    cwd: project.pathname,
  });
  const worktrees = parseWorktreeList(stdout);
  const projects = await Promise.all(
    worktrees.map(async (worktree): Promise<Project> => {
      const gitDetails = await getProjectGitDetails(worktree.pathname);

      return {
        id: worktree.pathname,
        filename: path.basename(worktree.pathname),
        pathname: worktree.pathname,
        lastModifiedTime: gitDetails.lastCommitTime ? new Date(gitDetails.lastCommitTime) : null,
        gitBranch: gitDetails.branch ?? worktree.branch,
        gitDirty: gitDetails.dirty,
        gitUpstream: gitDetails.upstream,
        gitAhead: gitDetails.ahead,
        gitBehind: gitDetails.behind,
        diskSize: null,
        isDiskSizeLoading: false,
        archived: false,
        canArchive: false,
        worktreeCount: gitDetails.worktreeCount,
        source: project.source,
      } satisfies Project;
    }),
  );

  projects.sort((a, b) => {
    if (!a.lastModifiedTime && !b.lastModifiedTime) {
      return 0;
    }

    if (!a.lastModifiedTime) {
      return 1;
    }

    if (!b.lastModifiedTime) {
      return -1;
    }

    return b.lastModifiedTime.getTime() - a.lastModifiedTime.getTime();
  });

  log("worktrees done project=%s entries=%d totalMs=%d", project.pathname, projects.length, Date.now() - start);

  return projects;
}

export async function removeProjectWorktree(project: Project, worktree: Project) {
  await execFile("git", ["worktree", "remove", "--force", worktree.pathname], {
    cwd: project.pathname,
  });
}
