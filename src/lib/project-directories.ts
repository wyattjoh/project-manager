import { LocalStorage } from "@raycast/api";

import type { ProjectNameStyle, ProjectPattern } from "./project-sources";

const STORAGE_KEY = "projectDirectories";

export const PROJECT_NAME_STYLES: Array<{ value: ProjectNameStyle; title: string }> = [
  { value: "auto", title: "Auto" },
  { value: "name", title: "Name Only" },
  { value: "owner", title: "Owner/Name" },
  { value: "domain", title: "Domain/Owner/Name" },
];

function isProjectNameStyle(value: unknown): value is ProjectNameStyle {
  return PROJECT_NAME_STYLES.some((style) => style.value === value);
}

function toProjectPattern(item: unknown): ProjectPattern | null {
  if (typeof item === "string") {
    return { pattern: item, nameStyle: "auto" };
  }

  if (typeof item !== "object" || item === null) {
    return null;
  }

  const { pattern, nameStyle } = item as Record<string, unknown>;
  if (typeof pattern !== "string") {
    return null;
  }

  return { pattern, nameStyle: isProjectNameStyle(nameStyle) ? nameStyle : "auto" };
}

/**
 * Returns the project directory patterns saved by the Manage Project Directories command.
 */
export async function getStoredProjectDirectories(): Promise<ProjectPattern[]> {
  const value = await LocalStorage.getItem<string>(STORAGE_KEY);
  if (!value) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.map(toProjectPattern).filter((item): item is ProjectPattern => item !== null);
  } catch {
    return [];
  }
}

export async function setStoredProjectDirectories(directories: ProjectPattern[]) {
  const cleaned = directories
    .map((directory) => ({ ...directory, pattern: directory.pattern.trim() }))
    .filter((directory) => directory.pattern);
  await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
}
