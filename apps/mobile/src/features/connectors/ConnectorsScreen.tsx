import {
  type ConnectorDef,
  useCatalog,
  useComposioUsage,
  useConnections,
  useCustomServers,
  useMailAccounts,
} from "@agenteschat/client";
import { composioOffText, composioUsageText, nearComposioLimit } from "@agenteschat/client/lib/composio";
import { type ConnectedItem, connectedItems, isMcpItem, itemName } from "@agenteschat/client/lib/connected";
import { settingsFrozen } from "@agenteschat/client/lib/deletion";
import { choiceOf, MAIL_BRANDS } from "@agenteschat/client/lib/mail";
import { can } from "@agenteschat/client/lib/permissions";
import { connectorDescription, connectorName } from "@agenteschat/client/lib/scopes";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useLocalSearchParams } from "expo-router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  Button,
  EmptyState,
  Filters,
  Icon,
  IconButton,
  LineIcon,
  Locked,
  PressScale,
  SearchField,
  SectionHeader,
  SkeletonList,
  Text,
  useReducedMotion,
} from "@/ui";
import { AgentFace } from "../shared/Face";
import { firstUseCopy } from "../shared/first-use";
import { useColors, useDirectory, useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { useSurface } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { openConnection } from "./ConnectionScreen";
import { ConnectorIcon } from "./ConnectorIcon";
import { AddressSheet, ConnectSheet, ServerSheet } from "./ConnectSheet";
import {
  CATEGORIES,
  connectionOf,
  galleryTiles,
  isHttpsUrl,
  SUGGESTED,
  searchConnectors,
  shownMailboxes,
  suggestionsOf,
} from "./logic";
import { MailboxSheet } from "./MailboxSheet";
import { openTools } from "./ToolsScreen";

/** The catalog row's mark; the text column starts after it, where its hairline does. */
const ROW_MARK = 36;
const ROW_SIDE = 16;
const ROW_GAP = 12;

/**
 * Conectores on the phone, the large title and the search of the system with "+" in the bar: what is connected as
 * a row of marks with a check (Adicionar as the dashed tile at its end), what waits on the person as one amber line
 * right under it, two suggestions as the app's cards with "Conectar" in words, then every service as a list (the
 * mark at 36, the name, one line of what it is, "Conectar" at the end), filtered by category; what isn't open yet
 * is left out rather than shown dead. A pasted address connects a server from the search itself. A service not
 * connected opens a sheet over the gallery with the flow in steps; a connection opens its own screen; a mailbox, of
 * any kind, opens a sheet of who uses it. A list people filter often: the rows don't each animate.
 */
export function ConnectorsScreen() {
  return (
    <SheetHostProvider>
      <Gallery />
    </SheetHostProvider>
  );
}

function Gallery() {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const sheet = useSheet();
  const catalog = useCatalog();
  const composio = useComposioUsage(orgId);
  const connections = useConnections(orgId);
  // Servers connected by address (a vendor's own, like Sentry's) come from their own list, as on the web.
  const servers = useCustomServers(orgId);
  // Mailboxes (ADR 0038): rows of what is connected; they connect on the web.
  const mailAccounts = useMailAccounts(orgId);
  const mailboxes = shownMailboxes(mailAccounts.data ?? []);
  const pull = usePullRefresh(async () => {
    await Promise.all([catalog.refetch(), connections.refetch(), servers.refetch(), mailAccounts.refetch()]);
  });
  // Connecting is for who manages connectors (the server checks it too). Being deleted, nothing connects, as on the
  // web: what is connected still opens.
  const frozen = settingsFrozen(org, "connectors");
  const admin = can(org, "manage_connectors") && !frozen;
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("all");
  const list = catalog.data?.connectors ?? [];
  const items = useMemo(
    () => connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []),
    [connections.data, servers.data, catalog.data],
  );
  const apps = items.filter((i) => !isMcpItem(i));
  const mcps = items.filter(isMcpItem);
  const connectedCount = items.length + mailboxes.length;
  const name = (d: ConnectorDef) => connectorName(t, d);
  const suggestions = useMemo(() => suggestionsOf(list, items, 2), [list, items]);
  const searching = q.trim().length > 0;
  const rest = useMemo(() => {
    const pool = searching ? list : list.filter((d) => !suggestions.includes(d));
    const inCat = cat === "all" ? pool : pool.filter((d) => d.category === cat);
    return searchConnectors(inCat, q, (d) => `${connectorName(t, d)} ${connectorDescription(t, d)}`);
  }, [list, suggestions, cat, q, searching, t]);
  const cats = CATEGORIES.filter((k) => list.some((d) => d.category === k));
  // What is already connected is in the row above; the list shows it only to a search. What can't be connected
  // yet isn't listed: a dead row teaches nothing.
  const rows = galleryTiles(rest, items).filter((x) => x.opens && (searching || !x.connected));
  // What waits on the person among the connected: a sign-in that stopped, tools that couldn't be read, tools to
  // decide (admins).
  const waiting = items.filter((i) => i.needsReconnect || i.toolsError || (admin && i.pending > 0));
  // Without Composio here, the services that connect only through it are left out: admins read why.
  const composioOff = admin ? composioOffText(t, list, SUGGESTED) : null;
  const open = (def: ConnectorDef) => {
    const existing = connectionOf(def, items);
    if (existing) openConnection(existing.id);
    else sheet.open(<ConnectSheet def={def} />);
  };
  // Connecting by an address: the one typed in the search when it is one.
  const openAddress = () => sheet.open(<AddressSheet {...(isHttpsUrl(q.trim()) ? { url: q.trim() } : {})} />);
  // A connection opens its own screen (a server connected by an address we don't know included).
  const openItem = (item: ConnectedItem) => openConnection(item.id);
  // From an agent's card in the chat (`?connect=<catalog id>` or `?mcp=<address>`, `?mcp=` alone: any address): the
  // same sheet the gallery opens, once the catalog is in.
  const { connected, connect, mcp } = useLocalSearchParams<{ connected?: string; connect?: string; mcp?: string }>();
  const offered = useRef(false);
  useEffect(() => {
    if (offered.current || (connect === undefined && mcp === undefined) || !catalog.data || !admin) return;
    offered.current = true;
    const def = connect ? catalog.data.connectors.find((d) => d.id === connect) : undefined;
    if (def) open(def);
    else sheet.open(<AddressSheet url={mcp || undefined} />);
  });
  // Back from a sign-in that finished on the link route (`?connected=<id>`): the confirmation, as the web shows
  // for the connection that just came in (admins; anyone else had the toast).
  const returned = useRef<string | null>(null);
  useEffect(() => {
    if (!connected || returned.current === connected || !connections.data || !servers.data || !catalog.data) return;
    returned.current = connected;
    const item = items.find((i) => i.id === connected);
    if (!item || !admin) return;
    sheet.open(
      item.def ? <ConnectSheet def={item.def} item={item} start="done" /> : <ServerSheet item={item} start="done" />,
    );
  }, [connected, connections.data, servers.data, catalog.data, items, admin, sheet]);

  return (
    <PushedLargeTitle
      title={t("mobile.connectors.title")}
      // Adding by an address lives in the bar, as every list's "+".
      {...(admin
        ? { right: <IconButton icon="plus" label={t("connectors.otherConnect")} onPress={openAddress} /> }
        : {})}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {composio.data && nearComposioLimit(composio.data) ? (
        <Text variant="small" tone="muted" style={styles.usage}>
          {composioUsageText(t, i18n.language, composio.data)}
        </Text>
      ) : null}
      <View style={styles.search}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder={t("mobile.connectors.search")}
          accessibilityLabel={t("mobile.connectors.search")}
          returnKeyType="search"
        />
      </View>
      {catalog.isLoading || connections.isLoading || servers.isLoading ? (
        // Loading: the rows' own shape, never a spinner.
        <SkeletonList rows={4} />
      ) : catalog.isError && !catalog.data ? (
        <View style={styles.center}>
          <Text tone="muted" style={styles.centerText}>
            {t("mobile.connectors.loadFailed")}
          </Text>
          <Button
            variant="secondary"
            size="sm"
            label={t("mobile.common.retry")}
            onPress={() => void catalog.refetch()}
          />
        </View>
      ) : (
        <>
          {/* A pasted address connects a server by it, from the search itself. */}
          {searching && admin && isHttpsUrl(q.trim()) ? <AddressRow url={q.trim()} onPress={openAddress} /> : null}
          {searching ? null : (
            <>
              {admin || connectedCount > 0 ? (
                <>
                  <SectionHeader
                    title={t("mobile.connectors.connected")}
                    {...(connectedCount > 0 ? { count: connectedCount } : {})}
                  />
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
                    {/* A connection made or removed while the row is in sight fades, and the others slide over. */}
                    <LayoutAnimationConfig skipEntering>
                      {/* Mailboxes first, as on the web, by their name ("Suporte"). */}
                      {mailboxes.map((a) => (
                        <MiniTile
                          key={a.id}
                          onPress={() => sheet.open(<MailboxSheet accountId={a.id} />)}
                          label={t("mobile.connectors.connectedCheck", { name: a.label })}
                        >
                          <ConnectorIcon def={MAIL_BRANDS[choiceOf(a)] ?? null} label={a.label} size={48} check />
                          <Text variant="caption" tone="muted" numberOfLines={1}>
                            {a.label}
                          </Text>
                        </MiniTile>
                      ))}
                      {/* Services, then servers connected by address (oldest first, as on the web). */}
                      {[...apps, ...mcps].map((item) => (
                        <ConnectedTile
                          key={item.id}
                          item={item}
                          review={admin && item.pending > 0}
                          fresh={item.id === connected}
                          onPress={() => openItem(item)}
                        />
                      ))}
                      {/* Adding comes after what is there: the row reads what is connected first. */}
                      {admin ? <AddTile onPress={() => sheet.open(<AddressSheet />)} /> : null}
                    </LayoutAnimationConfig>
                  </ScrollView>
                  {waiting.length > 0 ? (
                    <WaitLine
                      items={waiting}
                      admin={admin}
                      onOpen={(i) => (admin && i.pending > 0 ? openTools(i.id) : openItem(i))}
                    />
                  ) : null}
                </>
              ) : null}
              {connectedCount === 0 ? <EmptyHint acts={admin} /> : null}
            </>
          )}
          {!searching && suggestions.length > 0 ? (
            <>
              {/* A personal workspace's are suggested for its person, never "for Personal" (ADR 0159). */}
              <SectionHeader
                title={
                  isPersonal(org)
                    ? t("connectors.suggestedPersonal")
                    : t("mobile.connectors.suggested", { org: org?.name ?? "" })
                }
              />
              <Locked when={frozen} readable keepKeyboard style={styles.suggestions}>
                {suggestions.map((d) => (
                  <Suggestion
                    key={d.id}
                    mark={d}
                    name={name(d)}
                    text={connectorDescription(t, d)}
                    onPress={() => open(d)}
                  />
                ))}
              </Locked>
            </>
          ) : null}
          {searching ? null : <SectionHeader title={t("mobile.connectors.allServices")} count={rows.length} />}
          {cats.length > 1 ? (
            <View style={styles.filters}>
              <Filters
                items={[
                  { key: "all", label: t("mobile.connectors.all") },
                  ...cats.map((k) => ({ key: k, label: t(`connectors.category.${k}`) })),
                ]}
                value={cat}
                onChange={setCat}
              />
            </View>
          ) : null}
          {rows.length === 0 ? (
            <EmptyState
              size="inline"
              title={t("mobile.connectors.noResults")}
              action={
                admin ? (
                  <Button variant="secondary" size="sm" label={t("connectors.otherConnect")} onPress={openAddress} />
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    label={t("filters.clearSearch")}
                    onPress={() => {
                      setQ("");
                      setCat("all");
                    }}
                  />
                )
              }
            />
          ) : (
            <Locked when={frozen} readable keepKeyboard style={styles.list}>
              {rows.map(({ def: d, connected: isConnected }, i) => (
                <ServiceRow
                  key={d.id}
                  def={d}
                  name={name(d)}
                  text={connectorDescription(t, d)}
                  connected={isConnected}
                  divider={i > 0}
                  onPress={() => open(d)}
                />
              ))}
            </Locked>
          )}
          {composioOff ? (
            <Text variant="small" tone="muted" style={styles.note}>
              {composioOff}
            </Text>
          ) : null}
        </>
      )}
    </PushedLargeTitle>
  );
}

/**
 * Nothing connected yet: who would use it, in a line, with the real faces. No button: the catalog right under it is
 * the next step (who can't connect is told who does).
 */
function EmptyHint({ acts }: { acts: boolean }) {
  const { t } = useTranslation();
  const copy = firstUseCopy("connectors", acts);
  const c = useColors();
  const dir = useDirectory();
  const faces = dir.agents.slice(0, 3);
  return (
    <View style={[styles.empty, { borderColor: c.line }]}>
      <View style={styles.faces}>
        {faces.map((a, i) => (
          <View key={a.id} style={i > 0 ? styles.overlap : undefined}>
            <AgentFace agentId={a.id} size={34} live={false} />
          </View>
        ))}
      </View>
      <View style={styles.hintText}>
        <Text variant="body" style={styles.bold}>
          {t(copy.title)}
        </Text>
        <Text variant="small" tone="muted">
          {t(copy.text)}
        </Text>
      </View>
    </View>
  );
}

/**
 * What waits on the person, in one line under the connected row, in the waiting color: tools to decide ("2
 * ferramentas precisam de você · Serviço T"), a sign-in that stopped, tools that couldn't be read. The first
 * service names what, every one waiting is named after it. A tap opens where it is decided.
 */
function WaitLine({
  items,
  admin,
  onOpen,
}: {
  items: ConnectedItem[];
  admin: boolean;
  onOpen: (item: ConnectedItem) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const first = items[0];
  if (!first) return null;
  const what = first.needsReconnect
    ? t("connectors.composio.needsReconnect")
    : first.toolsError
      ? t("connectors.noToolsNow")
      : admin
        ? t("mobile.connectors.waitLine", { count: first.pending })
        : "";
  const names = items.map((i) => itemName(t, i)).join(", ");
  return (
    <Pressable
      onPress={() => onOpen(first)}
      accessibilityRole="button"
      accessibilityLabel={`${what} · ${names}`}
      style={({ pressed }) => [styles.wait, pressed && styles.pressed]}
    >
      <LineIcon variant="small" name="wait" size={16} color={c.amber} />
      <Text variant="small" numberOfLines={1} style={styles.grow}>
        <Text variant="small" style={[styles.bold, { color: c.amber }]}>
          {what}
        </Text>
        <Text variant="small" tone="muted">
          {` · ${names}`}
        </Text>
      </Text>
    </Pressable>
  );
}

/**
 * A connection in the row: its mark with the check, its name; when it waits on you (its sign-in stopped working, its
 * tools couldn't be read, or a server's new or unclear tools), the amber wait mark instead (the line under the row
 * says why, its screen too).
 */
function ConnectedTile({
  item,
  review,
  fresh = false,
  onPress,
}: {
  item: ConnectedItem;
  review: boolean;
  /** Just connected (back from its sign-in): it lands in the row once. */
  fresh?: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const reduced = useReducedMotion();
  // The rare moment of the gallery: what you just connected settles into the row (from 0.9 and half seen, ease-out).
  // No tap of its own: the way back from the sign-in already buzzed (`OAuthReturn`), one per connection. Reduced
  // motion: it is simply there.
  const land = useSharedValue(fresh && !reduced ? 0 : 1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the tile first shows
  useEffect(() => {
    if (fresh) land.set(withTiming(1, { duration: 360, easing: LAND }));
  }, []);
  const landed = useAnimatedStyle(() => ({
    opacity: 0.5 + land.get() * 0.5,
    transform: [{ translateY: (1 - land.get()) * 6 }, { scale: 0.9 + land.get() * 0.1 }],
  }));
  const name = itemName(t, item);
  const why = item.needsReconnect
    ? t("connectors.composio.needsReconnect")
    : item.toolsError
      ? t("connectors.noToolsNow")
      : review
        ? t("toolReview.decideTitle", { count: item.pending })
        : null;
  const waiting = why !== null;
  return (
    <MiniTile onPress={onPress} label={why ? `${name}, ${why}` : t("mobile.connectors.connectedCheck", { name })}>
      <Animated.View style={landed}>
        <ConnectorIcon def={item.def} image={item.image} label={name} size={48} check={!waiting} />
        {waiting ? (
          <View style={[styles.waitBadge, { backgroundColor: c.amber, borderColor: c.bg }]}>
            <Icon name="wait" size={12} color={c.bg} />
          </View>
        ) : null}
      </Animated.View>
      <Text variant="caption" tone="muted" numberOfLines={1}>
        {name}
      </Text>
    </MiniTile>
  );
}

/** A strong ease-out: what lands starts fast and settles. */
const LAND = Easing.bezier(0.23, 1, 0.32, 1);
const TILE_IN = FadeIn.duration(160);
const TILE_OUT = FadeOut.duration(120);
const TILE_SLIDE = LinearTransition.duration(220);

/**
 * A tile of the connected row: it gives under the finger (opening it is plain navigation, so no haptic), and it fades
 * in or out as a connection is made or removed while the row is in sight (none of it with reduced motion).
 */
function MiniTile({ onPress, label, children }: { onPress: () => void; label: string; children: ReactNode }) {
  const reduced = useReducedMotion();
  return (
    <Animated.View
      entering={reduced ? undefined : TILE_IN}
      exiting={reduced ? undefined : TILE_OUT}
      layout={reduced ? undefined : TILE_SLIDE}
    >
      <PressScale
        haptic={false}
        fill={false}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={styles.mini}
        contentStyle={styles.miniIn}
      >
        {children}
      </PressScale>
    </Animated.View>
  );
}

/** Searching with an address: connecting a server by it, one tap. */
function AddressRow({ url, onPress }: { url: string; onPress: () => void }) {
  const { t } = useTranslation();
  const surface = useSurface();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.card, styles.address, surface, pressed && styles.pressed]}
    >
      <View style={[styles.cardText, styles.addressText]}>
        <Text variant="body" numberOfLines={1} style={styles.bold}>
          {t("connectors.otherConnect")}
        </Text>
        <Text variant="small" tone="muted" numberOfLines={1}>
          {url}
        </Text>
      </View>
    </Pressable>
  );
}

/** The dashed tile at the end of the connected row: a server by its address. */
function AddTile({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <MiniTile onPress={onPress} label={t("connectors.otherConnect")}>
      <View style={[styles.addTile, { borderColor: c.line2 }]}>
        <Icon name="plus" size={20} color={c.muted} />
      </View>
      <Text variant="caption" tone="muted" numberOfLines={1}>
        {t("mobile.connectors.add")}
      </Text>
    </MiniTile>
  );
}

/** "Conectar" in words at a row's or a card's end: the whole row is the button, this is where the eye lands. */
function ConnectWord() {
  const { t } = useTranslation();
  return (
    <Text variant="subhead" tone="ink2" style={styles.bold}>
      {t("mobile.connectors.connect")}
    </Text>
  );
}

/** A suggestion: the app's card with the service's mark, its name, what it is and "Conectar" in words. */
function Suggestion({
  mark,
  name,
  text,
  onPress,
}: {
  mark: Pick<ConnectorDef, "iconUrl" | "brandColor"> | null;
  name: string;
  text: string;
  onPress: () => void;
}) {
  const surface = useSurface();
  return (
    <PressScale
      haptic={false}
      fill={false}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}. ${text}`}
      style={[styles.card, surface]}
      contentStyle={styles.cardIn}
    >
      <ConnectorIcon def={mark} label={name} size={40} />
      <View style={styles.grow}>
        <Text variant="body" numberOfLines={1} style={styles.bold}>
          {name}
        </Text>
        <Text variant="subhead" tone="muted" numberOfLines={2}>
          {text}
        </Text>
      </View>
      <ConnectWord />
    </PressScale>
  );
}

/** One service of the catalog: its mark at 36, its name, one line of what it is, "Conectar" (a check once it is). */
function ServiceRow({
  def,
  name,
  text,
  connected,
  divider,
  onPress,
}: {
  def: ConnectorDef;
  name: string;
  text: string;
  connected: boolean;
  divider: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}. ${text}`}
      style={({ pressed }) => [styles.service, pressed && { backgroundColor: c.sunken }]}
    >
      {divider ? <View style={[styles.serviceLine, { backgroundColor: c.line2 }]} /> : null}
      <ConnectorIcon def={def} label={name} size={ROW_MARK} check={connected} />
      <View style={styles.grow}>
        <Text variant="body" numberOfLines={1} style={styles.bold}>
          {name}
        </Text>
        <Text variant="subhead" tone="muted" numberOfLines={1}>
          {text}
        </Text>
      </View>
      {connected ? null : <ConnectWord />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: 16, paddingBottom: 6 },
  note: { paddingHorizontal: 16, paddingTop: 16 },
  usage: { paddingHorizontal: 16, paddingBottom: 8 },
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  centerText: { textAlign: "center" },
  row: { gap: 16, paddingHorizontal: 16, paddingBottom: 6 },
  mini: { width: 64 },
  miniIn: { alignItems: "center", gap: 6 },
  addTile: {
    width: 48,
    height: 48,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
  },
  // On the margin of 16, under the connected row: the icon on the line's first row of text.
  wait: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginHorizontal: 16, marginTop: 6 },
  // A column: the team's faces on top, then the line, its text and "Pelo endereço" (in a row the faces
  // took a third of the width and the text wrapped into a narrow block).
  empty: {
    gap: 10,
    marginHorizontal: 16,
    marginTop: 8,
    padding: 16,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
  },
  faces: { flexDirection: "row" },
  overlap: { marginLeft: -8 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  hintText: { gap: 2 },
  suggestions: { gap: 12, paddingHorizontal: 16 },
  filters: { paddingBottom: 4 },
  // The app's card with its cut corner (no hairline box), as every card standing on the page.
  card: { borderRadius: 20, borderBottomLeftRadius: 6 },
  cardIn: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16 },
  cardText: { flex: 1, minWidth: 0, paddingVertical: 12, paddingRight: 14 },
  pressed: { opacity: 0.85 },
  list: { paddingTop: 4 },
  service: {
    flexDirection: "row",
    alignItems: "center",
    gap: ROW_GAP,
    paddingHorizontal: ROW_SIDE,
    paddingVertical: 10,
    minHeight: 60,
  },
  // The hairline starts where the text does.
  serviceLine: {
    position: "absolute",
    top: 0,
    right: 0,
    left: ROW_SIDE + ROW_MARK + ROW_GAP,
    height: StyleSheet.hairlineWidth,
  },
  waitBadge: {
    position: "absolute",
    right: -4,
    bottom: -4,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  address: { marginHorizontal: 16, marginTop: 8, flexDirection: "row", alignItems: "center", overflow: "hidden" },
  addressText: { paddingLeft: 16 },
});
