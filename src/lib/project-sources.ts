import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Project } from "../types/project";

/**
 * Describes one filesystem source scanned for projects.
 */
export type ProjectSource = {
  pathname: string;
  filename: string;
  archived: boolean;
  canArchive: boolean;
  source: Project["source"];
};

/**
 * Describes why a project candidate was accepted or rejected.
 */
export type ProjectSourceDebugCandidate = {
  pathname: string;
  shouldPrefixFilename: boolean;
  matched: boolean;
  status: "git-repository" | "archive" | "missing" | "not-directory" | "not-git-repository";
};

/**
 * Describes how one configured project pattern expanded.
 */
export type ProjectSourceDebugPattern = {
  pattern: string;
  absolutePattern: string;
  hasGlobPattern: boolean;
  candidates: ProjectSourceDebugCandidate[];
};

/**
 * Summarizes project source discovery for debugging the Raycast preferences received by a command.
 */
export type ProjectSourceDebugSnapshot = {
  patterns: ProjectSourceDebugPattern[];
  sources: ProjectSource[];
};

/**
 * Controls how a project's display name includes its containing folders.
 */
export type ProjectNameStyle = "auto" | "name" | "owner" | "domain";

/**
 * A configured directory pattern and the naming style applied to projects it matches.
 */
export type ProjectPattern = {
  pattern: string;
  nameStyle: ProjectNameStyle;
};

type ProjectCandidate = {
  pathname: string;
  shouldPrefixFilename: boolean;
};

type MatchedProjectSource = ProjectSource & {
  shouldPrefixFilename: boolean;
};

/**
 * Parses the comma-separated project directory pattern preference into usable patterns.
 */
export function parseProjectPatterns(directoryPreference: string): string[] {
  return directoryPreference
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}

/**
 * Resolves comma-separated project patterns into git repositories and archives.
 */
export async function discoverProjectSources(patterns: Array<string | ProjectPattern>): Promise<ProjectSource[]> {
  const nameStyles = new Map<string, ProjectNameStyle>();
  const candidates: ProjectCandidate[] = [];

  for (const { pattern, nameStyle } of patterns.map(toProjectPattern)) {
    for (const candidate of await expandProjectPattern(pattern)) {
      const resolvedPathname = path.resolve(candidate.pathname);
      if (!nameStyles.has(resolvedPathname)) {
        nameStyles.set(resolvedPathname, nameStyle);
      }
      candidates.push(candidate);
    }
  }

  const sources = await getMatchedProjectSources(candidates);
  return applyFilenamePrefixes(sources, nameStyles);
}

function toProjectPattern(pattern: string | ProjectPattern): ProjectPattern {
  return typeof pattern === "string" ? { pattern, nameStyle: "auto" } : pattern;
}

/**
 * Resolves project patterns and returns intermediate expansion details for diagnostics.
 */
export async function getProjectSourceDebugSnapshot(
  patterns: Array<string | ProjectPattern>,
): Promise<ProjectSourceDebugSnapshot> {
  const debugPatterns: ProjectSourceDebugPattern[] = [];

  for (const { pattern } of patterns.map(toProjectPattern)) {
    const absolutePattern = toAbsolutePath(pattern);
    const candidates = await expandProjectPattern(pattern);
    debugPatterns.push({
      pattern,
      absolutePattern,
      hasGlobPattern: hasGlobPattern(absolutePattern),
      candidates: await Promise.all(candidates.map(getProjectSourceDebugCandidate)),
    });
  }

  return {
    patterns: debugPatterns,
    sources: await discoverProjectSources(patterns),
  };
}

async function expandProjectPattern(pattern: string): Promise<ProjectCandidate[]> {
  const absolutePattern = toAbsolutePath(pattern);

  if (!hasGlobPattern(absolutePattern)) {
    return expandLiteralProjectPath(absolutePattern);
  }

  const segments = absolutePattern.split(path.sep).filter(Boolean);
  return expandPatternSegments(path.parse(absolutePattern).root, segments, 0);
}

async function expandPatternSegments(
  currentPath: string,
  segments: string[],
  segmentIndex: number,
): Promise<ProjectCandidate[]> {
  if (segmentIndex >= segments.length) {
    return [{ pathname: currentPath, shouldPrefixFilename: true }];
  }

  const segment = segments[segmentIndex];

  if (segment === "**") {
    const matches = await expandPatternSegments(currentPath, segments, segmentIndex + 1);

    if (await isGitRepository(currentPath)) {
      return matches;
    }

    for (const entry of await readDirectoryEntries(currentPath)) {
      if (!entry.isDirectory()) {
        continue;
      }

      matches.push(...(await expandPatternSegments(path.join(currentPath, entry.name), segments, segmentIndex)));
    }

    return matches;
  }

  if (!hasGlobPattern(segment)) {
    return expandPatternSegments(path.join(currentPath, segment), segments, segmentIndex + 1);
  }

  const isLastSegment = segmentIndex === segments.length - 1;
  const matches: ProjectCandidate[] = [];

  for (const entry of await readDirectoryEntries(currentPath)) {
    if (!isLastSegment && !entry.isDirectory()) {
      continue;
    }

    if (globSegmentMatches(segment, entry.name)) {
      matches.push(...(await expandPatternSegments(path.join(currentPath, entry.name), segments, segmentIndex + 1)));
    }
  }

  return matches;
}

async function expandLiteralProjectPath(pathname: string) {
  const stats = await fs.stat(pathname).catch(() => null);

  if (!stats?.isDirectory() || (await isGitRepository(pathname))) {
    return [{ pathname, shouldPrefixFilename: true }];
  }

  return (await readDirectoryEntries(pathname)).map((entry) => ({
    pathname: path.join(pathname, entry.name),
    shouldPrefixFilename: true,
  }));
}

async function getProjectSourceDebugCandidate(candidate: ProjectCandidate): Promise<ProjectSourceDebugCandidate> {
  const pathname = path.resolve(candidate.pathname);
  const stats = await fs.stat(pathname).catch(() => null);

  if (!stats) {
    return {
      pathname,
      shouldPrefixFilename: candidate.shouldPrefixFilename,
      matched: false,
      status: "missing",
    };
  }

  if (stats.isFile() && pathname.endsWith(".tar.bz2")) {
    return {
      pathname,
      shouldPrefixFilename: candidate.shouldPrefixFilename,
      matched: true,
      status: "archive",
    };
  }

  if (!stats.isDirectory()) {
    return {
      pathname,
      shouldPrefixFilename: candidate.shouldPrefixFilename,
      matched: false,
      status: "not-directory",
    };
  }

  const matched = await isGitRepository(pathname);

  return {
    pathname,
    shouldPrefixFilename: candidate.shouldPrefixFilename,
    matched,
    status: matched ? "git-repository" : "not-git-repository",
  };
}

async function getMatchedProjectSources(candidates: ProjectCandidate[]) {
  const sourcesByPathname = new Map<string, MatchedProjectSource>();

  for (const candidate of candidates) {
    const resolvedPathname = path.resolve(candidate.pathname);
    const existing = sourcesByPathname.get(resolvedPathname);

    if (existing) {
      existing.shouldPrefixFilename ||= candidate.shouldPrefixFilename;
      continue;
    }

    const source = await getMatchedProjectSource({
      pathname: resolvedPathname,
      shouldPrefixFilename: candidate.shouldPrefixFilename,
    });

    if (source) {
      sourcesByPathname.set(resolvedPathname, source);
    }
  }

  return Array.from(sourcesByPathname.values());
}

async function getMatchedProjectSource(candidate: ProjectCandidate): Promise<MatchedProjectSource | null> {
  const { pathname } = candidate;
  const stats = await fs.stat(pathname).catch(() => null);

  if (!stats) {
    return null;
  }

  if (stats.isFile() && pathname.endsWith(".tar.bz2")) {
    return {
      pathname,
      filename: path.basename(pathname),
      archived: true,
      canArchive: true,
      source: "projects",
      shouldPrefixFilename: candidate.shouldPrefixFilename,
    };
  }

  if (!stats.isDirectory() || !(await isGitRepository(pathname))) {
    return null;
  }

  return {
    pathname,
    filename: path.basename(pathname),
    archived: false,
    canArchive: true,
    source: "projects",
    shouldPrefixFilename: candidate.shouldPrefixFilename,
  };
}

async function isGitRepository(pathname: string) {
  const dotGitStats = await fs.stat(path.join(pathname, ".git")).catch(() => null);
  return Boolean(dotGitStats);
}

function applyFilenamePrefixes(
  sources: MatchedProjectSource[],
  nameStyles: Map<string, ProjectNameStyle>,
): ProjectSource[] {
  const filenameCounts = sources.reduce<Record<string, number>>((counts, source) => {
    counts[source.filename] = (counts[source.filename] ?? 0) + 1;
    return counts;
  }, {});

  return sources.map((source) => {
    const { shouldPrefixFilename, ...projectSource } = source;
    const parentPathname = path.dirname(source.pathname);
    const parentName = path.basename(parentPathname);
    const grandparentName = path.basename(path.dirname(parentPathname));
    const nameStyle = nameStyles.get(source.pathname) ?? "auto";

    if (nameStyle !== "auto") {
      const prefixes = { name: [], owner: [parentName], domain: [grandparentName, parentName] }[nameStyle];
      return { ...projectSource, filename: [...prefixes, source.filename].join("/") };
    }

    const filename = grandparentName.includes(".")
      ? `${grandparentName}/${parentName}/${source.filename}`
      : shouldPrefixFilename || filenameCounts[source.filename] > 1
        ? `${parentName}/${source.filename}`
        : source.filename;

    return {
      ...projectSource,
      filename,
    };
  });
}

async function readDirectoryEntries(pathname: string) {
  const entries = await fs.readdir(pathname, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function toAbsolutePath(pattern: string) {
  if (pattern === "~") {
    return os.homedir();
  }

  if (pattern.startsWith("~/")) {
    return path.join(os.homedir(), pattern.slice(2));
  }

  if (path.isAbsolute(pattern)) {
    return path.normalize(pattern);
  }

  return path.resolve(pattern);
}

function hasGlobPattern(value: string) {
  return /[*?[]/.test(value);
}

function globSegmentMatches(pattern: string, value: string) {
  return new RegExp(`^${globSegmentToRegExp(pattern)}$`).test(value);
}

function globSegmentToRegExp(pattern: string) {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];

    if (character === "*") {
      source += "[^/]*";
      continue;
    }

    if (character === "?") {
      source += "[^/]";
      continue;
    }

    if (character === "[") {
      const closeIndex = pattern.indexOf("]", index + 1);

      if (closeIndex !== -1) {
        const group = pattern.slice(index + 1, closeIndex);
        source += group.startsWith("!")
          ? `[^${escapeCharacterClass(group.slice(1))}]`
          : `[${escapeCharacterClass(group)}]`;
        index = closeIndex;
        continue;
      }
    }

    source += escapeRegExp(character);
  }

  return source;
}

function escapeRegExp(value: string) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function escapeCharacterClass(value: string) {
  return value.replace(/[\\\]]/g, "\\$&");
}
