import type { Project } from "../types/project";

import { getProjectGitDetails } from "./get-project-git-details";
import { createLogger } from "./log";
import { discoverProjectSources, parseProjectPatterns, type ProjectSource } from "./project-sources";

const PROJECT_SCAN_CONCURRENCY = 8;
const log = createLogger("project-manager:scan");
const EMPTY_GIT_DETAILS = {
  branch: null,
  dirty: false,
  lastCommitTime: null,
  worktreeCount: 0,
  upstream: null,
  ahead: 0,
  behind: 0,
};

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

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  return results;
}

async function getProjectsFromSource(source: ProjectSource) {
  const start = Date.now();
  const gitDetails = source.archived ? EMPTY_GIT_DETAILS : await getProjectGitDetails(source.pathname);

  log(
    "source done path=%s archived=%s probeMs=%d totalMs=%d",
    source.pathname,
    source.archived,
    Date.now() - start,
    Date.now() - start,
  );

  return {
    id: source.pathname,
    filename: source.filename,
    pathname: source.pathname,
    lastModifiedTime: gitDetails.lastCommitTime ? new Date(gitDetails.lastCommitTime) : null,
    gitBranch: gitDetails.branch,
    gitDirty: gitDetails.dirty,
    gitUpstream: gitDetails.upstream,
    gitAhead: gitDetails.ahead,
    gitBehind: gitDetails.behind,
    diskSize: null,
    isDiskSizeLoading: false,
    archived: source.archived,
    canArchive: source.canArchive,
    worktreeCount: gitDetails.worktreeCount,
    source: source.source,
  } satisfies Project;
}

export async function getProjects(directory: string, _excludePatterns: string[]): Promise<Project[]> {
  void _excludePatterns;

  const start = Date.now();
  const sources = await discoverProjectSources(parseProjectPatterns(directory));
  log("scan begin sources=%d paths=%s", sources.length, sources.map((s) => s.pathname).join(","));
  const projects = await mapWithConcurrency(sources, PROJECT_SCAN_CONCURRENCY, getProjectsFromSource);
  const probeEnd = Date.now();

  // Sort by last commit time, keeping projects without commit dates at the bottom.
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

  log(
    "scan done sources=%d entries=%d probeMs=%d sortMs=%d totalMs=%d",
    sources.length,
    projects.length,
    probeEnd - start,
    Date.now() - probeEnd,
    Date.now() - start,
  );

  return projects;
}
