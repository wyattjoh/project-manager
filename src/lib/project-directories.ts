import { LocalStorage } from "@raycast/api";

import { parseProjectPatterns } from "./project-sources";

const STORAGE_KEY = "projectDirectories";

/**
 * Returns the project directory patterns saved by the Manage Project Directories command.
 */
export async function getStoredProjectDirectories(): Promise<string[]> {
  const value = await LocalStorage.getItem<string>(STORAGE_KEY);
  if (!value) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export async function setStoredProjectDirectories(directories: string[]) {
  const cleaned = directories.map((directory) => directory.trim()).filter(Boolean);
  await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
}

/**
 * Resolves the active patterns, preferring stored directories over the comma-separated preference.
 */
export async function resolveProjectPatterns(directoryPreference: string | undefined): Promise<string[]> {
  const stored = await getStoredProjectDirectories();
  if (stored.length > 0) {
    return stored;
  }

  return parseProjectPatterns(directoryPreference ?? "");
}
