import type { Project } from "../types/project";
import fs from "node:fs/promises";
import path from "node:path";

import { getProjectGitDetails } from "./get-project-git-details";
import { getProfileDuration, getProfileStart, logProfile } from "./profile-log";

const PROJECT_SCAN_CONCURRENCY = 8;

type ProjectSource = {
  directory: string;
  titlePrefix: string | null;
  canArchive: boolean;
  directoriesOnly: boolean;
  source: Project["source"];
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

async function getProjectFilenames(source: ProjectSource) {
  const entries = await fs.readdir(source.directory, { withFileTypes: true });

  return entries
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => !source.directoriesOnly || entry.isDirectory())
    .map((entry) => entry.name);
}

async function getProjectsFromSource(source: ProjectSource) {
  const sourceStart = getProfileStart();
  let filenames: string[];
  try {
    const readdirStart = getProfileStart();
    filenames = await getProjectFilenames(source);
    logProfile("source readdir complete", {
      directory: source.directory,
      titlePrefix: source.titlePrefix,
      entries: filenames.length,
      durationMs: getProfileDuration(readdirStart),
    });
  } catch (error) {
    if (!source.canArchive) {
      logProfile("source readdir skipped", {
        directory: source.directory,
        titlePrefix: source.titlePrefix,
        durationMs: getProfileDuration(sourceStart),
        error: error instanceof Error ? error.message : String(error),
      });

      return [];
    }

    throw error;
  }

  const gitDurations: number[] = [];
  const projects = await mapWithConcurrency(filenames, PROJECT_SCAN_CONCURRENCY, async (filename): Promise<Project> => {
    const archived = source.canArchive && filename.endsWith(".tar.bz2");
    const pathname = path.join(source.directory, filename);
    const title = source.titlePrefix ? `${source.titlePrefix}/${filename}` : filename;

    const gitStart = getProfileStart();
    const gitDetails = await getProjectGitDetails(pathname);
    gitDurations.push(getProfileDuration(gitStart));

    return {
      id: pathname,
      filename: title,
      pathname,
      lastModifiedTime: gitDetails.lastCommitTime ? new Date(gitDetails.lastCommitTime) : null,
      gitBranch: gitDetails.branch,
      gitDirty: gitDetails.dirty,
      diskSize: null,
      isDiskSizeLoading: false,
      archived,
      canArchive: source.canArchive,
      worktreeCount: gitDetails.worktreeCount,
      source: source.source,
    } satisfies Project;
  });

  const gitTotalMs = gitDurations.reduce((total, duration) => total + duration, 0);
  const gitMaxMs = Math.max(0, ...gitDurations);

  logProfile("source scan complete", {
    directory: source.directory,
    titlePrefix: source.titlePrefix,
    entries: projects.length,
    durationMs: getProfileDuration(sourceStart),
    gitTotalMs,
    gitMaxMs,
    gitAverageMs: gitDurations.length > 0 ? Math.round(gitTotalMs / gitDurations.length) : 0,
  });

  return projects;
}

function getProjectSources(directory: string, codeDirectory: string | undefined) {
  const sources: ProjectSource[] = [
    {
      directory,
      titlePrefix: null,
      canArchive: true,
      directoriesOnly: false,
      source: "projects",
    },
  ];

  if (codeDirectory) {
    sources.push({
      directory: codeDirectory,
      titlePrefix: path.basename(codeDirectory),
      canArchive: false,
      directoriesOnly: true,
      source: "code",
    });
  }

  return sources;
}

export async function getProjects(
  directory: string,
  codeDirectory: string | undefined,
  _excludePatterns: string[],
): Promise<Project[]> {
  const start = getProfileStart();
  void _excludePatterns;

  const sources = getProjectSources(directory, codeDirectory);

  logProfile("project scan started", {
    sources: sources.map((source) => ({
      directory: source.directory,
      titlePrefix: source.titlePrefix,
      canArchive: source.canArchive,
      directoriesOnly: source.directoriesOnly,
    })),
  });

  const projects = (await Promise.all(sources.map(getProjectsFromSource))).flat();
  const sortStart = getProfileStart();

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

  logProfile("project scan complete", {
    entries: projects.length,
    sortDurationMs: getProfileDuration(sortStart),
    durationMs: getProfileDuration(start),
  });

  return projects;
}
