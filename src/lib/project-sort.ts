import type { Project } from "../types/project";

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
    return compareNullableNumbersDescending(left.diskSize, right.diskSize) || compareByName(left, right);
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
