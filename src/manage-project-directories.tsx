import {
  Action,
  ActionPanel,
  Alert,
  confirmAlert,
  Form,
  getPreferenceValues,
  Icon,
  List,
  Keyboard,
  showToast,
  useNavigation,
} from "@raycast/api";
import { showFailureToast, useCachedPromise } from "@raycast/utils";

import { PROJECT_NAME_STYLES, resolveProjectPatterns, setStoredProjectDirectories } from "./lib/project-directories";
import type { ProjectNameStyle, ProjectPattern } from "./lib/project-sources";

function DirectoryForm({
  initialValue,
  onSubmit,
}: {
  initialValue?: ProjectPattern;
  onSubmit: (value: ProjectPattern) => Promise<void>;
}) {
  const { pop } = useNavigation();

  return (
    <Form
      navigationTitle={initialValue ? "Edit Directory Pattern" : "Add Directory Pattern"}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Save"
            onSubmit={async ({ pattern, nameStyle }: { pattern: string; nameStyle: ProjectNameStyle }) => {
              if (!pattern.trim()) {
                return;
              }

              try {
                await onSubmit({ pattern: pattern.trim(), nameStyle });
                pop();
              } catch (err) {
                showFailureToast(err);
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="pattern"
        title="Pattern"
        placeholder="~/Code/github.com/*/*"
        defaultValue={initialValue?.pattern}
      />
      <Form.Dropdown id="nameStyle" title="Project Name" defaultValue={initialValue?.nameStyle ?? "auto"}>
        {PROJECT_NAME_STYLES.map((style) => (
          <Form.Dropdown.Item key={style.value} value={style.value} title={style.title} />
        ))}
      </Form.Dropdown>
    </Form>
  );
}

function getNameStyleTitle(nameStyle: ProjectNameStyle) {
  return PROJECT_NAME_STYLES.find((style) => style.value === nameStyle)?.title ?? nameStyle;
}

export default function Command() {
  const { projectDirectories } = getPreferenceValues<Preferences.ManageProjectDirectories>();
  const { data: directories = [], isLoading, mutate } = useCachedPromise(resolveProjectPatterns, [projectDirectories]);

  const save = async (next: ProjectPattern[]) => {
    await mutate(setStoredProjectDirectories(next), { optimisticUpdate: () => next });
    showToast({ title: "Project directories saved" });
  };

  const addAction = (
    <Action.Push
      title="Add Directory Pattern"
      icon={Icon.Plus}
      shortcut={Keyboard.Shortcut.Common.New}
      target={<DirectoryForm onSubmit={(value) => save([...directories, value])} />}
    />
  );

  return (
    <List isLoading={isLoading} actions={<ActionPanel>{addAction}</ActionPanel>}>
      <List.EmptyView title="No project directories" description="Add a glob pattern such as ~/Code/github.com/*/*" />
      {directories.map((directory, index) => (
        <List.Item
          key={`${index}:${directory.pattern}`}
          title={directory.pattern}
          icon={Icon.Folder}
          accessories={[{ tag: getNameStyleTitle(directory.nameStyle) }]}
          actions={
            <ActionPanel>
              <Action.Push
                title="Edit Directory Pattern"
                icon={Icon.Pencil}
                target={
                  <DirectoryForm
                    initialValue={directory}
                    onSubmit={(value) => save(directories.map((item, i) => (i === index ? value : item)))}
                  />
                }
              />
              {addAction}
              <Action
                title="Remove Directory Pattern"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                shortcut={Keyboard.Shortcut.Common.Remove}
                onAction={async () => {
                  const confirmed = await confirmAlert({
                    title: "Remove Directory Pattern?",
                    message: directory.pattern,
                    primaryAction: { title: "Remove", style: Alert.ActionStyle.Destructive },
                  });
                  if (!confirmed) {
                    return;
                  }

                  try {
                    await save(directories.filter((_, i) => i !== index));
                  } catch (err) {
                    showFailureToast(err);
                  }
                }}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
