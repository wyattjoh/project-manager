import { startTransition, useCallback, useEffect, useMemo, useState } from "react";
import { Color, getPreferenceValues, Keyboard } from "@raycast/api";
import { ActionPanel, Action, Icon, List, showToast, Toast } from "@raycast/api";
import { showFailureToast, useCachedPromise } from "@raycast/utils";

import { getProjectDiskSizeSources, getProjects } from "./lib/get-projects";
import { getProjectAccessories } from "./lib/ui/get-project-accessories";
import { archiveProject } from "./lib/archive-project";
import type { Project } from "./types/project";
import { unarchiveProject } from "./lib/unarchive-project";
import { getCachedProjectDiskSizes, streamProjectDiskSizes, type DiskSizeMap } from "./lib/get-project-disk-size";

type View = Preferences.SearchProjects["defaultView"];

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
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(undefined);
  const [view, setView] = useState<View>(defaultView);

  useEffect(() => {
    setDiskSizes(getCachedProjectDiskSizes());
  }, [codeDirectory, directory]);

  useEffect(() => {
    if (!data) {
      return;
    }

    setIsLoadingDiskSizes(true);
    const stopStreaming = streamProjectDiskSizes(getProjectDiskSizeSources(directory, codeDirectory), {
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
  }, [codeDirectory, data, directory, diskSizeRefreshKey]);

  const applyDiskSize = useCallback(
    (item: Project) => {
      const diskSize = diskSizes[item.pathname] ?? item.diskSize;

      return {
        ...item,
        diskSize,
        isDiskSizeLoading: !diskSize && isLoadingDiskSizes,
      };
    },
    [diskSizes, isLoadingDiskSizes],
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

        if (view === "archived") {
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

        if (view === "active") {
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

    if (view === "archived") {
      return data?.filter((item) => item.archived).map(applyDiskSize);
    }

    return data?.filter((item) => !item.archived).map(applyDiskSize);
  }, [applyDiskSize, data, view]);

  return (
    <List
      isLoading={isLoading}
      selectedItemId={selectedItemId}
      searchBarAccessory={
        <List.Dropdown tooltip="Dropdown With Items" value={view} onChange={(value) => setView(value as View)}>
          <List.Dropdown.Item title="All" value="all" />
          <List.Dropdown.Item title="Active" value="active" />
          <List.Dropdown.Item title="Archived" value="archived" />
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
                <Action title="Unarchive Project" onAction={onUnarchiveProject.bind(null, item)} icon={Icon.Folder} />
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
            source: item.archived ? "folder-archive.svg" : "folder.svg",
            tintColor: item.archived ? Color.SecondaryText : Color.PrimaryText,
          }}
        />
      ))}
    </List>
  );
}
