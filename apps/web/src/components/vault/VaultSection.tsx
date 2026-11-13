import type { VaultItem, VaultItemKind, VaultScope } from "@agenteschat/client";
import { useVault } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { Button, EmptyState, Icon, List, PageHeader, SearchField, Segmented, Select, Toolbar } from "@agenteschat/ui";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { hostOf, matchesQuery, sortItems } from "./lib";
import { AgentFaces } from "./VaultAccess";
import { VaultConnections } from "./VaultConnections";
import { VaultImportDialog } from "./VaultImportDialog";
import { ItemChips, VaultItemDialog, VaultTile } from "./VaultItemDialog";
import { VaultNewDialog } from "./VaultNewDialog";
import "./vault.css";

/*
 * Settings › Vault (ADR 0144): the logins, keys and contact details agents use without seeing a password or a key.
 * One view at a time (Team, Personal, Connections, each with its count), a search and a kind filter over the items, a
 * row per item (what it is, who may use it, when it was last used) that opens its details.
 */

type Tab = "team" | "personal" | "connections";
type KindFilter = "all" | VaultItemKind;

/**
 * The line under an item's name: where and as whom (login), the variable (key), the description (contact: the list
 * carries no contact's fields, only its page does, ADR 0144 §7).
 */
function Subtitle({ item }: { item: VaultItem }) {
  const parts: ReactNode[] =
    item.kind === "login"
      ? [hostOf(item.website), item.username]
      : item.kind === "key"
        ? [
            item.keyName ? (
              <code key="name" className="vlt-code">
                {item.keyName}
              </code>
            ) : null,
            item.description,
          ]
        : [item.description];
  const shown = parts.filter(Boolean);
  return (
    <span className="vlt-row__sub">
      {shown.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: two or three fixed parts of one line
        <span key={i}>
          {i > 0 && " · "}
          {p}
        </span>
      ))}
    </span>
  );
}

/** Who may use it, short: every agent, one by name, or how many. */
function useAgentsShort() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  return (item: VaultItem) => {
    if (item.access.allAgents) return t("vault.access.allAgents");
    const names = item.access.agentIds.map((id) => dir.agentById.get(id)?.name).filter(Boolean);
    if (names.length === 0) return null;
    return names.length === 1 ? (names[0] as string) : t("vault.row.agents", { count: names.length });
  };
}

function VaultRow({ item, onOpen }: { item: VaultItem; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  const agents = useAgentsShort()(item);
  return (
    <button type="button" className="ac-list__row vlt-row" onClick={onOpen}>
      <VaultTile kind={item.kind} />
      <span className="vlt-row__text">
        <span className="vlt-row__name">
          <span className="vlt-row__title">{item.title}</span>
          <ItemChips item={item} />
        </span>
        <Subtitle item={item} />
      </span>
      <span className="vlt-row__who">
        {agents ? (
          <>
            <AgentFaces access={item.access} />
            <span>{agents}</span>
          </>
        ) : (
          <span className="vlt-row__none">{t("vault.access.noAgents")}</span>
        )}
      </span>
      <span className="vlt-row__used">
        {item.lastUsedAt
          ? t("vault.row.used", { when: relativeTime(t, i18n.language, item.lastUsedAt) })
          : t("vault.row.never")}
      </span>
      <Icon name="chevronRight" size={16} className="vlt-row__chev" />
    </button>
  );
}

export function VaultSection() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const vault = useVault(org.id);
  const look = useRightHandLook();
  const [tab, setTab] = useState<Tab | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "new" | "import">(null);
  const data = vault.data;
  const items = data?.items ?? [];
  const team = items.filter((i) => i.scope === "team");
  const personal = items.filter((i) => i.scope === "personal");
  // Opens where there is something for this person: the team's, unless they have none to see and can't add one.
  const current: Tab = tab ?? (data && !data.canManageTeam && team.length === 0 ? "personal" : "team");
  const scope: VaultScope = current === "personal" ? "personal" : "team";
  const canManageTeam = data?.canManageTeam ?? false;
  // The team's items are the shared ones in a personal workspace (ADR 0159): the same items, its own word.
  const teamTab = t(modeKey(org, "vault.tab.team"));
  const inTab = current === "personal" ? personal : team;
  const shown = sortItems(
    inTab.filter((i) => (kind === "all" || i.kind === kind) && matchesQuery(i, query)),
    i18n.language,
  );
  const filtered = query.trim() !== "" || kind !== "all";
  // The kind filter only where it can narrow something: a view that holds more than one kind.
  const kinds = new Set(inTab.map((i) => i.kind)).size;
  const open = (which: "new" | "import") => () => setDialog(which);
  const addsInList =
    !!data && current !== "connections" && inTab.length === 0 && (current === "personal" || canManageTeam);
  const pickTab = (next: Tab) => {
    setTab(next);
    // Each view starts unfiltered: a search or a kind from the other one would hide what this one holds.
    setQuery("");
    setKind("all");
  };

  const list = () => {
    if (shown.length > 0)
      return (
        <List className="vlt-list" aria-label={scope === "team" ? teamTab : t("vault.tab.personal")}>
          {shown.map((item) => (
            <VaultRow key={item.id} item={item} onOpen={() => setOpenId(item.id)} />
          ))}
        </List>
      );
    if (filtered)
      return (
        <EmptyState
          size="panel"
          actions={
            <Button
              onClick={() => {
                setQuery("");
                setKind("all");
              }}
            >
              {t("vault.list.clearFilters")}
            </Button>
          }
        >
          {t("vault.list.noMatch")}
        </EmptyState>
      );
    const adds = (
      <Button variant="primary" icon="plus" onClick={open("new")}>
        {t("vault.new.open")}
      </Button>
    );
    if (current === "personal")
      return (
        <EmptyState size="page" agent={look} title={t("vault.list.personalEmpty")} actions={adds}>
          {t("vault.list.personalEmptyText")}
        </EmptyState>
      );
    return (
      <EmptyState
        size="page"
        agent={look}
        title={canManageTeam ? t(modeKey(org, "vault.list.teamEmpty")) : t("vault.list.sharedEmpty")}
        actions={canManageTeam && adds}
      >
        {canManageTeam ? t("vault.list.teamEmptyText") : t(modeKey(org, "vault.list.sharedEmptyText"))}
      </EmptyState>
    );
  };

  return (
    <div className="vlt">
      <PageHeader
        level={2}
        title={t("settings.section.vault")}
        meta={t("settings.sectionText.vault")}
        actions={
          <>
            <Button icon="upload" onClick={open("import")}>
              {t("vault.import.open")}
            </Button>
            {/* The empty list takes over this button: one way in, in the middle of the page. */}
            {!addsInList && (
              <Button variant="primary" icon="plus" onClick={open("new")}>
                {t("vault.new.open")}
              </Button>
            )}
          </>
        }
      />
      {vault.isPending ? (
        <LoadingList count={4} trailing />
      ) : vault.isError || !data ? (
        <ErrorState error={vault.error} onRetry={() => void vault.refetch()} />
      ) : (
        <div className="vlt-body">
          <Segmented<Tab>
            label={t("vault.tab.label")}
            value={current}
            onValueChange={pickTab}
            options={[
              { value: "team", label: teamTab, count: team.length },
              { value: "personal", label: t("vault.tab.personal"), count: personal.length },
              { value: "connections", label: t("vault.tab.connections"), count: data.connections.length },
            ]}
          />
          {current === "connections" ? (
            <VaultConnections overview={data} />
          ) : (
            <>
              {current === "personal" && personal.length > 0 && (
                <p className="vlt-tabnote ac-iconline">
                  <Icon name="lock" size={14} />
                  <span>{t("vault.list.personalNote")}</span>
                </p>
              )}
              {inTab.length > 0 && (
                <Toolbar
                  search={
                    <SearchField
                      value={query}
                      placeholder={t("vault.list.search")}
                      aria-label={t("vault.list.search")}
                      onChange={(e) => setQuery(e.target.value)}
                      onClear={() => setQuery("")}
                      clearLabel={t("vault.list.clearSearch")}
                    />
                  }
                  actions={
                    (kinds > 1 || kind !== "all") && (
                      <Select<KindFilter>
                        size="sm"
                        className="vlt-kind"
                        value={kind}
                        onValueChange={setKind}
                        aria-label={t("vault.list.kind")}
                        align="end"
                        options={[
                          { value: "all", label: t("vault.list.kindAll") },
                          { value: "login", label: t("vault.kindPlural.loginTitle") },
                          { value: "key", label: t("vault.kindPlural.keyTitle") },
                          { value: "contact", label: t("vault.kindPlural.contactTitle") },
                        ]}
                      />
                    )
                  }
                />
              )}
              {list()}
            </>
          )}
          {openId && <VaultItemDialog key={openId} itemId={openId} overview={data} onClose={() => setOpenId(null)} />}
        </div>
      )}
      {dialog === "new" && (
        <VaultNewDialog
          canManageTeam={canManageTeam}
          scope={scope}
          onClose={() => setDialog(null)}
          onCreated={(item) => {
            setDialog(null);
            setTab(item.scope);
          }}
        />
      )}
      {dialog === "import" && (
        <VaultImportDialog canManageTeam={canManageTeam} scope={scope} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
