import { Color, Icon, type List } from "@raycast/api";
import type { Project } from "../../types/project";
import { getRelativeTimeTag } from "./get-relative-time-tag";

type Options = {
  showWorktreeCount?: boolean;
};

export function getProjectAccessories(project: Project, options: Options = {}) {
  const { showWorktreeCount = true } = options;
  const accessories: List.Item.Accessory[] = [];

  if (project.lastModifiedTime) {
    accessories.push(getRelativeTimeTag(project.lastModifiedTime));
  }

  if (project.gitBranch) {
    accessories.unshift({
      tag: {
        value: project.gitDirty ? `${project.gitBranch}*` : project.gitBranch,
        color: project.gitDirty ? Color.Yellow : Color.Green,
      },
      tooltip: project.gitDirty ? "Repository has uncommitted changes" : undefined,
    });
  }

  if (showWorktreeCount && project.worktreeCount > 1) {
    accessories.unshift({
      text: String(project.worktreeCount),
      icon: { source: Icon.Tree, tintColor: Color.Purple },
      tooltip: `${project.worktreeCount} worktrees`,
    });
  }

  if (project.diskSize) {
    accessories.unshift({ tag: { value: project.diskSize, color: Color.Blue } });
  } else if (project.isDiskSizeLoading) {
    accessories.unshift({ tag: { value: "Calculating size...", color: Color.SecondaryText } });
  }

  return accessories;
}
