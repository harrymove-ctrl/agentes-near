import { serverText } from "@agenteschat/i18n";
import type { AppLocale } from "@agenteschat/i18n/locale";

/** `3 min`, `1 h 05 min`, `40 s`. */
export function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** A task's end as its line needs it: the same fields as the end notice's `meta.machineTask`. */
export interface TaskEnd {
  title: string;
  status: string;
  seconds: number;
  exitCode: number | null;
  /** Commands a mission's rules blocked along the way. */
  blocked?: { command: string }[];
}

/**
 * A task's end as the agent reads it, in English (people read `taskEndLine`). `computer`: where it ran, or null for a
 * line that doesn't say.
 */
export function taskEndText(task: TaskEnd, computer: string | null) {
  const took = formatDuration(task.seconds);
  const on = computer ? ` on ${computer}` : "";
  const blocked = task.blocked?.length ? ` Blocked: ${task.blocked.map((d) => `\`${d.command}\``).join(", ")}.` : "";
  switch (task.status) {
    case "done":
      return `Task "${task.title}" finished${on} after ${took}.${blocked}`;
    case "canceled":
      return `Task "${task.title}" was canceled${on} after ${took}.${blocked}`;
    case "interrupted":
      return `Task "${task.title}" was interrupted${on} after ${took} (the computer went away) and couldn't resume by itself.${blocked}`;
    default:
      return `Task "${task.title}" failed${on} after ${took} (exit code ${task.exitCode ?? "none"}).${blocked}`;
  }
}

const END_STATUSES = new Set(["done", "failed", "canceled", "interrupted"]);

/**
 * A task's end as people read it, in their language: the chat's own line (`chat.body.machine_task_*`), naming
 * `computer` when given, else in its `…NoComputer` words (one computer in the workspace, or none known).
 */
export function taskEndLine(locale: AppLocale, task: Pick<TaskEnd, "title" | "status">, computer: string | null) {
  const key = `chat.body.machine_task_${END_STATUSES.has(task.status) ? task.status : "failed"}`;
  return computer
    ? serverText(locale, key, { title: task.title, computer })
    : serverText(locale, `${key}NoComputer`, { title: task.title });
}
