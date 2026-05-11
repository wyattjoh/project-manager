export type Project = {
  id: string;
  filename: string;
  pathname: string;
  lastModifiedTime: Date | null;
  gitBranch: string | null;
  diskSize: string | null;
  isDiskSizeLoading: boolean;
  archived: boolean;
  canArchive: boolean;
  source: "code" | "projects";
};
