/**
 * Preferences: General, Servers and Updates always; while agents work on this computer, its own tabs too
 * (Folders, Tools, Activity, Advanced). Everything about this computer acts through the runners; nothing is
 * granted from the site.
 */
import { CLOUD_SERVER } from "@agenteschat/client/lib/server";
import { CountChip, Icon, type IconName } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost, useSnapshot } from "../app";
import { serverName } from "../control/server";
import { pairedHomes } from "../control/store";
import { macStateOf } from "../control/tray";
import { readPref, useOnShown, useUpdateCheck, writePref } from "../hooks";
import { BrandFace, MacPortrait } from "../ui/bits";
import { Activity } from "./prefs/Activity";
import { Advanced } from "./prefs/Advanced";
import { Folders } from "./prefs/Folders";
import { General } from "./prefs/General";
import { Servers } from "./prefs/Servers";
import { Tools } from "./prefs/Tools";
import { Updates } from "./prefs/Updates";

export type PrefTab = "general" | "servers" | "folders" | "tools" | "activity" | "advanced" | "updates";
type Tab = { id: PrefTab; icon: IconName };
const APP_TABS: Tab[] = [
  { id: "general", icon: "settings" },
  { id: "servers", icon: "globe" },
];
/** This computer's own tabs, only while agents work here. */
const DEVICE_TABS: Tab[] = [
  { id: "folders", icon: "drive" },
  { id: "tools", icon: "code" },
  { id: "activity", icon: "list" },
  { id: "advanced", icon: "preference" },
];
const UPDATE_TAB: Tab = { id: "updates", icon: "download" };
const isTab = (v: unknown): v is PrefTab => [...APP_TABS, ...DEVICE_TABS, UPDATE_TAB].some((t) => t.id === v);

export function Prefs() {
  const { t } = useTranslation();
  const host = useHost();
  const snap = useSnapshot();
  const update = useUpdateCheck(false);
  const [tab, setTab] = useState<PrefTab>(() => {
    const asked = readPref<string | null>("prefsTab", null);
    return isTab(asked) ? asked : "general";
  });
  const [current, setCurrent] = useState<string | null>(null);

  // The popover can ask for a tab ("See what's new", "Manage servers…").
  useOnShown("prefs", () => {
    const asked = readPref<string | null>("prefsTab", null);
    if (isTab(asked)) setTab(asked);
    writePref("prefsTab", null);
    void update.check();
  });
  useEffect(() => {
    void host
      .servers()
      .then((l) => setCurrent(l.current))
      .catch(() => {});
  }, [host]);

  const homes = pairedHomes(snap);
  const works = homes.length > 0;
  const machine = homes.find((h) => h.status?.machine)?.status?.machine?.name ?? "agentes.chat";
  const folderCount = homes.reduce((n, h) => n + (h.access?.folders.length ?? 0), 0);
  // A tab of this computer asked for while no agents work here: General instead.
  const shown: PrefTab = works || !DEVICE_TABS.some((d) => d.id === tab) ? tab : "general";

  const navButton = ({ id, icon }: Tab) => (
    <button key={id} type="button" aria-current={shown === id ? "page" : undefined} onClick={() => setTab(id)}>
      <Icon name={icon} size={16} />
      {t(`desktop.prefs.nav.${id}`)}
      {id === "folders" && folderCount > 0 && <CountChip size="sm">{folderCount}</CountChip>}
      {id === "updates" && (update.state.available || update.state.required) && (
        <span className="dk-pnav__badge">
          <Icon name="download" size={14} />
        </span>
      )}
    </button>
  );

  return (
    <div className="dk-prefs">
      <nav className="dk-pnav" aria-label={t("desktop.prefs.nav.label")}>
        <div className="dk-pnav__who">
          {works ? <MacPortrait state={macStateOf(homes)} /> : <BrandFace size="md" />}
          <span className="dk-pnav__whotext">
            <b>{works ? machine : "agentes.chat"}</b>
            <small>
              {works
                ? t("desktop.orgCount", { count: homes.length })
                : current === CLOUD_SERVER
                  ? t("desktop.servers.cloudSub")
                  : current && serverName(current)}
            </small>
          </span>
        </div>
        {APP_TABS.map(navButton)}
        {works && (
          <>
            <span className="dk-pnav__group">{t("desktop.prefs.nav.thisDevice")}</span>
            {DEVICE_TABS.map(navButton)}
          </>
        )}
        {navButton(UPDATE_TAB)}
      </nav>
      <main className="dk-pbody" key={shown}>
        {shown === "general" && <General />}
        {shown === "servers" && <Servers />}
        {shown === "folders" && <Folders />}
        {shown === "tools" && <Tools />}
        {shown === "updates" && <Updates update={update} />}
        {shown === "activity" && <Activity />}
        {shown === "advanced" && <Advanced />}
      </main>
    </div>
  );
}
