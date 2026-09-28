import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { discoverProjectSources, getProjectSourceDebugSnapshot } from "./project-sources";

async function makeTempDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), "project-manager-sources-"));
}

async function makeGitRepository(pathname: string) {
  await fs.mkdir(path.join(pathname, ".git"), { recursive: true });
}

describe("discoverProjectSources", () => {
  test("applies the configured name style for each pattern", async () => {
    const directory = await makeTempDirectory();
    const repositoryPath = path.join(directory, "github.com", "owner", "repo");
    await makeGitRepository(repositoryPath);
    const pattern = path.join(directory, "github.com", "owner", "*");

    for (const [nameStyle, filename] of [
      ["name", "repo"],
      ["owner", "owner/repo"],
      ["domain", "github.com/owner/repo"],
      ["auto", "github.com/owner/repo"],
    ] as const) {
      const [source] = await discoverProjectSources([{ pattern, nameStyle }]);
      assert.equal(source.filename, filename);
    }
  });

  test("treats a literal non-repo directory as a container of projects", async () => {
    const directory = await makeTempDirectory();
    const repositoryPath = path.join(directory, "repo");
    const plainDirectoryPath = path.join(directory, "plain");
    await fs.mkdir(repositoryPath);
    await fs.mkdir(plainDirectoryPath);
    await makeGitRepository(repositoryPath);

    assert.deepEqual(await discoverProjectSources([directory]), [
      {
        pathname: repositoryPath,
        filename: `${path.basename(directory)}/repo`,
        archived: false,
        canArchive: true,
        source: "projects",
      },
    ]);
  });

  test("treats a literal path as a project only when it is a git repository", async () => {
    const directory = await makeTempDirectory();
    const repositoryPath = path.join(directory, "repo");
    const plainDirectoryPath = path.join(directory, "plain");
    await fs.mkdir(repositoryPath);
    await fs.mkdir(plainDirectoryPath);
    await makeGitRepository(repositoryPath);

    assert.deepEqual(await discoverProjectSources([repositoryPath, plainDirectoryPath]), [
      {
        pathname: repositoryPath,
        filename: `${path.basename(directory)}/repo`,
        archived: false,
        canArchive: true,
        source: "projects",
      },
    ]);
  });

  test("prefixes repositories found under a literal containing folder", async () => {
    const directory = await makeTempDirectory();
    const ownerPath = path.join(directory, "clerk");
    const repositoryPath = path.join(ownerPath, "pr-review");
    await fs.mkdir(repositoryPath, { recursive: true });
    await makeGitRepository(repositoryPath);

    assert.deepEqual(await discoverProjectSources([ownerPath]), [
      {
        pathname: repositoryPath,
        filename: "clerk/pr-review",
        archived: false,
        canArchive: true,
        source: "projects",
      },
    ]);
  });

  test("expands glob patterns and filters out non-git directories", async () => {
    const directory = await makeTempDirectory();
    const firstRepositoryPath = path.join(directory, "first");
    const secondRepositoryPath = path.join(directory, "second");
    const plainDirectoryPath = path.join(directory, "plain");
    await fs.mkdir(firstRepositoryPath);
    await fs.mkdir(secondRepositoryPath);
    await fs.mkdir(plainDirectoryPath);
    await makeGitRepository(firstRepositoryPath);
    await makeGitRepository(secondRepositoryPath);

    assert.deepEqual(await discoverProjectSources([path.join(directory, "*")]), [
      {
        pathname: firstRepositoryPath,
        filename: `${path.basename(directory)}/first`,
        archived: false,
        canArchive: true,
        source: "projects",
      },
      {
        pathname: secondRepositoryPath,
        filename: `${path.basename(directory)}/second`,
        archived: false,
        canArchive: true,
        source: "projects",
      },
    ]);
  });

  test("prefixes glob-matched repository names with their parent directory", async () => {
    const directory = await makeTempDirectory();
    const repositoryPath = path.join(directory, "owner", "repo");
    await fs.mkdir(repositoryPath, { recursive: true });
    await makeGitRepository(repositoryPath);

    assert.deepEqual(await discoverProjectSources([path.join(directory, "*", "*")]), [
      {
        pathname: repositoryPath,
        filename: "owner/repo",
        archived: false,
        canArchive: true,
        source: "projects",
      },
    ]);
  });

  test("supports recursive glob patterns", async () => {
    const directory = await makeTempDirectory();
    const nestedRepositoryPath = path.join(directory, "owner", "repo");
    await fs.mkdir(nestedRepositoryPath, { recursive: true });
    await makeGitRepository(nestedRepositoryPath);

    assert.deepEqual(await discoverProjectSources([path.join(directory, "**")]), [
      {
        pathname: nestedRepositoryPath,
        filename: "owner/repo",
        archived: false,
        canArchive: true,
        source: "projects",
      },
    ]);
  });

  test("matches repositories with recursive child glob patterns", async () => {
    const directory = await makeTempDirectory();
    const repositoryPath = path.join(directory, "owner", "repo");
    await fs.mkdir(repositoryPath, { recursive: true });
    await makeGitRepository(repositoryPath);

    assert.deepEqual(await discoverProjectSources([path.join(directory, "**", "*")]), [
      {
        pathname: repositoryPath,
        filename: "owner/repo",
        archived: false,
        canArchive: true,
        source: "projects",
      },
    ]);
  });

  test("keeps matched archives so archived projects can be restored", async () => {
    const directory = await makeTempDirectory();
    const archivePath = path.join(directory, "repo.tar.bz2");
    await fs.writeFile(archivePath, "");

    assert.deepEqual(await discoverProjectSources([path.join(directory, "*")]), [
      {
        pathname: archivePath,
        filename: `${path.basename(directory)}/repo.tar.bz2`,
        archived: true,
        canArchive: true,
        source: "projects",
      },
    ]);
  });

  test("deduplicates sources matched by multiple patterns", async () => {
    const directory = await makeTempDirectory();
    const repositoryPath = path.join(directory, "repo");
    await fs.mkdir(repositoryPath);
    await makeGitRepository(repositoryPath);

    assert.deepEqual(await discoverProjectSources([repositoryPath, path.join(directory, "*")]), [
      {
        pathname: repositoryPath,
        filename: `${path.basename(directory)}/repo`,
        archived: false,
        canArchive: true,
        source: "projects",
      },
    ]);
  });

  test("prefixes duplicate repository names with their parent directory", async () => {
    const directory = await makeTempDirectory();
    const firstRepositoryPath = path.join(directory, "owner-a", "repo");
    const secondRepositoryPath = path.join(directory, "owner-b", "repo");
    await fs.mkdir(firstRepositoryPath, { recursive: true });
    await fs.mkdir(secondRepositoryPath, { recursive: true });
    await makeGitRepository(firstRepositoryPath);
    await makeGitRepository(secondRepositoryPath);

    assert.deepEqual(await discoverProjectSources([path.join(directory, "*", "*")]), [
      {
        pathname: firstRepositoryPath,
        filename: "owner-a/repo",
        archived: false,
        canArchive: true,
        source: "projects",
      },
      {
        pathname: secondRepositoryPath,
        filename: "owner-b/repo",
        archived: false,
        canArchive: true,
        source: "projects",
      },
    ]);
  });
});

describe("getProjectSourceDebugSnapshot", () => {
  test("reports candidate statuses and matched sources for each pattern", async () => {
    const directory = await makeTempDirectory();
    const repositoryPath = path.join(directory, "repo");
    const plainDirectoryPath = path.join(directory, "plain");
    await fs.mkdir(repositoryPath);
    await fs.mkdir(plainDirectoryPath);
    await makeGitRepository(repositoryPath);

    assert.deepEqual(await getProjectSourceDebugSnapshot([path.join(directory, "*")]), {
      patterns: [
        {
          pattern: path.join(directory, "*"),
          absolutePattern: path.join(directory, "*"),
          hasGlobPattern: true,
          candidates: [
            {
              pathname: plainDirectoryPath,
              shouldPrefixFilename: true,
              matched: false,
              status: "not-git-repository",
            },
            {
              pathname: repositoryPath,
              shouldPrefixFilename: true,
              matched: true,
              status: "git-repository",
            },
          ],
        },
      ],
      sources: [
        {
          pathname: repositoryPath,
          filename: `${path.basename(directory)}/repo`,
          archived: false,
          canArchive: true,
          source: "projects",
        },
      ],
    });
  });
});
