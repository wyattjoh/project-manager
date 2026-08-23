import path from "node:path";

import {
  Action,
  ActionPanel,
  environment,
  getPreferenceValues,
  Icon,
  Keyboard,
  List,
  openExtensionPreferences,
} from "@raycast/api";
import { showFailureToast, useCachedPromise } from "@raycast/utils";
import { useEffect } from "react";

import {
  getProjectSourceDebugSnapshot,
  parseProjectPatterns,
  type ProjectSourceDebugCandidate,
} from "./lib/project-sources";

const MAX_REJECTED_CANDIDATES = 200;

type DebugRowAccessory = {
  text: string;
};

type DebugItemProps = {
  title: string;
  subtitle: string | undefined;
  value: string;
  accessories: DebugRowAccessory[];
  snapshot: DebugConfiguration | undefined;
  onRefresh: () => void;
};

type DebugConfiguration = {
  generatedAt: string;
  preferences: Preferences.DebugConfiguration & { directory?: string };
  patterns: string[];
  runtime: Record<string, string>;
  snapshot: Awaited<ReturnType<typeof getProjectSourceDebugSnapshot>>;
};

async function loadDebugConfiguration(): Promise<DebugConfiguration> {
  const preferences = getPreferenceValues<Preferences.DebugConfiguration & { directory?: string }>();
  const patterns = parseProjectPatterns(preferences.projectDirectories);

  return {
    generatedAt: new Date().toISOString(),
    preferences,
    patterns,
    runtime: getRuntimeConfiguration(),
    snapshot: await getProjectSourceDebugSnapshot(patterns),
  };
}

function getRuntimeConfiguration(): Record<string, string> {
  return {
    "Raycast Version": environment.raycastVersion,
    "Extension Name": environment.extensionName,
    "Command Name": environment.commandName,
    "Command Mode": environment.commandMode,
    "Is Development": formatBoolean(environment.isDevelopment),
    "Launch Type": String(environment.launchType),
    "Assets Path": environment.assetsPath,
    "Support Path": environment.supportPath,
    "Detected Config Store": getConfigStoreName(),
    "Current Working Directory": process.cwd(),
    RAY_Target: process.env.RAY_Target ?? "(unset)",
    NODE_ENV: process.env.NODE_ENV ?? "(unset)",
    npm_lifecycle_event: process.env.npm_lifecycle_event ?? "(unset)",
  };
}

function getConfigStoreName() {
  if (environment.supportPath.includes("/raycast-x/") || environment.assetsPath.includes("/raycast-x/")) {
    return "Raycast Beta (raycast-x)";
  }

  if (environment.supportPath.includes("/raycast/") || environment.assetsPath.includes("/raycast/")) {
    return "Raycast Stable (raycast)";
  }

  return "Unknown";
}

function formatBoolean(value: boolean) {
  return value ? "true" : "false";
}

function formatApplication(preferences: DebugConfiguration["preferences"]) {
  const application = preferences.openWith;

  if (!application) {
    return "(unset)";
  }

  return [application.name, application.bundleId, application.path].filter(Boolean).join(" | ");
}

function getPreferenceRows(configuration: DebugConfiguration) {
  const { preferences } = configuration;

  return [
    {
      title: "Projects Directories",
      subtitle: preferences.projectDirectories,
      value: preferences.projectDirectories,
    },
    {
      title: "Legacy Directory",
      subtitle: preferences.directory ?? "(unset)",
      value: preferences.directory ?? "",
    },
    {
      title: "Parsed Pattern Count",
      subtitle: String(configuration.patterns.length),
      value: JSON.stringify(configuration.patterns, null, 2),
    },
    {
      title: "Open With",
      subtitle: formatApplication(preferences),
      value: JSON.stringify(preferences.openWith ?? null, null, 2),
    },
    {
      title: "Exclude Patterns",
      subtitle: preferences.excludePatterns,
      value: preferences.excludePatterns,
    },
    {
      title: "Default View",
      subtitle: preferences.defaultView,
      value: preferences.defaultView,
    },
  ];
}

function getRejectedCandidates(configuration: DebugConfiguration) {
  return configuration.snapshot.patterns.flatMap((pattern) =>
    pattern.candidates
      .filter((candidate) => !candidate.matched)
      .map((candidate) => ({
        pattern: pattern.pattern,
        candidate,
      })),
  );
}

function DebugItem({ title, subtitle, value, accessories, snapshot, onRefresh }: DebugItemProps) {
  return (
    <List.Item
      title={title}
      subtitle={subtitle}
      accessories={accessories}
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            <Action.CopyToClipboard
              title="Copy Value"
              content={value}
              icon={Icon.Clipboard}
              shortcut={{ modifiers: ["cmd"], key: "c" }}
            />
            {snapshot ? (
              <Action.CopyToClipboard
                title="Copy Debug Snapshot as Json"
                content={JSON.stringify(snapshot, null, 2)}
                icon={Icon.Code}
              />
            ) : null}
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action
              title="Refresh Debug Info"
              onAction={onRefresh}
              icon={Icon.ArrowClockwise}
              shortcut={Keyboard.Shortcut.Common.Refresh}
            />
            <Action title="Open Extension Preferences" onAction={openExtensionPreferences} icon={Icon.Gear} />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

function getCandidateTitle(candidate: ProjectSourceDebugCandidate) {
  return path.basename(candidate.pathname) || candidate.pathname;
}

export default function Command() {
  const { data, error, isLoading, revalidate } = useCachedPromise(loadDebugConfiguration, [], {
    keepPreviousData: true,
  });

  useEffect(() => {
    if (error) {
      showFailureToast(error);
    }
  }, [error]);

  const rejectedCandidates = data ? getRejectedCandidates(data) : [];
  const visibleRejectedCandidates = rejectedCandidates.slice(0, MAX_REJECTED_CANDIDATES);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search debug information">
      {data ? (
        <>
          <List.Section title="Preferences">
            <DebugItem
              title="Generated At"
              subtitle={data.generatedAt}
              value={data.generatedAt}
              accessories={[]}
              snapshot={data}
              onRefresh={revalidate}
            />
            {getPreferenceRows(data).map((row) => (
              <DebugItem
                key={row.title}
                title={row.title}
                subtitle={row.subtitle}
                value={row.value}
                accessories={[]}
                snapshot={data}
                onRefresh={revalidate}
              />
            ))}
          </List.Section>

          <List.Section title="Runtime">
            {Object.entries(data.runtime).map(([title, value]) => (
              <DebugItem
                key={title}
                title={title}
                subtitle={value}
                value={value}
                accessories={[]}
                snapshot={data}
                onRefresh={revalidate}
              />
            ))}
          </List.Section>

          <List.Section title="Patterns">
            {data.snapshot.patterns.map((pattern) => {
              const matchedCount = pattern.candidates.filter((candidate) => candidate.matched).length;

              return (
                <DebugItem
                  key={pattern.pattern}
                  title={pattern.pattern}
                  subtitle={pattern.absolutePattern}
                  value={JSON.stringify(pattern, null, 2)}
                  accessories={[
                    { text: pattern.hasGlobPattern ? "glob" : "literal" },
                    { text: `${matchedCount} matched` },
                    { text: `${pattern.candidates.length - matchedCount} rejected` },
                  ]}
                  snapshot={data}
                  onRefresh={revalidate}
                />
              );
            })}
          </List.Section>

          <List.Section title="Discovered Sources">
            {data.snapshot.sources.map((source) => (
              <DebugItem
                key={source.pathname}
                title={source.filename}
                subtitle={source.pathname}
                value={JSON.stringify(source, null, 2)}
                accessories={[{ text: source.archived ? "archive" : "git" }, { text: source.source }]}
                snapshot={data}
                onRefresh={revalidate}
              />
            ))}
          </List.Section>

          <List.Section title="Rejected Candidates">
            {visibleRejectedCandidates.map(({ pattern, candidate }) => (
              <DebugItem
                key={`${pattern}:${candidate.pathname}`}
                title={getCandidateTitle(candidate)}
                subtitle={candidate.pathname}
                value={JSON.stringify({ pattern, candidate }, null, 2)}
                accessories={[{ text: candidate.status }, { text: pattern }]}
                snapshot={data}
                onRefresh={revalidate}
              />
            ))}
            {rejectedCandidates.length > visibleRejectedCandidates.length ? (
              <DebugItem
                title="Rejected Candidates Truncated"
                subtitle={`${visibleRejectedCandidates.length} of ${rejectedCandidates.length} shown`}
                value={JSON.stringify(rejectedCandidates, null, 2)}
                accessories={[]}
                snapshot={data}
                onRefresh={revalidate}
              />
            ) : null}
          </List.Section>
        </>
      ) : null}
    </List>
  );
}
