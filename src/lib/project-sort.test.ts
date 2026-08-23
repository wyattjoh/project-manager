import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Project } from "../types/project";
import { sortProjects } from "./project-sort";

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: overrides.pathname ?? overrides.filename ?? "project",
    filename: overrides.filename ?? "project",
    pathname: overrides.pathname ?? `/tmp/${overrides.filename ?? "project"}`,
    lastModifiedTime: overrides.lastModifiedTime ?? null,
    gitBranch: overrides.gitBranch ?? null,
    gitDirty: overrides.gitDirty ?? false,
    gitUpstream: overrides.gitUpstream ?? null,
    gitAhead: overrides.gitAhead ?? 0,
    gitBehind: overrides.gitBehind ?? 0,
    diskSize: overrides.diskSize ?? null,
    isDiskSizeLoading: overrides.isDiskSizeLoading ?? false,
    archived: overrides.archived ?? false,
    canArchive: overrides.canArchive ?? true,
    worktreeCount: overrides.worktreeCount ?? 1,
    source: "projects",
  };
}

describe("sortProjects", () => {
  test("sorts projects by most recent commit with missing dates last", () => {
    const projects = [
      makeProject({ filename: "older", lastModifiedTime: new Date("2026-01-01T00:00:00Z") }),
      makeProject({ filename: "missing", lastModifiedTime: null }),
      makeProject({ filename: "newer", lastModifiedTime: new Date("2026-02-01T00:00:00Z") }),
    ];

    assert.deepEqual(
      sortProjects(projects, "recent").map((project) => project.filename),
      ["newer", "older", "missing"],
    );
  });

  test("sorts projects by largest disk size with unknown sizes last", () => {
    const projects = [
      makeProject({ filename: "small", diskSize: 512 * 1024 }),
      makeProject({ filename: "unknown", diskSize: null }),
      makeProject({ filename: "large", diskSize: 1.5 * 1024 ** 3 }),
      makeProject({ filename: "medium", diskSize: 700 * 1024 ** 2 }),
    ];

    assert.deepEqual(
      sortProjects(projects, "largest").map((project) => project.filename),
      ["large", "medium", "small", "unknown"],
    );
  });

  test("sorts projects by name", () => {
    const projects = [
      makeProject({ filename: "clerk/pr-review" }),
      makeProject({ filename: "wyattjoh/project-manager" }),
      makeProject({ filename: "clerk/accounts" }),
    ];

    assert.deepEqual(
      sortProjects(projects, "name").map((project) => project.filename),
      ["clerk/accounts", "clerk/pr-review", "wyattjoh/project-manager"],
    );
  });
});
