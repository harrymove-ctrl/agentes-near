import { WorkspacesSheet } from "@/features/me/WorkspacesSheet";

/** The workspaces as a sheet, from holding the workspace's mark in the bar (ADR 0154; presentation set in `_layout`). */
export default function WorkspacesSheetRoute() {
  return <WorkspacesSheet />;
}
