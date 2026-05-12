export type Project = {
  id: string;
  filename: string;
  pathname: string;
  lastModifiedTime: Date | null;
  gitBranch: string | null;
  gitDirty: boolean;
  diskSize: string | null;
  isDiskSizeLoading: boolean;
  archived: boolean;
  canArchive: boolean;
  worktreeCount: number;
  source: "code" | "projects";
};
