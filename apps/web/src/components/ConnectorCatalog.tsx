import type { ConnectorCategory, ConnectorDef } from "@agenteschat/client";
import { composioOffText, hiddenWithoutComposio } from "@agenteschat/client/lib/composio";
import { CONNECTOR_MARK, OWN_MARK, SERVER_ICON } from "@agenteschat/client/lib/connected";
import type { MailChoice } from "@agenteschat/client/lib/mail";
import { can } from "@agenteschat/client/lib/permissions";
import { connectorDescription, connectorName, scopeText } from "@agenteschat/client/lib/scopes";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  AgentSearching,
  Button,
  Chip,
  Dialog,
  EmptyState,
  GroupHeading,
  Icon,
  type IconName,
  initialsOf,
  SearchField,
  Segmented,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type CSSProperties, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { DatabaseIcon } from "@/components/DatabaseConnect";
import { LoadingCards } from "@/components/Loading";
import { MailIcon, mailAuthKind, mailChoiceName } from "@/components/MailConnect";
import { useOrg } from "@/components/org-context";
import { ConnectorSky } from "@/components/Sky";

export const CATEGORIES: ConnectorCategory[] = [
  "dev",
  "product",
  "docs",
  "data",
  "payments",
  "sales",
  "support",
  "marketing",
  "automation",
  "social",
];

/** Connector search over label, id and description, plus the text shown (`shown`: the name and description in the app's language). */
export function searchCatalog(list: ConnectorDef[], query: string, shown: (d: ConnectorDef) => string = () => "") {
  const q = query.trim().toLowerCase();
  return q ? list.filter((d) => `${d.label} ${d.id} ${d.description} ${shown(d)}`.toLowerCase().includes(q)) : list;
}

/** How it connects, for the card: one click (OAuth), OAuth or a key, a key only, or through Composio. */
export function authKind(d: ConnectorDef): "oneClick" | "oauthOrKey" | "key" | "composio" {
  if (d.via === "composio") return "composio";
  if (d.kind === "remote_mcp") return "oneClick";
  return d.oauthConfigured && d.auth.includes("oauth") ? "oauthOrKey" : "key";
}

/**
 * The service's one-color brand icon drawn as a mask in its brand color (the
 * ink for near-black brands); else a mark in its own colors, ours or the
 * icon a server connected by address gave (`image`); else a monogram.
 */
export function ConnectorIcon({
  def,
  label,
  size = "md",
  image,
}: {
  def: Pick<ConnectorDef, "iconUrl" | "brandColor"> | null;
  label: string;
  size?: "md" | "lg";
  image?: string | null;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const cls = `connector-icon${size === "lg" ? " connector-icon--lg" : ""}`;
  // Only a file of ours goes into the CSS `url()`.
  if (def?.iconUrl && CONNECTOR_MARK.test(def.iconUrl)) {
    const style = {
      "--connector-icon": `url("${def.iconUrl}")`,
      ...(def.brandColor && /^#[0-9a-fA-F]{6}$/.test(def.brandColor) ? { "--connector-color": def.brandColor } : {}),
    } as CSSProperties;
    return (
      <span className={`${cls} connector-icon--brand`} aria-hidden="true">
        <span className="connector-icon__mark" style={style} />
      </span>
    );
  }
  const own =
    def?.iconUrl && OWN_MARK.test(def.iconUrl) ? def.iconUrl : image && SERVER_ICON.test(image) ? image : null;
  // A saved call keeps the icon its server had then, and a newer icon deletes that file: the monogram instead.
  if (own && own !== failed) {
    return (
      <span className={`${cls} connector-icon--brand`} aria-hidden="true">
        <img className="connector-icon__img" src={own} alt="" onError={() => setFailed(own)} />
      </span>
    );
  }
  return (
    <span className={`${cls} connector-icon--mono connector-icon--initial`} aria-hidden="true">
      {initialsOf(label)}
    </span>
  );
}

/** How a service connects, for the detail pane. */
type HowKind = ReturnType<typeof authKind> | "appPassword" | "addressPassword";

/** One service in the catalog: a catalog connector, a mailbox kind or the Postgres database. */
interface Entry {
  key: string;
  name: string;
  description: string;
  category: ConnectorCategory | "email";
  connected: boolean;
  available: boolean;
  /** Not connected, and the vendor hasn't approved agentes.chat yet: greyed out with a lock, its tile opens nothing. */
  soon: boolean;
  icon: (size: "md" | "lg") => ReactNode;
  brandColor: string | null;
  how: HowKind;
  /** What agents could do there; `asks` = it always asks a person first. */
  can: { text: string; asks: boolean }[];
  /** What connecting does to who can use it. */
  after: string;
  /** Connected already, the button adds another account (mailboxes, databases, MCP servers) or signs in again. */
  again: "add" | "reconnect";
  /** Starts this service's connect flow (the same flows as before). */
  pick: () => void;
}

/** i18n key of an id (`cloudflare-bindings` → `cloudflare_bindings`). */
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9]/g, "_");

/**
 * The capability lines of a service: our plain-language lines (`connectors.can.<id>`: "1", "2", "3",
 * and "ask" for what always asks approval), or else its scopes.
 */
function capabilities(t: TFunction, exists: (key: string) => boolean, id: string, def?: ConnectorDef) {
  const tt = t as unknown as (key: string) => string;
  const base = `connectors.can.${safeId(id)}`;
  if (exists(`${base}.1`)) {
    const lines = (["1", "2", "3"] as const)
      .filter((n) => exists(`${base}.${n}`))
      .map((n) => ({ text: tt(`${base}.${n}`), asks: false }));
    if (exists(`${base}.ask`)) lines.push({ text: tt(`${base}.ask`), asks: true });
    return lines;
  }
  return (def?.scopes ?? []).map((s) => ({ text: scopeText(t, s).label, asks: s.sensitive }));
}

/** Suggestions, in order: the first three not connected yet (and ready on this server). */
const SUGGESTED = ["github", "database", "linear", "notion", "mail-gmail", "drive", "sentry", "stripe", "slack"];

/** The pane's "Não achou?" entry. */
const OTHER = "other";

/**
 * "Adicionar conector": a gallery with search and the
 * category list beside the grid (a row on phones), three suggestions on top, then every service as an even
 * tile (no tags: a check on the icon when connected). A tile opens the service over the catalog (what agents
 * could do, how it connects, Conectar); "Não achou?" connects any service by its address. A search with no match
 * (or an empty category) is an agent searching with a magnifier, with the same way in by address.
 */
export function ConnectorCatalogDialog({
  open,
  onOpenChange,
  connectors,
  connected,
  loading,
  onPick,
  onOther,
  mail,
  database,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectors: ConnectorDef[];
  /** Catalog ids already connected. */
  connected: Set<string>;
  /** The catalog is still loading. */
  loading?: boolean;
  onPick: (def: ConnectorDef) => void;
  /** Any service by its address (a custom server). */
  onOther: () => void;
  /** The "Email" group (ADR 0038): the mailboxes this server connects, which already have one, and the pick. */
  mail?: { choices: MailChoice[]; connected: Set<MailChoice>; onPick: (choice: MailChoice) => void };
  /** The Postgres database (ADR 0039), in "Desenvolvimento"; it can be connected more than once. */
  database?: { connected: boolean; onPick: () => void };
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<ConnectorCategory | "email" | "all" | "connected">("all");
  // Without Composio here, the services that connect only through it are left out (admins read why at the end).
  const composioOff = can(org, "manage_connectors") ? composioOffText(t, connectors, SUGGESTED) : null;
  const [selected, setSelected] = useState<string | null>(null);
  const exists = (key: string) => i18n.exists(key);

  const entries: Entry[] = [
    ...(mail?.choices ?? []).map(
      (c): Entry => ({
        key: `mail-${c}`,
        name: mailChoiceName(t, c),
        description: t(`mail.choice.${c}.text`),
        category: "email",
        connected: mail?.connected.has(c) ?? false,
        available: true,
        soon: false,
        icon: (size) => <MailIcon choice={c} size={size} />,
        brandColor: c === "gmail" ? "#EA4335" : c === "icloud" ? "#3693F3" : null,
        how: mailAuthKind(c),
        can: capabilities(t, exists, `mail-${c}`),
        after: t("connectors.detail.afterText"),
        again: "add",
        pick: () => mail?.onPick(c),
      }),
    ),
    ...(database
      ? [
          {
            key: "database",
            name: t("database.name"),
            description: t("database.cardText"),
            category: "dev",
            connected: database.connected,
            available: true,
            soon: false,
            icon: (size: "md" | "lg") => <DatabaseIcon size={size} />,
            brandColor: null,
            how: "addressPassword",
            can: capabilities(t, exists, "database"),
            after: t("connectors.detail.afterText"),
            again: "add",
            pick: database.onPick,
          } satisfies Entry,
        ]
      : []),
    ...connectors
      .filter((d) => !hiddenWithoutComposio(d) || connected.has(d.id))
      .map(
        (d): Entry => ({
          key: d.id,
          name: connectorName(t, d),
          description: connectorDescription(t, d),
          category: d.category,
          connected: connected.has(d.id),
          // One connected by its address (with a key) is a connection like any other: it opens, to connect again.
          available: d.available || (d.soon === true && connected.has(d.id)),
          soon: d.soon === true && !connected.has(d.id),
          icon: (size) => <ConnectorIcon def={d} label={d.label} size={size} />,
          brandColor: d.brandColor,
          how: authKind(d),
          can: capabilities(t, exists, d.id, d),
          // As the server does: a first connection is every agent's; then an MCP server takes another account
          // (no agent yet) and a catalog connector a new sign-in (who uses it stays).
          after: t(
            !connected.has(d.id)
              ? "connectors.detail.allText"
              : d.kind === "remote_mcp"
                ? "connectors.detail.accountsText"
                : "connectors.detail.replaceText",
          ),
          again: d.kind === "remote_mcp" ? "add" : "reconnect",
          pick: () => onPick(d),
        }),
      ),
  ];
  // Ready to connect first; "Em breve" last.
  entries.sort((a, b) => Number(b.available) - Number(a.available));

  const present = [
    ...((mail?.choices.length ?? 0) > 0 ? (["email"] as const) : []),
    ...CATEGORIES.filter((c) => entries.some((e) => e.category === c)),
  ];
  const countOf = (c: typeof category) =>
    c === "all"
      ? entries.length
      : c === "connected"
        ? entries.filter((e) => e.connected).length
        : entries.filter((e) => e.category === c).length;
  const needle = q.trim().toLowerCase();
  const matches = (e: Entry) =>
    !needle ||
    `${e.key} ${e.name} ${e.description} ${t(`connectors.category.${e.category}`)} ${e.key === "database" ? "postgres postgresql sql" : ""} ${e.category === "email" ? "email" : ""}`
      .toLowerCase()
      .includes(needle);
  const inCategory = (e: Entry) =>
    category === "all" || (category === "connected" ? e.connected : e.category === category);
  const showSuggestions = category === "all" && !needle;
  const suggested = showSuggestions
    ? SUGGESTED.map((k) => entries.find((e) => e.key === k))
        .filter((e): e is Entry => !!e && !e.connected && e.available)
        .slice(0, 3)
    : [];
  const shown = entries.filter((e) => inCategory(e) && matches(e) && !suggested.includes(e));
  const current = selected === OTHER ? null : (entries.find((e) => e.key === selected) ?? null);

  const close = (next: boolean) => {
    if (!next) {
      setSelected(null);
      setQ("");
      setCategory("all");
    }
    onOpenChange(next);
  };
  // "Todos" and "Conectados" first, then the categories by name in the app's language.
  const filters = [
    "all",
    "connected",
    ...[...present].sort((a, b) =>
      t(`connectors.category.${a}`).localeCompare(t(`connectors.category.${b}`), i18n.language),
    ),
  ] as const;
  const filterLabel = (c: (typeof filters)[number]) =>
    c === "connected" ? t("connectors.connectedFilter") : t(`connectors.category.${c}`);

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={t("connectors.addTitle")}
      closeLabel={t("common.close")}
      width={1080}
      className="catalog"
    >
      <div className="catalog__tools">
        <SearchField
          size="sm"
          className="catalog__search"
          aria-label={t("connectors.search")}
          placeholder={t("connectors.searchPlaceholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onClear={() => setQ("")}
          clearLabel={t("filters.clearSearch")}
        />
        {/* Phones: the categories as one row that scrolls sideways (no room for the list beside the grid). */}
        <Segmented
          size="sm"
          className="catalog__filters"
          label={t("connectors.categories")}
          value={category}
          onValueChange={setCategory}
          options={filters.map((c) => ({ value: c, label: filterLabel(c), count: countOf(c) }))}
        />
      </div>
      <div className="catalog__body">
        <nav className="catalog__cats" aria-label={t("connectors.categories")}>
          {filters.map((c) => (
            <button
              key={c}
              type="button"
              className="catalog__cat"
              data-rule={c === "connected" || undefined}
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
            >
              <span className="catalog__cat-name">{filterLabel(c)}</span>
              <span className="catalog__cat-count">{countOf(c)}</span>
            </button>
          ))}
        </nav>
        {/* biome-ignore lint/a11y/useSemanticElements: a scroll region, not a fieldset */}
        <div className="catalog__list" role="region" aria-label={t("connectors.catalog")}>
          {loading ? (
            <LoadingCards count={6} className="catalog-grid catalog-grid--loading" />
          ) : shown.length === 0 && (needle || category !== "all") ? (
            <EmptyState
              className="catalog__empty"
              art={<AgentSearching />}
              title={needle ? t("connectors.empty", { q: q.trim() }) : t("connectors.emptyCategory")}
              actions={
                <Button icon="link" aria-haspopup="dialog" onClick={() => setSelected(OTHER)}>
                  {t("connectors.otherConnect")}
                </Button>
              }
            >
              {t("connectors.emptyText")}
            </EmptyState>
          ) : (
            <>
              {suggested.length > 0 && (
                <section className="catalog__section" aria-labelledby="catalog-suggested">
                  <GroupHeading
                    level={3}
                    id="catalog-suggested"
                    title={t(modeKey(org, "connectors.suggested"), { org: org.name })}
                  />
                  <ul className="catalog-feat">
                    {suggested.map((e) => (
                      <li key={e.key}>
                        <button
                          type="button"
                          className="catalog-feat__card"
                          aria-label={e.name}
                          aria-haspopup="dialog"
                          onClick={() => setSelected(e.key)}
                        >
                          <ConnectorSky brand={e.brandColor} />
                          <span className="catalog-feat__icon">{e.icon("lg")}</span>
                          <span className="catalog-feat__name">{e.name}</span>
                          <span className="catalog-feat__desc">{e.description}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <section className="catalog__section" aria-labelledby={suggested.length > 0 ? "catalog-more" : undefined}>
                {suggested.length > 0 && <GroupHeading level={3} id="catalog-more" title={t("connectors.more")} />}
                <ul className="catalog-grid">
                  {shown.map((e) => (
                    <li key={e.key}>
                      <button
                        type="button"
                        className="catalog-tile"
                        aria-haspopup={e.soon ? undefined : "dialog"}
                        aria-label={
                          e.connected
                            ? t("connectors.tileConnected", { name: e.name })
                            : e.soon
                              ? t("connectors.tileSoon", { name: e.name })
                              : e.name
                        }
                        data-soon={!e.available || undefined}
                        disabled={e.soon}
                        onClick={() => setSelected(e.key)}
                      >
                        <span className="catalog-tile__head">
                          <TileIcon entry={e} size="md" />
                          <span className="catalog-tile__name">{e.name}</span>
                        </span>
                        {e.soon ? (
                          <Chip icon="lock" className="catalog-tile__soon">
                            {t("connectors.soon")}
                          </Chip>
                        ) : (
                          <span className="catalog-tile__desc">{e.description}</span>
                        )}
                      </button>
                    </li>
                  ))}
                  <li>
                    <button
                      type="button"
                      className="catalog-tile catalog-tile--other"
                      aria-haspopup="dialog"
                      onClick={() => setSelected(OTHER)}
                    >
                      <span className="catalog-tile__head">
                        <span className="connector-icon connector-icon--mono" aria-hidden="true">
                          <Icon name="link" />
                        </span>
                        <span className="catalog-tile__name">{t("connectors.other")}</span>
                      </span>
                      <span className="catalog-tile__desc">{t("connectors.otherText")}</span>
                    </button>
                  </li>
                </ul>
                {composioOff && <p className="small muted catalog__note">{composioOff}</p>}
              </section>
            </>
          )}
        </div>
      </div>
      <ServiceDialog
        entry={current}
        other={selected === OTHER}
        onClose={() => setSelected(null)}
        onConnect={() => {
          setSelected(null);
          if (current) current.pick();
          else onOther();
        }}
      />
    </Dialog>
  );
}

/** A tile's icon; a green check on it when the service is connected. */
function TileIcon({ entry, size }: { entry: Entry; size: "md" | "lg" }) {
  return (
    <span className="catalog-icon">
      {entry.icon(size)}
      {entry.connected && (
        <span className="catalog-icon__check" aria-hidden="true">
          <Icon name="check" size={14} />
        </span>
      )}
    </span>
  );
}

const HOW_ICON: Record<HowKind, IconName> = {
  oneClick: "bolt",
  oauthOrKey: "bolt",
  key: "key",
  composio: "plug",
  appPassword: "lock",
  addressPassword: "lock",
};

/**
 * A service, over the catalog: the brand's pixel sky on top, its icon on the sky's edge, the name and what it
 * is; then what agents could do, how it connects and Conectar. Esc or × goes back to the catalog.
 */
function ServiceDialog({
  entry,
  other,
  onClose,
  onConnect,
}: {
  entry: Entry | null;
  /** "Não achou?": any service by its address. */
  other: boolean;
  onClose: () => void;
  onConnect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={other || !!entry}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      width={480}
      className="catalog-svc"
      title={entry ? entry.name : t("connectors.otherTitle")}
      description={entry ? entry.description : t("connectors.otherDetail")}
      leading={
        entry ? (
          <TileIcon entry={entry} size="lg" />
        ) : (
          <span className="connector-icon connector-icon--lg connector-icon--mono" aria-hidden="true">
            <Icon name="link" />
          </span>
        )
      }
      closeLabel={t("connectors.detail.close")}
    >
      <ConnectorSky brand={entry?.brandColor ?? null} />
      {entry ? <Detail entry={entry} onConnect={onConnect} /> : <OtherDetail onConnect={onConnect} />}
    </Dialog>
  );
}

/** What agents could do there, then how it connects and the button. */
function Detail({ entry, onConnect }: { entry: Entry; onConnect: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="catalog-svc__body">
        {entry.can.length > 0 && (
          <div className="catalog-svc__part">
            <h4 className="catalog-svc__h">{t("connectors.detail.can")}</h4>
            <ul className="catalog-svc__caps">
              {entry.can.map((c) => (
                <li key={c.text} className="ac-iconline" data-asks={c.asks || undefined}>
                  <Icon name={c.asks ? "shield" : "check"} size={14} />
                  <span>{c.text}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="catalog-svc__text">{entry.after}</p>
      </div>
      <div className="catalog-svc__act">
        <span className="catalog-svc__how ac-iconline" data-ok={entry.connected || undefined}>
          <Icon name={entry.connected ? "check" : HOW_ICON[entry.how]} size={14} />
          <span>{entry.connected ? t("connectors.detail.connected") : t(`connectors.how.${entry.how}`)}</span>
        </span>
        {entry.available ? (
          <Button
            variant="primary"
            aria-label={t(
              !entry.connected
                ? "connectors.connectName"
                : entry.again === "add"
                  ? "connectors.addAccountName"
                  : "connectors.reconnectName",
              { name: entry.name },
            )}
            onClick={onConnect}
          >
            {!entry.connected
              ? t("connectors.connectName", { name: entry.name })
              : entry.again === "add"
                ? t("connectors.detail.addAccount")
                : t("connectors.detail.reconnect")}
          </Button>
        ) : (
          <Button variant="primary" disabled>
            {t("connectors.soon")}
          </Button>
        )}
      </div>
    </>
  );
}

/** "Não achou?": any service by its address (a custom server), in plain words. */
function OtherDetail({ onConnect }: { onConnect: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="catalog-svc__body">
        <div className="catalog-svc__part">
          <h4 className="catalog-svc__h">{t("connectors.detail.how")}</h4>
          <ul className="catalog-svc__caps">
            {(["1", "2"] as const).map((n) => (
              <li key={n} className="ac-iconline">
                <Icon name="check" size={14} />
                <span>{t(`connectors.otherSteps.${n}`)}</span>
              </li>
            ))}
            <li className="ac-iconline" data-asks>
              <Icon name="shield" size={14} />
              <span>{t("connectors.otherSteps.ask")}</span>
            </li>
          </ul>
        </div>
      </div>
      <div className="catalog-svc__act">
        <Button variant="primary" onClick={onConnect}>
          {t("connectors.otherConnect")}
        </Button>
      </div>
    </>
  );
}
