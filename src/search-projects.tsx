import { startTransition, useCallback, useEffect, useMemo, useState } from "react";
import { Color, getPreferenceValues, Keyboard } from "@raycast/api";
import { ActionPanel, Action, Icon, List, showToast, Toast } from "@raycast/api";
import { showFailureToast, useCachedPromise } from "@raycast/utils";

import { getProjects } from "./lib/get-projects";
import { getProjectAccessories } from "./lib/ui/get-project-accessories";
import { archiveProject } from "./lib/archive-project";
import type { Project } from "./types/project";
import { unarchiveProject } from "./lib/unarchive-project";
import {
  getCachedProjectDiskSizes,
  refreshProjectDiskSize,
  streamProjectDiskSizes,
  type DiskSizeMap,
  type DiskSizeProject,
} from "./lib/get-project-disk-size";
import { getProjectGitDetails } from "./lib/get-project-git-details";

type View = "all" | "code" | "projects" | "active-projects" | "archived-projects";

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

export default function Command() {
  const { directory, codeDirectory, openWith, excludePatterns, defaultView } =
    getPreferenceValues<Preferences.SearchProjects>();
  const { data, isLoading, revalidate } = useCachedPromise(
    getProjects,
    [directory, codeDirectory, excludePatterns.split(",")],
    {
      keepPreviousData: true,
    },
  );
  const [diskSizes, setDiskSizes] = useState<DiskSizeMap>(() => getCachedProjectDiskSizes());
  const [isLoadingDiskSizes, setIsLoadingDiskSizes] = useState(false);
  const [diskSizeRefreshKey, setDiskSizeRefreshKey] = useState(0);
  const [projectOverrides, setProjectOverrides] = useState<Record<string, Partial<Project>>>({});
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(undefined);
  const [view, setView] = useState<View>(() => getInitialView(defaultView));
  const projectDataSignature = useMemo(() => getProjectDataSignature(data), [data]);
  const diskSizeProjects = useMemo(() => getDiskSizeProjects(data), [projectDataSignature]);

  useEffect(() => {
    setDiskSizes(getCachedProjectDiskSizes());
    setProjectOverrides({});
  }, [codeDirectory, directory]);

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
          lastModifiedTime,
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

  const onRefreshAll = useCallback(() => {
    revalidate();
    setProjectOverrides({});
    setDiskSizeRefreshKey((key) => key + 1);
  }, [revalidate]);

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

        const archivePath = await archiveProject(project.pathname, excludePatterns.split(","));

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
    [revalidate, excludePatterns, view],
  );

  const filtered = useMemo(() => {
    if (!data) {
      return data;
    }

    if (view === "all") {
      return data.map(applyDiskSize);
    }

    if (view === "code") {
      return data?.filter((item) => item.source === "code").map(applyDiskSize);
    }

    if (view === "projects") {
      return data?.filter((item) => item.source === "projects").map(applyDiskSize);
    }

    if (view === "active-projects") {
      return data?.filter((item) => item.source === "projects" && !item.archived).map(applyDiskSize);
    }

    return data?.filter((item) => item.source === "projects" && item.archived).map(applyDiskSize);
  }, [applyDiskSize, data, view]);

  return (
    <List
      isLoading={isLoading || isLoadingDiskSizes}
      selectedItemId={selectedItemId}
      searchBarAccessory={
        <List.Dropdown tooltip="Dropdown With Items" value={view} onChange={(value) => setView(value as View)}>
          <List.Dropdown.Item title="All" value="all" />
          <List.Dropdown.Item title="Code Only" value="code" />
          <List.Dropdown.Item title="Projects Only" value="projects" />
          <List.Dropdown.Item title="Active Projects Only" value="active-projects" />
          <List.Dropdown.Item title="Archived Projects Only" value="archived-projects" />
        </List.Dropdown>
      }
    >
      {filtered?.map((item) => (
        <List.Item
          key={item.id}
          title={item.filename}
          subtitle={item.archived ? "Archived" : undefined}
          accessories={getProjectAccessories(item)}
          actions={
            <ActionPanel>
              {item.archived && item.canArchive ? (
                <>
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
                  <Action title="Unarchive Project" onAction={onUnarchiveProject.bind(null, item)} icon={Icon.Folder} />
                </>
              ) : (
                <>
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
                    shortcut={Keyboard.Shortcut.Common.Copy}
                  />
                  <Action title="Refresh One" onAction={onRefreshProject.bind(null, item)} icon={Icon.ArrowClockwise} />
                  <Action
                    title="Refresh All"
                    onAction={onRefreshAll}
                    icon={Icon.ArrowClockwise}
                    shortcut={Keyboard.Shortcut.Common.Refresh}
                  />
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
          icon={{
            source: item.source === "code" ? Icon.Code : item.archived ? "folder-archive.svg" : "folder.svg",
            tintColor: item.source === "code" ? Color.Blue : item.archived ? Color.SecondaryText : Color.PrimaryText,
          }}
        />
      ))}
    </List>
  );
}
