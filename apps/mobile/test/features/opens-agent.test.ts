import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FEATURES = join(import.meta.dir, "../../src/features");

test("an agent's picture opens its profile on the surfaces about it", () => {
  for (const file of [
    "chat/ChannelMembers.tsx",
    "chat/ChatScreen.tsx",
    "right-hand/Intro.tsx",
    "task-manager/TaskManagerScreen.tsx",
    "task-manager/AgentTasksScreen.tsx",
    "task-manager/TaskScreen.tsx",
    "queue/QueueSheet.tsx",
    "queue/UsageQueueSheet.tsx",
  ]) {
    expect({ file, opens: readFileSync(join(FEATURES, file), "utf8").includes("<OpensAgent") }).toEqual({
      file,
      opens: true,
    });
  }
});
