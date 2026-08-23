import type { Project } from "../types/project";

const DISK_SIZE_UNITS: Record<string, number> = {
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
  P: 1024 ** 5,
};

/**
 * Available project sort modes for the search command.
 */
export type SortMode = "recent" | "largest" | "name";

/**
 * Sorts projects for display in the search command.
 */
export function sortProjects(projects: Project[], sortMode: SortMode): Project[] {
  return [...projects].sort((left, right) => compareProjects(left, right, sortMode));
}

function compareProjects(left: Project, right: Project, sortMode: SortMode) {
  if (sortMode === "largest") {
    return (
      compareNullableNumbersDescending(parseDiskSize(left.diskSize), parseDiskSize(right.diskSize)) ||
      compareByName(left, right)
    );
  }

  if (sortMode === "name") {
    return compareByName(left, right);
  }

  return compareNullableNumbersDescending(getProjectTime(left), getProjectTime(right)) || compareByName(left, right);
}

function getProjectTime(project: Project) {
  return project.lastModifiedTime?.getTime() ?? null;
}

function compareNullableNumbersDescending(left: number | null, right: number | null) {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return right - left;
}

function compareByName(left: Project, right: Project) {
  return left.filename.localeCompare(right.filename);
}

function parseDiskSize(diskSize: string | null) {
  if (!diskSize) {
    return null;
  }

  const match = diskSize.trim().match(/^(\d+(?:\.\d+)?)\s*([BKMGTPE])?$/i);
  if (!match) {
    return null;
  }

  const value = Number.parseFloat(match[1]);
  const unit = match[2]?.toUpperCase() ?? "B";

  return value * (DISK_SIZE_UNITS[unit] ?? 1);
}
