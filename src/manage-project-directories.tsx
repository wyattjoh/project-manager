import {
  Action,
  ActionPanel,
  Alert,
  confirmAlert,
  Form,
  Icon,
  List,
  Keyboard,
  showToast,
  useNavigation,
} from "@raycast/api";
import { getPreferenceValues } from "@raycast/api";
import { showFailureToast, useCachedPromise } from "@raycast/utils";

import { resolveProjectPatterns, setStoredProjectDirectories } from "./lib/project-directories";

function DirectoryForm({
  initialValue,
  onSubmit,
}: {
  initialValue?: string;
  onSubmit: (value: string) => Promise<void>;
}) {
  const { pop } = useNavigation();

  return (
    <Form
      navigationTitle={initialValue ? "Edit Directory Pattern" : "Add Directory Pattern"}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Save"
            onSubmit={async ({ pattern }: { pattern: string }) => {
              if (!pattern.trim()) {
                return;
              }

              try {
                await onSubmit(pattern.trim());
                pop();
              } catch (err) {
                showFailureToast(err);
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField id="pattern" title="Pattern" placeholder="~/Code/github.com/*/*" defaultValue={initialValue} />
    </Form>
  );
}

export default function Command() {
  const { projectDirectories } = getPreferenceValues<Preferences.ManageProjectDirectories>();
  const { data: directories = [], isLoading, mutate } = useCachedPromise(resolveProjectPatterns, [projectDirectories]);

  const save = async (next: string[]) => {
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
          key={`${index}:${directory}`}
          title={directory}
          icon={Icon.Folder}
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
                    message: directory,
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
