import { useCatalog, useConnections, useCustomServers } from "@agenteschat/client";
import { connectedItems } from "@agenteschat/client/lib/connected";
import {
  noAppWorks,
  type RoutineTemplateArea,
  type RoutineTemplateOption,
  routineTemplateOptions,
} from "@agenteschat/client/lib/routine-templates";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, GroupedHeader, GroupedList, GroupedRow, type IconName, Sheet, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import { useOrgId } from "../shared/hooks";
import { PickList } from "../shared/PickList";
import { SheetTitle } from "../shared/PromptForm";

const AREA_ICON: Record<RoutineTemplateArea, IconName> = {
  team: "members",
  sales: "target",
  support: "chat",
  marketing: "sound",
  finance: "chart",
  ops: "checkc",
  people: "person",
  tech: "code",
};

/**
 * The web's "Começar de um modelo": a row that opens a search over the templates, by area. One that needs an app says
 * which, in the list and, once picked, under the row, where one not connected yet has its way there.
 */
export function TemplatePicker({
  value,
  onPick,
}: {
  value: string | undefined;
  onPick: (option: RoutineTemplateOption) => void;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const [open, setOpen] = useState(false);
  const catalog = useCatalog().data?.connectors;
  const options = useMemo(
    () =>
      routineTemplateOptions(t, catalog).map((o) => {
        const app = o.apps[0];
        return {
          ...o,
          description: o.needs ? `${o.text}\n${o.needs}` : o.text,
          subLines: 4,
          ...(app
            ? { leading: <ConnectorIcon def={app} label={app.label} size={30} /> }
            : { icon: o.template.kind === "email" ? ("mail" as const) : AREA_ICON[o.template.area] }),
        };
      }),
    [t, catalog],
  );
  const chosen = options.find((o) => o.value === value);
  const needsApps = Boolean(chosen?.apps.length);
  const connections = useConnections(orgId, needsApps);
  const servers = useCustomServers(orgId, needsApps);
  const missing =
    chosen &&
    connections.data &&
    servers.data &&
    noAppWorks(chosen.apps, connectedItems(connections.data, servers.data, catalog ?? []));
  return (
    <>
      <GroupedHeader>{t("routines.presets.title")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="sparkle"
          label={chosen?.label ?? t("routines.presets.placeholder")}
          chevron
          onPress={() => setOpen(true)}
        />
      </GroupedList>
      {chosen && needsApps ? (
        <View style={styles.needs}>
          <View style={styles.marks}>
            {chosen.apps.map((d) => (
              <ConnectorIcon key={d.id} def={d} label={d.label} size={24} />
            ))}
          </View>
          <Text variant="footnote" tone="faint">
            {chosen.needs}
          </Text>
          {missing ? (
            <>
              <Text variant="footnote" tone="faint">
                {t("routines.presets.connectFirst")}
              </Text>
              <Button
                variant="secondary"
                size="sm"
                icon="bolt"
                label={t("mail.routine.openConnectors")}
                onPress={() => router.push("/connectors")}
              />
            </>
          ) : null}
        </View>
      ) : null}
      <Sheet open={open} onClose={() => setOpen(false)}>
        <SheetTitle title={t("routines.presets.title")} />
        <PickList
          options={options}
          value={value}
          onPick={(o) => {
            setOpen(false);
            onPick(o);
          }}
          placeholder={t("routines.presets.searchPlaceholder")}
          searchLabel={t("routines.presets.search")}
          noResults={t("routines.presets.noResults")}
        />
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  needs: { paddingTop: 7, paddingHorizontal: 16, gap: 6, alignItems: "flex-start" },
  marks: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
});
