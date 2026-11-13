import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { TaskManagerPage } from "@/pages/TaskManagerPage";

/**
 * Gerenciador de tarefas (ADR 0128): what every agent is doing now, what each task uses, and stopping it.
 * `?agent=<id>` opens with that agent's card chosen (from its tasks' panel in a DM); `?task=<run id>` with that task's
 * panel open (from a row of a computer's line).
 */
export const Route = createFileRoute("/org/$orgId/task-manager")({
  validateSearch: (search: Record<string, unknown>): { agent?: string; task?: string } => ({
    agent: typeof search.agent === "string" && search.agent ? search.agent : undefined,
    task: typeof search.task === "string" && search.task ? search.task : undefined,
  }),
  component: function TaskManagerRoute() {
    const { agent, task } = Route.useSearch();
    const navigate = Route.useNavigate();
    return (
      <Main>
        <TaskManagerPage
          agent={agent}
          task={task}
          onTaskClosed={() => void navigate({ search: { agent, task: undefined }, replace: true })}
        />
      </Main>
    );
  },
});
