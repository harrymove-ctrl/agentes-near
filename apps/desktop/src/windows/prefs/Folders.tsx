import { ALL_AGENTS, type RunnerFolderGrant } from "@agenteschat/adapters/machine-protocol";
import { Button, Checkbox, Dialog, DialogFooter, Icon, Popover, Segmented } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost, useSnapshot, useStore } from "../../app";
import { ControlError } from "../../control/client";
import { type Home, orgName, pairedHomes } from "../../control/store";
import { usePending } from "../../hooks";
import { AgentFace, HelpLink, OrgTile } from "../../ui/bits";
import { PrefCard, PrefHead, PrefRow } from "../../ui/settings";
import { useToast } from "../../ui/Toast";
import { baseName, listNames, shortPath } from "../../ui/time";

export function Folders() {
  const { t } = useTranslation();
  const host = useHost();
  const store = useStore();
  const snap = useSnapshot();
  const toast = useToast();
  const homes = pairedHomes(snap);
  const [picked, setPicked] = useState<string | null>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [removing, setRemoving] = useState<RunnerFolderGrant | null>(null);
  const [pending, run] = usePending<"add" | "remove">();
  const home = homes.find((h) => h.homeId === picked) ?? homes[0];

  // Preferences shows this tab only while an organization's agents work here: no empty state of its own.
  if (!home) return <PrefHead title={t("desktop.prefs.folders.title")} lead={t("desktop.prefs.folders.lead")} />;

  // The shared folder (ADR 0115) is every agent's, always: nothing to choose here.
  const folders = (home.access?.folders ?? []).filter((f) => !f.agents.includes(ALL_AGENTS));
  const org = orgName(home);

  const add = async () => {
    const path = await host.pickFolder().catch(() => null);
    if (!path) return;
    try {
      await store.request(home.homeId, { type: "folders.add", path, agents: [] });
      toast(t("desktop.prefs.folders.added", { folder: baseName(path) }), "drive");
      setOpenFor(path);
    } catch (err) {
      toast(
        err instanceof ControlError && err.code === "invalid_path"
          ? t("desktop.prefs.folders.invalid")
          : t("desktop.common.error"),
        "alert",
      );
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      await store.request(home.homeId, { type: "folders.remove", path: removing.path });
      toast(t("desktop.prefs.folders.removed"));
    } catch {
      toast(t("desktop.common.error"), "alert");
    }
    setRemoving(null);
  };

  return (
    <>
      <PrefHead
        title={t("desktop.prefs.folders.title")}
        lead={t("desktop.prefs.folders.lead")}
        action={
          <Button variant="primary" icon="plus" loading={pending === "add"} onClick={() => void run("add", add)}>
            {t("desktop.prefs.folders.add")}
          </Button>
        }
      />
      {homes.length > 1 && (
        <div className="dk-orgpick">
          <Segmented
            label={t("desktop.prefs.folders.org")}
            value={home.homeId}
            onValueChange={(id) => {
              setPicked(id);
              setOpenFor(null);
            }}
            options={homes.map((h) => ({
              value: h.homeId,
              label: orgName(h),
              mark: <OrgTile logo={h.logo} size="sm" />,
            }))}
          />
        </div>
      )}
      <PrefCard>
        {folders.length === 0 && (
          <PrefRow title={t("desktop.prefs.folders.noneTitle", { org })} desc={t("desktop.prefs.folders.noneBody")} />
        )}
        {folders.map((f) => (
          <FolderRow
            key={f.path}
            home={home}
            folder={f}
            open={openFor === f.path}
            onOpenChange={(o) => setOpenFor(o ? f.path : null)}
            onRemove={() => setRemoving(f)}
          />
        ))}
      </PrefCard>
      <p className="dk-help dk-under-card">
        <HelpLink slug="computers" section="folders">
          {t("desktop.prefs.folders.how")}
        </HelpLink>
      </p>

      <Dialog
        open={!!removing}
        onOpenChange={(o) => !o && pending !== "remove" && setRemoving(null)}
        title={t("desktop.prefs.folders.removeTitle", { folder: removing ? baseName(removing.path) : "" })}
        description={t("desktop.prefs.folders.removeBody")}
        closeLabel={t("desktop.common.close")}
        width={440}
      >
        <DialogFooter bar>
          <Button variant="ghost" disabled={pending === "remove"} onClick={() => setRemoving(null)}>
            {t("desktop.common.cancel")}
          </Button>
          <Button variant="danger" loading={pending === "remove"} onClick={() => void run("remove", remove)}>
            {t("desktop.common.remove")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

function FolderRow({
  home,
  folder,
  open,
  onOpenChange,
  onRemove,
}: {
  home: Home;
  folder: RunnerFolderGrant;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemove: () => void;
}) {
  const { t, i18n } = useTranslation();
  const store = useStore();
  const toast = useToast();
  const agents = home.status?.agents ?? [];
  const name = baseName(folder.path);
  const using = agents.filter((a) => folder.agents.includes(a.id));
  // Each change sends the whole list: the next waits for the one before it.
  const [pending, run] = usePending<"agents">();

  const toggle = async (agentId: string, on: boolean) => {
    const next = on ? [...new Set([...folder.agents, agentId])] : folder.agents.filter((id) => id !== agentId);
    try {
      await store.request(home.homeId, { type: "folders.setAgents", path: folder.path, agents: next });
    } catch {
      toast(t("desktop.common.error"), "alert");
    }
  };

  return (
    <PrefRow
      top
      lead={
        <span className="dk-logo dk-logo--soft">
          <Icon name="drive" size={16} />
        </span>
      }
      title={name}
      desc={
        <>
          <span className="dk-path">{shortPath(folder.path)}</span>
          <span className="dk-crow__line">
            {using.length > 0 ? (
              <>
                <span className="dk-avs">
                  {using.map((a) => (
                    <AgentFace key={a.id} agent={a} size="xs" />
                  ))}
                </span>
                {listNames(
                  using.map((a) => a.name),
                  i18n.language,
                )}
              </>
            ) : (
              <span className="dk-faint">{t("desktop.prefs.folders.noAgents")}</span>
            )}
          </span>
        </>
      }
      end={
        <>
          <Popover
            label={t("desktop.prefs.folders.whoUses", { folder: name })}
            side="bottom"
            align="end"
            open={open}
            onOpenChange={onOpenChange}
            trigger={
              <Button size="sm" icon="members">
                {t("desktop.prefs.folders.agents")}
              </Button>
            }
          >
            <div className="dk-drop">
              <div className="dk-drop__cap">{t("desktop.prefs.folders.whoUses", { folder: name })}</div>
              {agents.length === 0 && (
                <p className="dk-help dk-drop__empty">{t("desktop.prefs.folders.noOrgAgents")}</p>
              )}
              {agents.map((a) => {
                const id = `fa-${home.homeId}-${a.id}-${name}`.replace(/[^\w-]/g, "");
                return (
                  <label key={a.id} htmlFor={id} className="dk-drop__row">
                    <Checkbox
                      id={id}
                      checked={folder.agents.includes(a.id)}
                      disabled={pending !== null}
                      onCheckedChange={(on) => void run("agents", () => toggle(a.id, on))}
                    />
                    <AgentFace agent={a} size="xs" />
                    <b>{a.name}</b>
                  </label>
                );
              })}
            </div>
          </Popover>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="close"
            aria-label={t("desktop.prefs.folders.removeLabel", { folder: name })}
            onClick={onRemove}
          />
        </>
      }
    />
  );
}
