import { useCatalog, useConnections, useCustomServers } from "@agenteschat/client";
import { connectedItems } from "@agenteschat/client/lib/connected";
import {
  noAppWorks,
  type RoutineTemplateArea,
  type RoutineTemplateOption,
  routineTemplateOptions,
} from "@agenteschat/client/lib/routine-templates";
import { Field, Icon, type IconName, SearchSelect, type SelectOption } from "@agenteschat/ui";
import { matchesWords } from "@agenteschat/ui/search";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { useOrg } from "@/components/org-context";

const AREA_ICON: Record<RoutineTemplateArea, IconName> = {
  team: "members",
  sales: "chart",
  support: "message",
  marketing: "sound",
  finance: "coin",
  ops: "cog",
  people: "person",
  tech: "code",
};

type Row = RoutineTemplateOption & SelectOption;

const matches = (o: Row, query: string) => matchesWords(`${o.label} ${o.group} ${o.keywords}`, query);

/**
 * "Começar de um modelo": one search over the templates, by area. A template that needs an app says which, in the
 * list and, once picked, under the select, where one not connected yet has its way there.
 */
export function RoutineTemplateSelect({
  value,
  onPick,
}: {
  value: string | undefined;
  onPick: (option: RoutineTemplateOption) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const catalog = useCatalog().data?.connectors;
  const options = useMemo<Row[]>(
    () =>
      routineTemplateOptions(t, catalog).map((o) => {
        const app = o.apps[0];
        return {
          ...o,
          leading: app ? (
            <ConnectorIcon def={app} label={app.label} />
          ) : (
            <span className="connector-icon connector-icon--mono">
              <Icon name={o.template.kind === "email" ? "mail" : AREA_ICON[o.template.area]} size={16} />
            </span>
          ),
          description: (
            <>
              <span className="routine-template__text">{o.text}</span>
              {o.needs && <span className="routine-template__needs">{o.needs}</span>}
            </>
          ),
        };
      }),
    [t, catalog],
  );
  const chosen = options.find((o) => o.value === value);
  const needsApps = Boolean(chosen?.apps.length);
  const connections = useConnections(org.id, needsApps);
  const servers = useCustomServers(org.id, needsApps);
  const missing =
    chosen &&
    connections.data &&
    servers.data &&
    noAppWorks(chosen.apps, connectedItems(connections.data, servers.data, catalog ?? []));
  return (
    <Field label={t("routines.presets.title")} id="nr-template">
      <SearchSelect<string, Row>
        value={value}
        onValueChange={(v) => {
          const picked = options.find((o) => o.value === v);
          if (picked) onPick(picked);
        }}
        options={options}
        matches={matches}
        placeholder={t("routines.presets.placeholder")}
        labels={{
          search: t("routines.presets.search"),
          searchPlaceholder: t("routines.presets.searchPlaceholder"),
          noResults: t("routines.presets.noResults"),
          list: t("routines.presets.list"),
        }}
      />
      {chosen && needsApps && (
        <div className="routine-needs small">
          {chosen.apps.map((d) => (
            <ConnectorIcon key={d.id} def={d} label={d.label} />
          ))}
          <span>
            {chosen.needs}
            {missing && (
              <span className="routine-needs__connect">
                {t("routines.presets.connectFirst")}{" "}
                <Link
                  className="ac-link"
                  to="/org/$orgId/settings/$section"
                  params={{ orgId: org.id, section: "connectors" }}
                >
                  {t("mail.routine.openConnectors")}
                </Link>
              </span>
            )}
          </span>
        </div>
      )}
    </Field>
  );
}
