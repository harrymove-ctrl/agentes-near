import type { AccessTool, Agent } from "@agenteschat/client";
import { keys, useAgents, useCatalog, useConnections, useCustomServers } from "@agenteschat/client";
import {
  type AccessResource,
  asksAt,
  type Level,
  type LevelState,
  levelOf,
  nextLevel,
  resourcesOf,
  saveLevels,
  toolsAt,
} from "@agenteschat/client/lib/access-levels";
import { type ConnectedItem, connectedItems, itemName } from "@agenteschat/client/lib/connected";
import type { agentGrammar } from "@agenteschat/client/lib/grammar";
import { addsConnectors, can, makesAgents } from "@agenteschat/client/lib/permissions";
import { builtinToolText } from "@agenteschat/client/lib/scopes";
import { labelIsName } from "@agenteschat/client/lib/tool-labels";
import { partsOf, toolName } from "@agenteschat/client/lib/tool-review";
import {
  type AgentAppearance,
  Button,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  Icon,
  type IconName,
  Segmented,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { LoadingList } from "@/components/Loading";
import { CreateAgentButton } from "@/components/new-agent/NewAgentDialog";
import { useOrg } from "@/components/org-context";
import { useAgentsAccess } from "@/hooks/useAgentsAccess";
import { useRightHandLook } from "@/hooks/useRightHandLook";

type TT = (key: string, options: Record<string, string>) => string;

const AREA_ICON: Record<string, IconName> = {
  context: "search",
  drive: "drive",
  issues: "issues",
  calendar: "calendar",
  wiki: "book",
  skills: "bolt",
  schedule: "routines",
  sandbox: "computer",
  browser: "globe",
  setup: "edit",
  desktop: "pointer",
};

/** The connected services by connection id (their names and brand icons). */
export function useConnectedById() {
  const { org } = useOrg();
  const catalog = useCatalog();
  const connections = useConnections(org.id);
  const servers = useCustomServers(org.id);
  return useMemo(
    () =>
      new Map(
        connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []).map((i) => [
          i.id,
          i,
        ]),
      ),
    [connections.data, servers.data, catalog.data],
  );
}

/** A resource's name in the app's language: the service's name, or the built-in area's. */
export function resourceName(t: TFunction, r: AccessResource, items: Map<string, ConnectedItem>) {
  if (r.connectionId) {
    const item = items.get(r.connectionId);
    return item ? itemName(t, item) : r.label;
  }
  return (t as unknown as TT)(`access.area.${r.area}`, { defaultValue: r.label });
}

export function ResourceIcon({
  resource,
  items,
  name,
}: {
  resource: Pick<AccessResource, "connectionId" | "area">;
  items: Map<string, ConnectedItem>;
  name: string;
}) {
  if (resource.connectionId) {
    const item = items.get(resource.connectionId);
    return <ConnectorIcon def={item?.def ?? null} image={item?.image} label={name} />;
  }
  return (
    <span className="connector-icon connector-icon--mono" aria-hidden="true">
      <Icon name={AREA_ICON[resource.area ?? ""] ?? "settings"} />
    </span>
  );
}

/**
 * A tool in words, "Ler arquivo" for `github_get_file_contents` (`toolName`: the catalog, else its verb and nouns); a
 * custom tool's label when someone named it; built-ins translated.
 */
export function toolLabel(t: TFunction, r: AccessResource, tool: AccessTool) {
  if (r.kind === "builtin") return builtinToolText(t, tool).label;
  if (r.custom && !labelIsName(tool.label, tool.name)) return tool.label;
  const prefix = r.connector && !r.custom ? `${r.connector}_` : "";
  // A numbered connection's tools (`linear_2_create_issue`) lose the number too.
  const own = prefix && tool.name.startsWith(prefix) ? tool.name.slice(prefix.length).replace(/^\d+_/, "") : tool.name;
  return toolName(t, partsOf(own), own);
}

/**
 * What a level means for a resource: a sentence for built-in areas (in the agent's own words, `agentGrammar`), the
 * tools for connectors.
 */
export function levelText(t: TFunction, r: AccessResource, level: LevelState, g: ReturnType<typeof agentGrammar>) {
  if (level === "none") return t("access.noneText");
  if (level === "custom") return t("access.customText");
  if (r.kind === "builtin") {
    const text = (t as unknown as TT)(`access.areaText.${r.area}.${level}`, {
      name: g.name,
      context: g.context ?? "",
      defaultValue: "",
    });
    if (text) return text;
  }
  const names = toolsAt(r, level)
    .filter((x) => !x.sensitive)
    .map((x) => toolLabel(t, r, x));
  if (names.length === 0) return t("access.noTools");
  return names.length > 6
    ? t("access.toolsMore", { tools: names.slice(0, 6).join(" · "), count: names.length - 6 })
    : names.join(" · ");
}

/** Saves levels for one agent (reads its grants fresh, one PUT) and refreshes the shared cache. */
export function useSetLevels() {
  const api = useApi();
  const { org } = useOrg();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, changes }: { agentId: string; changes: Record<string, Level> }) =>
      saveLevels(api, org.id, agentId, changes),
    onSuccess: (saved, { agentId }) => {
      qc.setQueryData(keys.agentAccess(org.id, agentId), saved);
      void qc.invalidateQueries({ queryKey: keys.scopes(org.id, agentId) });
    },
  });
}

/**
 * One resource and its level: icon, name, what the level gives, what asks
 * for approval, and the choice (Sem acesso / Ler / Ler e escrever). Without
 * `onChange` it only shows the level. The agent page and "Criar agente".
 */
export function LevelRow({
  icon,
  name,
  description,
  asks = [],
  levels,
  value,
  onChange,
  tag,
  extra,
  below,
  changed,
}: {
  icon: ReactNode;
  name: string;
  description?: string | null;
  asks?: string[];
  levels: Level[];
  value: LevelState;
  onChange?: (level: Level) => void;
  /** Next to the name ("Alterado" on the agent page). */
  tag?: ReactNode;
  /** Under the description (what it was before). */
  extra?: ReactNode;
  /** A full-width part under the row (GitHub: which repositories). */
  below?: ReactNode;
  /** Marked as changed and not saved yet. */
  changed?: boolean;
}) {
  const { t } = useTranslation();
  const options = [
    ...levels.map((l) => ({ value: l as LevelState, label: t(`access.level.${l}`) })),
    ...(value === "custom" ? [{ value: "custom" as LevelState, label: t("access.level.custom") }] : []),
  ];
  return (
    <li className="level-row ac-mediarow" data-changed={changed || undefined}>
      <span className="ac-mediarow__face">{icon}</span>
      <span className="ac-mediarow__head">
        <span className="level-row__name">
          {name}
          {tag}
        </span>
      </span>
      <span className="ac-mediarow__end ac-mediarow__end--wrap">
        {onChange ? (
          <Segmented
            size="sm"
            className="level-row__choice"
            label={t("access.levelOf", { name })}
            value={value}
            onValueChange={(l) => l !== "custom" && onChange(l)}
            options={options}
          />
        ) : (
          <Chip icon={value === "none" ? "dash" : value === "custom" ? "settings" : "check"}>
            {t(`access.level.${value}`)}
          </Chip>
        )}
      </span>
      <span className="ac-mediarow__body level-row__text">
        {description && <span className="small muted">{description}</span>}
        {asks.length > 0 && (
          <span className="level-row__asks">
            {asks.slice(0, 3).map((a) => (
              <Chip key={a} icon="lock" tone="waiting">
                {t("access.asks", { tool: a })}
              </Chip>
            ))}
            {asks.length > 3 && <span className="small muted">{t("access.asksMore", { count: asks.length - 3 })}</span>}
          </span>
        )}
        {extra}
        {below && <div className="level-row__below">{below}</div>}
      </span>
    </li>
  );
}

/**
 * Settings → "Agentes e acesso" (admins): agents × connectors (or the
 * built-in areas), each cell a level. A click cycles Sem acesso → Ler → Ler
 * e escrever and saves right away. Fine-tuning per tool is the connector's
 * "Ferramentas" (what the organization allows at all).
 */
export function AccessMatrixSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const look = useRightHandLook();
  const admin = can(org, "manage_agents");
  const agents = useAgents(org.id);
  const list = agents.data ?? [];
  const access = useAgentsAccess(list, admin);
  const items = useConnectedById();
  const set = useSetLevels();
  const [kind, setKind] = useState<"connector" | "builtin">("connector");
  const [pending, setPending] = useState<Record<string, Level>>({});
  if (!admin) return null;
  const first = list.map((a) => access.byAgent.get(a.id)).find((x) => x !== undefined);
  const columns = first ? resourcesOf(first).filter((r) => r.kind === kind) : [];
  const table = first !== undefined && columns.length > 0 && !access.loading;
  const busyAgents = new Set(Object.keys(pending).map((k) => k.split("|")[0]));
  const levelLabel = (l: LevelState) => t(`access.level.${l}`);

  const cycle = (agent: Agent, r: AccessResource, current: LevelState) => {
    if (busyAgents.has(agent.id)) return;
    const level = nextLevel(r, current);
    const k = `${agent.id}|${r.id}`;
    setPending((p) => ({ ...p, [k]: level }));
    set.mutate(
      { agentId: agent.id, changes: { [r.id]: level } },
      {
        onSettled: () =>
          setPending((p) => {
            const next = { ...p };
            delete next[k];
            return next;
          }),
      },
    );
  };

  return (
    <Card aria-labelledby="sec-access">
      <CardHeader
        id="sec-access"
        icon="agent"
        title={t("access.matrixTitle")}
        hint={{ name: t("common.about", { label: t("access.matrixTitle") }), text: t("access.matrixHint") }}
        action={
          <Segmented
            size="sm"
            label={t("access.kindLabel")}
            value={kind}
            onValueChange={setKind}
            options={[
              { value: "connector", label: t("access.kind.connectors") },
              { value: "builtin", label: t("access.kind.builtin") },
            ]}
          />
        }
      />
      {access.unavailable && <p className="small muted">{t("access.unavailable")}</p>}
      {(agents.isLoading || (list.length > 0 && access.loading)) && (
        <LoadingList count={Math.min(Math.max(list.length, 2), 5)} trailing />
      )}
      {agents.isSuccess && list.length === 0 && (
        <EmptyState
          size="panel"
          agent={look}
          title={t(makesAgents(org) ? "access.noAgentsTitle" : "team.emptyViewerTitle")}
          actions={makesAgents(org) && <CreateAgentButton />}
        >
          {t(makesAgents(org) ? "access.noAgents" : "team.emptyViewer")}
        </EmptyState>
      )}
      {first && columns.length === 0 && <NoConnectors look={look} />}
      {table && (
        <div className="level-matrix">
          <table>
            <thead>
              <tr>
                <th scope="col">{t("access.agentCol")}</th>
                {columns.map((r) => {
                  const name = resourceName(t, r, items);
                  return (
                    <th key={r.id} scope="col">
                      <span className="level-matrix__head ac-iconline">
                        <ResourceIcon resource={r} items={items} name={name} />
                        {name}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {list.map((a) => {
                const tree = access.byAgent.get(a.id);
                const mine = tree ? resourcesOf(tree) : [];
                return (
                  <tr key={a.id}>
                    <th scope="row">
                      <span className="level-matrix__agent ac-iconline">
                        <AgentAvatar agentId={a.id} name={a.name} size="sm" />
                        <span>
                          {a.name}
                          {a.role && <span className="muted"> · {a.role}</span>}
                        </span>
                      </span>
                    </th>
                    {columns.map((col) => {
                      const r = mine.find((x) => x.id === col.id);
                      const name = resourceName(t, col, items);
                      if (!r) {
                        return (
                          <td key={col.id}>
                            <span className="small muted">{t("access.level.none")}</span>
                          </td>
                        );
                      }
                      const level = pending[`${a.id}|${r.id}`] ?? levelOf(r);
                      const asks = asksAt(r, level).length > 0;
                      const label = t(asks ? "access.cellAsks" : "access.cell", {
                        agent: a.name,
                        resource: name,
                        level: levelLabel(level),
                      });
                      return (
                        <td key={col.id}>
                          <button
                            type="button"
                            className="level-pill"
                            data-level={level}
                            aria-label={label}
                            title={label}
                            aria-busy={pending[`${a.id}|${r.id}`] !== undefined || undefined}
                            disabled={busyAgents.has(a.id)}
                            onClick={() => cycle(a, r, level)}
                          >
                            {levelLabel(level)}
                            {asks && <Icon name="lock" />}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {table && (
        <div className="level-legend small muted">
          <span>{t("access.matrixHow")}</span>
          {(["none", "read", "write"] as const).map((l) => (
            <span key={l} className="level-pill level-pill--static" data-level={l}>
              {levelLabel(l)}
            </span>
          ))}
          <span className="level-legend__asks">
            <Icon name="lock" />
            {t("access.asksLegend")}
          </span>
        </div>
      )}
    </Card>
  );
}

/** No connector in the workspace yet, on an agent's access and on the matrix: the way to it, or who has it. */
export function NoConnectors({ look }: { look: AgentAppearance | true }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const admin = addsConnectors(org);
  return (
    <EmptyState
      size="panel"
      agent={look}
      title={t(admin ? "access.noConnectorsTitle" : "access.noConnectorsViewerTitle")}
      actions={
        admin && (
          <Button asChild variant="primary" icon="plus">
            <Link to="/org/$orgId/settings/$section" params={{ orgId: org.id, section: "connectors" }}>
              {t("connectors.add")}
            </Link>
          </Button>
        )
      }
    >
      {t(admin ? "access.noConnectors" : "access.noConnectorsViewer")}
    </EmptyState>
  );
}
