export type Project = {
  id: string;
  filename: string;
  pathname: string;
  lastModifiedTime: Date | null;
  gitBranch: string | null;
  gitDirty: boolean;
  gitUpstream: string | null;
  gitAhead: number;
  gitBehind: number;
  diskSize: string | null;
  isDiskSizeLoading: boolean;
  archived: boolean;
  canArchive: boolean;
  worktreeCount: number;
  source: "projects";
};
