import { createFileRoute } from "@tanstack/react-router";
import { UpdatesPage } from "@/pages/UpdatesPage";

/** Public Updates & ZEN PRD changelog page (`/updates`). */
export const Route = createFileRoute("/updates")({
  component: UpdatesPage,
});
