import { startTransition, useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Color, confirmAlert, getPreferenceValues, Keyboard, openExtensionPreferences } from "@raycast/api";
import { ActionPanel, Action, Icon, List, showToast, Toast } from "@raycast/api";
import { showFailureToast, useCachedPromise } from "@raycast/utils";

import { getProjects } from "./lib/get-projects";
import { getProjectAccessories } from "./lib/ui/get-project-accessories";
import { archiveProject } from "./lib/archive-project";
import type { Project } from "./types/project";
import { unarchiveProject } from "./lib/unarchive-project";
import {
  getCachedProjectDiskSizes,
  invalidateProjectDiskSizes,
  refreshProjectDiskSize,
  streamProjectDiskSizes,
  type DiskSizeMap,
  type DiskSizeProject,
} from "./lib/get-project-disk-size";
import { getProjectGitDetails } from "./lib/get-project-git-details";
import { getProjectWorktrees, removeProjectWorktree } from "./lib/get-project-worktrees";
import { pullProjectFastForward } from "./lib/pull-project";
import { sortProjects, type SortMode } from "./lib/project-sort";

type View = "all" | "active-projects" | "archived-projects";

function getProjectDataSignature(data: Project[] | undefined) {
  if (!data) {
    return null;
  }

  return data.map((project) => `${project.pathname}:${getProjectLastCommitTime(project) ?? "none"}`).join("\n");
}

function getProjectLastCommitTime(project: Project) {
  if (!project.lastModifiedTime) {
    return null;
  }

  const time = new Date(project.lastModifiedTime).getTime();
  return Number.isNaN(time) ? null : time;
}

function getDiskSizeProjects(data: Project[] | undefined): DiskSizeProject[] {
  return (
    data?.map((project) => ({
      pathname: project.pathname,
      lastCommitTime: getProjectLastCommitTime(project),
    })) ?? []
  );
}

function getInitialView(defaultView: Preferences.SearchProjects["defaultView"]): View {
  if (defaultView === "active") {
    return "active-projects";
  }

  if (defaultView === "archived") {
    return "archived-projects";
  }

  return "all";
}

function getSearchProjectPreferences() {
  return getPreferenceValues<Preferences.SearchProjects>();
}

function getProjectIcon(project: Project) {
  return {
    source: project.archived ? "folder-archive.svg" : "folder.svg",
    tintColor: project.archived ? Color.SecondaryText : Color.PrimaryText,
  };
}

function isSamePath(left: string, right: string) {
  return left.replace(/\/+$/, "") === right.replace(/\/+$/, "");
}

function canFastForward(project: Project) {
  return Boolean(project.gitUpstream) && !project.gitDirty && project.gitBehind > 0 && project.gitAhead === 0;
}

function SortActions({
  sortMode,
  onSortModeChange,
}: {
  sortMode: SortMode;
  onSortModeChange: (sortMode: SortMode) => void;
}) {
  return (
    <ActionPanel.Section title="Sort">
      <Action
        title="Sort by Most Recent"
        onAction={onSortModeChange.bind(null, "recent")}
        icon={sortMode === "recent" ? Icon.CheckCircle : Icon.Clock}
      />
      <Action
        title="Sort by Largest"
        onAction={onSortModeChange.bind(null, "largest")}
        icon={sortMode === "largest" ? Icon.CheckCircle : Icon.HardDrive}
      />
      <Action
        title="Sort by Name"
        onAction={onSortModeChange.bind(null, "name")}
        icon={sortMode === "name" ? Icon.CheckCircle : Icon.Text}
      />
    </ActionPanel.Section>
  );
}

function WorktreesList({
  project,
  openWith,
  onWorktreeDeleted,
}: {
  project: Project;
  openWith: Preferences.SearchProjects["openWith"];
  onWorktreeDeleted: (pathnames: string[]) => void;
}) {
  const { data, isLoading, revalidate } = useCachedPromise(getProjectWorktrees, [project], {
    keepPreviousData: true,
  });
  const [diskSizes, setDiskSizes] = useState<DiskSizeMap>(() => getCachedProjectDiskSizes());
  const [isLoadingDiskSizes, setIsLoadingDiskSizes] = useState(false);
  const projectDataSignature = useMemo(() => getProjectDataSignature(data), [data]);
  const diskSizeProjects = useMemo(() => getDiskSizeProjects(data), [projectDataSignature]);

  useEffect(() => {
    if (!projectDataSignature) {
      return;
    }

    setIsLoadingDiskSizes(true);
    const stopStreaming = streamProjectDiskSizes([{ projects: diskSizeProjects }], {
      onSize: (pathname, size) => {
        setDiskSizes((current) => {
          if (current[pathname] === size) {
            return current;
          }

          return {
            ...current,
            [pathname]: size,
          };
        });
      },
      onComplete: (sizes) => {
        setDiskSizes(sizes);
        setIsLoadingDiskSizes(false);
      },
    });

    return () => {
      setIsLoadingDiskSizes(false);
      stopStreaming();
    };
  }, [diskSizeProjects, projectDataSignature]);

  const worktrees = useMemo(
    () =>
      data?.map((item) => {
        const diskSize = diskSizes[item.pathname] ?? item.diskSize;

        return {
          ...item,
          diskSize,
          isDiskSizeLoading: !diskSize && isLoadingDiskSizes,
        };
      }),
    [data, diskSizes, isLoadingDiskSizes],
  );

  const onPullWorktree = useCallback(
    async (worktree: Project) => {
      try {
        showToast({ style: Toast.Style.Animated, title: "Pulling latest changes..." });
        await pullProjectFastForward(worktree.pathname);
        showToast({ title: "Pulled latest changes", message: worktree.filename });
        revalidate();
      } catch (err) {
        showFailureToast(err);
      }
    },
    [revalidate],
  );

  const onDeleteWorktree = useCallback(
    async (worktree: Project) => {
      if (worktree.gitDirty) {
        const confirmed = await confirmAlert({
          title: "Delete Worktree?",
          message: `This will remove ${worktree.pathname}. Any uncommitted changes or untracked files in that worktree will be deleted.`,
          primaryAction: {
            title: "Delete Worktree",
            style: Alert.ActionStyle.Destructive,
          },
        });

        if (!confirmed) {
          return;
        }
      }

      try {
        showToast({
          style: Toast.Style.Animated,
          title: "Deleting worktree...",
        });

        await removeProjectWorktree(project, worktree);
        invalidateProjectDiskSizes([project.pathname, worktree.pathname]);
        onWorktreeDeleted([project.pathname, worktree.pathname]);
        setDiskSizes((current) => {
          const next = { ...current };
          delete next[project.pathname];
          delete next[worktree.pathname];
          return next;
        });
        revalidate();

        showToast({
          title: "Worktree deleted",
          message: worktree.filename,
        });
      } catch (err) {
        showFailureToast(err);
      }
    },
    [onWorktreeDeleted, project, revalidate],
  );

  return (
    <List isLoading={isLoading || isLoadingDiskSizes} navigationTitle={`${project.filename} Worktrees`}>
      {worktrees?.map((item) => (
        <List.Item
          key={item.id}
          title={item.filename}
          accessories={getProjectAccessories(item, { showWorktreeCount: false })}
          actions={
            <ActionPanel>
              <Action.Open
                title="Open Worktree"
                target={item.pathname}
                application={openWith}
                icon={Icon.Folder}
                shortcut={Keyboard.Shortcut.Common.Open}
              />
              <Action.OpenWith title="Open With" path={item.pathname} shortcut={Keyboard.Shortcut.Common.OpenWith} />
              <Action.CopyToClipboard
                title="Copy Absolute Path"
                content={item.pathname}
                shortcut={{ modifiers: ["cmd"], key: "c" }}
              />
              {canFastForward(item) ? (
                <Action
                  title="Pull Latest"
                  onAction={onPullWorktree.bind(null, item)}
                  icon={Icon.Download}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
                />
              ) : null}
              {!isSamePath(item.pathname, project.pathname) ? (
                <Action
                  title="Delete Worktree"
                  onAction={onDeleteWorktree.bind(null, item)}
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                />
              ) : null}
            </ActionPanel>
          }
          icon={getProjectIcon(item)}
        />
      ))}
    </List>
  );
}

export default function Command() {
  const [preferences, setPreferences] = useState(() => getSearchProjectPreferences());
  const { projectDirectories, openWith, excludePatterns, defaultView } = preferences;
  const excludeList = useMemo(() => excludePatterns.split(","), [excludePatterns]);
  const { data, isLoading, revalidate } = useCachedPromise(getProjects, [projectDirectories, excludeList], {
    keepPreviousData: true,
  });
  const [diskSizes, setDiskSizes] = useState<DiskSizeMap>(() => getCachedProjectDiskSizes());
  const [isLoadingDiskSizes, setIsLoadingDiskSizes] = useState(false);
  const [diskSizeRefreshKey, setDiskSizeRefreshKey] = useState(0);
  const [projectOverrides, setProjectOverrides] = useState<Record<string, Partial<Project>>>({});
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(undefined);
  const [view, setView] = useState<View>(() => getInitialView(defaultView));
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const projectDataSignature = useMemo(() => getProjectDataSignature(data), [data]);
  const diskSizeProjects = useMemo(() => getDiskSizeProjects(data), [projectDataSignature]);

  useEffect(() => {
    setDiskSizes(getCachedProjectDiskSizes());
    setProjectOverrides({});
  }, [projectDirectories]);

  useEffect(() => {
    if (!projectDataSignature) {
      return;
    }

    setIsLoadingDiskSizes(true);
    const stopStreaming = streamProjectDiskSizes([{ projects: diskSizeProjects }], {
      onSize: (pathname, size) => {
        setDiskSizes((current) => {
          if (current[pathname] === size) {
            return current;
          }

          return {
            ...current,
            [pathname]: size,
          };
        });
      },
      onComplete: (sizes) => {
        setDiskSizes(sizes);
        setIsLoadingDiskSizes(false);
      },
    });

    return () => {
      setIsLoadingDiskSizes(false);
      stopStreaming();
    };
  }, [diskSizeProjects, diskSizeRefreshKey, projectDataSignature]);

  const applyDiskSize = useCallback(
    (item: Project) => {
      const overriddenItem = {
        ...item,
        ...projectOverrides[item.pathname],
      };
      const diskSize = diskSizes[overriddenItem.pathname] ?? overriddenItem.diskSize;

      return {
        ...overriddenItem,
        diskSize,
        isDiskSizeLoading: !diskSize && isLoadingDiskSizes,
      };
    },
    [diskSizes, isLoadingDiskSizes, projectOverrides],
  );

  const onRefreshProject = useCallback(async (project: Project) => {
    try {
      showToast({
        style: Toast.Style.Animated,
        title: "Refreshing project...",
      });

      const gitDetails = await getProjectGitDetails(project.pathname);
      const lastModifiedTime = gitDetails.lastCommitTime ? new Date(gitDetails.lastCommitTime) : null;
      const diskSize = await refreshProjectDiskSize({
        pathname: project.pathname,
        lastCommitTime: gitDetails.lastCommitTime,
      });

      if (diskSize) {
        setDiskSizes((current) => ({
          ...current,
          [project.pathname]: diskSize,
        }));
      }

      setProjectOverrides((current) => ({
        ...current,
        [project.pathname]: {
          gitBranch: gitDetails.branch,
          gitDirty: gitDetails.dirty,
          gitUpstream: gitDetails.upstream,
          gitAhead: gitDetails.ahead,
          gitBehind: gitDetails.behind,
          lastModifiedTime,
          worktreeCount: gitDetails.worktreeCount,
          diskSize: diskSize ?? project.diskSize,
          isDiskSizeLoading: false,
        },
      }));

      showToast({
        title: "Project refreshed",
        message: project.filename,
      });
    } catch (err) {
      showFailureToast(err);
    }
  }, []);

  const onPullProject = useCallback(
    async (project: Project) => {
      try {
        showToast({ style: Toast.Style.Animated, title: "Pulling latest changes..." });
        await pullProjectFastForward(project.pathname);
        showToast({ title: "Pulled latest changes", message: project.filename });
        await onRefreshProject(project);
      } catch (err) {
        showFailureToast(err);
      }
    },
    [onRefreshProject],
  );

  const reloadPreferences = useCallback(() => {
    const nextPreferences = getSearchProjectPreferences();
    const shouldRevalidate =
      nextPreferences.projectDirectories === projectDirectories && nextPreferences.excludePatterns === excludePatterns;

    setPreferences(nextPreferences);
    setDiskSizes(getCachedProjectDiskSizes());
    setProjectOverrides({});
    setDiskSizeRefreshKey((key) => key + 1);

    return shouldRevalidate;
  }, [projectDirectories, excludePatterns]);

  const onReloadPreferences = useCallback(() => {
    if (reloadPreferences()) {
      revalidate();
    }

    showToast({ title: "Preferences reloaded" });
  }, [reloadPreferences, revalidate]);

  const onRefreshAll = useCallback(() => {
    if (reloadPreferences()) {
      revalidate();
    }
  }, [reloadPreferences, revalidate]);

  const onWorktreeDeleted = useCallback(
    (pathnames: string[]) => {
      setDiskSizes((current) => {
        const next = { ...current };

        for (const pathname of pathnames) {
          delete next[pathname];
        }

        return next;
      });
      setProjectOverrides((current) => {
        const next = { ...current };

        for (const pathname of pathnames) {
          delete next[pathname];
        }

        return next;
      });
      revalidate();
      setDiskSizeRefreshKey((key) => key + 1);
    },
    [revalidate],
  );

  const onUnarchiveProject = useCallback(
    async (project: Project) => {
      try {
        showToast({
          style: Toast.Style.Animated,
          title: "Unarchiving project...",
        });

        await unarchiveProject(project.pathname);

        revalidate();
        setDiskSizeRefreshKey((key) => key + 1);

        if (view === "archived-projects") {
          startTransition(() => {
            setView("all");
            setSelectedItemId(project.id);
          });
        }

        showToast({
          title: "Project unarchived",
          message: `Project ${project.filename} has been unarchived`,
        });
      } catch (err) {
        showFailureToast(err);
      }
    },
    [revalidate, view],
  );

  const onArchiveProject = useCallback(
    async (project: Project) => {
      try {
        showToast({
          style: Toast.Style.Animated,
          title: "Archiving project...",
        });

        const archivePath = await archiveProject(project.pathname, excludeList);

        revalidate();
        setDiskSizeRefreshKey((key) => key + 1);

        if (view === "active-projects") {
          startTransition(() => {
            setView("all");
            setSelectedItemId(project.id);
          });
        }

        showToast({
          title: "Project archived",
          message: `Project ${project.filename} has been archived to ${archivePath}`,
        });
      } catch (err) {
        showFailureToast(err);
      }
    },
    [revalidate, excludeList, view],
  );

  const filtered = useMemo(() => {
    if (!data) {
      return data;
    }

    let projects: Project[];

    if (view === "all") {
      projects = data.map(applyDiskSize);
    } else if (view === "active-projects") {
      projects = data.filter((item) => !item.archived).map(applyDiskSize);
    } else {
      projects = data.filter((item) => item.archived).map(applyDiskSize);
    }

    return sortProjects(projects, sortMode);
  }, [applyDiskSize, data, sortMode, view]);

  return (
    <List
      isLoading={isLoading || isLoadingDiskSizes}
      navigationTitle={`Projects, Sorted by ${sortMode === "recent" ? "Most Recent" : sortMode === "largest" ? "Largest" : "Name"}`}
      selectedItemId={selectedItemId}
      searchBarAccessory={
        <List.Dropdown tooltip="Dropdown With Items" value={view} onChange={(value) => setView(value as View)}>
          <List.Dropdown.Item title="All" value="all" />
          <List.Dropdown.Item title="Active Projects Only" value="active-projects" />
          <List.Dropdown.Item title="Archived Projects Only" value="archived-projects" />
        </List.Dropdown>
      }
    >
      {filtered?.map((item) => (
        <List.Item
          key={item.id}
          title={item.filename}
          accessories={getProjectAccessories(item)}
          actions={
            <ActionPanel>
              {item.archived && item.canArchive ? (
                <>
                  {item.worktreeCount > 1 ? (
                    <Action.Push
                      title="Show Worktrees"
                      target={
                        <WorktreesList project={item} openWith={openWith} onWorktreeDeleted={onWorktreeDeleted} />
                      }
                      icon={Icon.Tree}
                    />
                  ) : null}
                  <Action title="Unarchive Project" onAction={onUnarchiveProject.bind(null, item)} icon={Icon.Folder} />
                  <Action
                    title="Refresh Project"
                    onAction={onRefreshProject.bind(null, item)}
                    icon={Icon.ArrowClockwise}
                  />
                  <Action
                    title="Refresh All Projects"
                    onAction={onRefreshAll}
                    icon={Icon.ArrowClockwise}
                    shortcut={Keyboard.Shortcut.Common.Refresh}
                  />
                  <SortActions sortMode={sortMode} onSortModeChange={setSortMode} />
                  <Action title="Reload Preferences" onAction={onReloadPreferences} icon={Icon.Gear} />
                  <Action title="Open Extension Preferences" onAction={openExtensionPreferences} icon={Icon.Gear} />
                </>
              ) : (
                <>
                  {item.worktreeCount > 1 ? (
                    <Action.Push
                      title="Show Worktrees"
                      target={
                        <WorktreesList project={item} openWith={openWith} onWorktreeDeleted={onWorktreeDeleted} />
                      }
                      icon={Icon.Tree}
                    />
                  ) : null}
                  <Action.Open
                    title="Open Project"
                    target={item.pathname}
                    application={openWith}
                    icon={Icon.Folder}
                    shortcut={Keyboard.Shortcut.Common.Open}
                  />
                  <Action.OpenWith
                    title="Open With"
                    path={item.pathname}
                    shortcut={Keyboard.Shortcut.Common.OpenWith}
                  />
                  <Action.CopyToClipboard
                    title="Copy Absolute Path"
                    content={item.pathname}
                    shortcut={{ modifiers: ["cmd"], key: "c" }}
                  />
                  {canFastForward(item) ? (
                    <Action
                      title="Pull Latest"
                      onAction={onPullProject.bind(null, item)}
                      icon={Icon.Download}
                      shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
                    />
                  ) : null}
                  <Action
                    title="Refresh Project"
                    onAction={onRefreshProject.bind(null, item)}
                    icon={Icon.ArrowClockwise}
                  />
                  <Action
                    title="Refresh All Projects"
                    onAction={onRefreshAll}
                    icon={Icon.ArrowClockwise}
                    shortcut={Keyboard.Shortcut.Common.Refresh}
                  />
                  <SortActions sortMode={sortMode} onSortModeChange={setSortMode} />
                  <Action title="Reload Preferences" onAction={onReloadPreferences} icon={Icon.Gear} />
                  <Action title="Open Extension Preferences" onAction={openExtensionPreferences} icon={Icon.Gear} />

                  {item.canArchive ? (
                    <Action
                      title="Archive Project"
                      onAction={onArchiveProject.bind(null, item)}
                      icon={Icon.Folder}
                      shortcut={Keyboard.Shortcut.Common.Remove}
                    />
                  ) : null}
                </>
              )}
            </ActionPanel>
          }
          icon={getProjectIcon(item)}
        />
      ))}
    </List>
  );
}
