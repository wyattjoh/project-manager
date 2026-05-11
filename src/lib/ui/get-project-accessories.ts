import { Color, type List } from "@raycast/api";
import type { Project } from "../../types/project";
import { getRelativeTimeTag } from "./get-relative-time-tag";

export function getProjectAccessories(project: Project) {
  const accessories: List.Item.Accessory[] = [];

  if (project.lastModifiedTime) {
    accessories.push(getRelativeTimeTag(project.lastModifiedTime));
  }

  if (project.gitBranch) {
    accessories.unshift({ tag: { value: project.gitBranch, color: Color.Green } });
  }

  if (project.diskSize) {
    accessories.unshift({ tag: { value: project.diskSize, color: Color.Blue } });
  } else if (project.isDiskSizeLoading) {
    accessories.unshift({ tag: { value: "Calculating size...", color: Color.SecondaryText } });
  }

  return accessories;
}
