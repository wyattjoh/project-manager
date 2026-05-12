import type { Project } from "../types/project";
import fs from "node:fs/promises";
import path from "node:path";

import { getProjectGitDetails } from "./get-project-git-details";

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
  let filenames: string[];
  try {
    filenames = await getProjectFilenames(source);
  } catch (error) {
    if (!source.canArchive) {
      return [];
    }

    throw error;
  }

  return mapWithConcurrency(filenames, PROJECT_SCAN_CONCURRENCY, async (filename): Promise<Project> => {
    const archived = source.canArchive && filename.endsWith(".tar.bz2");
    const pathname = path.join(source.directory, filename);
    const title = source.titlePrefix ? `${source.titlePrefix}/${filename}` : filename;

    const gitDetails = await getProjectGitDetails(pathname);

    return {
      id: pathname,
      filename: title,
      pathname,
      lastModifiedTime: gitDetails.lastCommitTime ? new Date(gitDetails.lastCommitTime) : null,
      gitBranch: gitDetails.branch,
      gitDirty: gitDetails.dirty,
      gitUpstream: gitDetails.upstream,
      gitAhead: gitDetails.ahead,
      gitBehind: gitDetails.behind,
      diskSize: null,
      isDiskSizeLoading: false,
      archived,
      canArchive: source.canArchive,
      worktreeCount: gitDetails.worktreeCount,
      source: source.source,
    } satisfies Project;
  });
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
  void _excludePatterns;

  const sources = getProjectSources(directory, codeDirectory);
  const projects = (await Promise.all(sources.map(getProjectsFromSource))).flat();

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

  return projects;
}
