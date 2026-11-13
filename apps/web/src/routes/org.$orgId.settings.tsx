import { createFileRoute, redirect } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { SettingsPage } from "@/pages/SettingsPage";
import { settingsSearch } from "@/pages/settings-sections";

/**
 * Settings, no section named: Geral for who opens it. Older OAuth returns (`/settings?connected=…`, `?review=1`)
 * land on Conectores, where they are handled.
 */
export const Route = createFileRoute("/org/$orgId/settings")({
  validateSearch: settingsSearch,
  beforeLoad: ({ params, search }) => {
    if (search.connected !== undefined || search.review !== undefined || search.mail !== undefined) {
      throw redirect({
        to: "/org/$orgId/settings/$section",
        params: { orgId: params.orgId, section: "connectors" },
        search,
      });
    }
  },
  component: function Settings() {
    return (
      <Main>
        <SettingsPage />
      </Main>
    );
  },
});
