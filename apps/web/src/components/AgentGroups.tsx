import type { Agent, AgentGroup } from "@agenteschat/client";
import { useAgentGroupAction, useRoles } from "@agenteschat/client";
import { groupOf, NO_GROUP } from "@agenteschat/client/lib/agent-groups";
import { errorText } from "@agenteschat/client/lib/errors";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  ditherUrl,
  Field,
  Icon,
  type IconName,
  Input,
  Locked,
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuSeparator,
} from "@agenteschat/ui";
import { type DragEvent, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import type { MenuEntry } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";
import { MenuEntries } from "./DesktopMenus";
import { useOrg } from "./org-context";
import "./roles/roles.css";

/** What Equipe's group dialog is for: a new group (with these agents in it), or renaming one. */
export type GroupDialogFor = { mode: "create"; agentIds?: string[] } | { mode: "rename"; group: AgentGroup };

/** "Novo setor" and "Editar setor" (ADR 0148): its name, color and icon. Mounted while open. */
export function GroupNameDialog({ purpose, onClose }: { purpose: GroupDialogFor; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useAgentGroupAction(org.id);
  const looks = useRoles(org.id).data;
  const renaming = purpose.mode === "rename" ? purpose.group : null;
  const [name, setName] = useState(renaming?.name ?? "");
  const [color, setColor] = useState(renaming?.color ?? "graphite");
  const [icon, setIcon] = useState(renaming?.icon ?? "person");
  const save = () => {
    const value = name.trim();
    if (!value) return;
    if (renaming && value === renaming.name && color === renaming.color && icon === renaming.icon) return onClose();
    action.mutate(
      renaming
        ? { type: "update", groupId: renaming.id, name: value, color, icon }
        : {
            type: "create",
            name: value,
            color,
            icon,
            agentIds: purpose.mode === "create" ? purpose.agentIds : undefined,
          },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={renaming ? t("agentGroups.renameTitle") : t("agentGroups.newGroup")}
      closeLabel={t("common.close")}
      width={440}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Locked when={action.isPending}>
          <DialogBody>
            <Field label={t("agentGroups.nameLabel")} id="agent-group-name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                autoComplete="off"
                autoFocus
                placeholder={t("agentGroups.namePlaceholder")}
              />
            </Field>
            {looks && (
              <div className="agent-group-look">
                <div className="roles-colors" role="radiogroup" aria-label={t("rolesPage.color")}>
                  {looks.colors.map((c) => (
                    // biome-ignore lint/a11y/useSemanticElements: a swatch button in a radio group
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={color === c}
                      aria-label={t("rolesPage.colorOf", { color: c })}
                      className="roles-color"
                      style={{ backgroundImage: `url("${ditherUrl(c as "graphite", 8)}")` }}
                      onClick={() => setColor(c)}
                    />
                  ))}
                </div>
                <div className="roles-icons" role="radiogroup" aria-label={t("rolesPage.icon")}>
                  {looks.icons.map((n) => (
                    // biome-ignore lint/a11y/useSemanticElements: an icon button in a radio group
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={icon === n}
                      aria-label={n}
                      className="roles-iconpick"
                      onClick={() => setIcon(n)}
                    >
                      <Icon name={n as IconName} size={18} />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!name.trim() || action.isPending}
            loading={action.isPending}
          >
            {renaming ? t("common.save") : t("agentGroups.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** "Excluir o grupo X?": its agents go back to Agentes. Mounted while open. */
export function DeleteGroupDialog({ group, onClose }: { group: AgentGroup; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useAgentGroupAction(org.id);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("agentGroups.deleteTitle", { name: group.name })}
      description={group.agentIds.length > 0 ? t("agentGroups.deleteText") : undefined}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button type="button" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          loading={action.isPending}
          onClick={() => action.mutate({ type: "remove", groupId: group.id }, { onSuccess: onClose })}
        >
          {t("agentGroups.delete")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** A group at `index` among the `count` groups, and what its Editar and Excluir open. */
interface GroupChoices {
  group: AgentGroup;
  index: number;
  count: number;
  onRename: () => void;
  onDelete: () => void;
}

/** A group's choices (owners and admins): rename, move among the groups, delete. Its "…" and its header's right click. */
export function useGroupEntries() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useAgentGroupAction(org.id);
  return ({ group, index, count, onRename, onDelete }: GroupChoices): MenuEntry[] => {
    const move = (to: number) => action.mutate({ type: "update", groupId: group.id, index: to });
    return [
      { kind: "item", id: "rename", label: t("agentGroups.rename"), icon: "edit", run: onRename },
      ...(count > 1
        ? ([
            {
              kind: "item",
              id: "up",
              label: t("agentGroups.moveUp"),
              icon: "chevronUp",
              disabled: index === 0,
              run: () => move(index - 1),
            },
            {
              kind: "item",
              id: "down",
              label: t("agentGroups.moveDown"),
              icon: "chevronDown",
              disabled: index === count - 1,
              run: () => move(index + 1),
            },
          ] satisfies MenuEntry[])
        : []),
      { kind: "separator" },
      { kind: "item", id: "delete", label: t("agentGroups.delete"), icon: "trash", danger: true, run: onDelete },
    ];
  };
}

/** A group header's "…" (owners and admins), on Equipe and in the sidebar (`className`: the header's buttons). */
export function GroupMenu({ className, ...choices }: GroupChoices & { className?: string }) {
  const { t } = useTranslation();
  const entries = useGroupEntries();
  const label = t("agentGroups.options", { name: choices.group.name });
  return (
    <Menu
      align="end"
      label={label}
      trigger={<Button variant="ghost" size="sm" iconOnly icon="more" className={className} aria-label={label} />}
    >
      <MenuEntries entries={entries(choices)} />
    </Menu>
  );
}

/** An agent row's "…" (owners and admins): its group, a new group with it, its place inside its group. */
export function AgentGroupMenu({
  agent,
  groups,
  onNewGroup,
  children,
}: {
  agent: Agent;
  groups: AgentGroup[];
  onNewGroup: () => void;
  /** More of the row's choices after the setor's (Equipe › Lista: Responde a). */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useAgentGroupAction(org.id);
  const current = groupOf(groups, agent.id);
  const at = current ? current.agentIds.indexOf(agent.id) : -1;
  const label = t("agentGroups.options", { name: agent.name });
  const moveTo = (groupId: string | null, index?: number) =>
    action.mutate({ type: "move", agentId: agent.id, groupId, index });
  return (
    <Menu
      align="end"
      label={label}
      trigger={<Button variant="ghost" size="sm" iconOnly icon="more" aria-label={label} />}
    >
      <MenuRadioGroup
        label={t("agentGroups.group")}
        value={current?.id ?? NO_GROUP}
        onValueChange={(v) => {
          if (v !== (current?.id ?? NO_GROUP)) moveTo(v === NO_GROUP ? null : v);
        }}
        options={[
          { value: NO_GROUP, label: t("agentGroups.none") },
          ...groups.map((g) => ({ value: g.id, label: g.name })),
        ]}
      />
      <MenuItem icon="plus" onSelect={onNewGroup}>
        {t("agentGroups.newFromAgent")}
      </MenuItem>
      {current && current.agentIds.length > 1 && (
        <>
          <MenuSeparator />
          <MenuItem icon="chevronUp" disabled={at <= 0} onSelect={() => moveTo(current.id, at - 1)}>
            {t("agentGroups.moveUp")}
          </MenuItem>
          <MenuItem
            icon="chevronDown"
            disabled={at >= current.agentIds.length - 1}
            onSelect={() => moveTo(current.id, at + 1)}
          >
            {t("agentGroups.moveDown")}
          </MenuItem>
        </>
      )}
      {children && (
        <>
          <MenuSeparator />
          {children}
        </>
      )}
    </Menu>
  );
}

/** Firefox starts a drag only with some data set. */
const AGENT_DRAG = "application/x-agentes-agent";

/**
 * Moves an agent into a group (`null`: out of any), at `index` among its agents, and says so in a toast with Desfazer,
 * which puts it back where it was.
 */
export function useMoveAgent(groups: AgentGroup[]) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const action = useAgentGroupAction(org.id);
  return (agentId: string, groupId: string | null, index?: number) => {
    const from = groupOf(groups, agentId);
    const at = from?.agentIds.indexOf(agentId);
    const name = dir.agentById.get(agentId)?.name ?? "";
    const to = groups.find((g) => g.id === groupId);
    action.mutate(
      { type: "move", agentId, groupId, index },
      {
        onError: (e) => toast.show(errorText(t, e), "error"),
        onSuccess: (_groups, _action, result) => {
          if ((from?.id ?? null) === groupId) return;
          const pinAt = result && result.pinnedAt >= 0 ? result.pinnedAt : undefined;
          toast.show(
            to
              ? t("agentGroups.moved", { name, group: to.name })
              : t("agentGroups.movedOut", { name, group: from?.name ?? "" }),
            "info",
            {
              label: t("agentGroups.undo"),
              run: () => action.mutate({ type: "move", agentId, groupId: from?.id ?? null, index: at, pinAt }),
            },
          );
        },
      },
    );
  };
}

/**
 * Dragging agents between groups (Equipe and the sidebar's AGENTES, for who manages agents) (owners and admins): rows are draggable, groups take the drop.
 * Inside a group the row lands where the pointer is (`over.index`, before the first row whose middle is below it);
 * the agents in no group keep the workspace's order.
 */
export function useAgentDrag(groups: AgentGroup[]) {
  const move = useMoveAgent(groups);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ groupId: string | null; index: number } | null>(null);
  const rowsOf = (e: DragEvent<HTMLElement>) =>
    [...e.currentTarget.querySelectorAll<HTMLElement>("[data-agent-row]")].filter(
      (el) => el.dataset.agentRow !== dragging,
    );
  const indexAt = (e: DragEvent<HTMLElement>) => {
    const rows = rowsOf(e);
    const k = rows.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    return k < 0 ? rows.length : k;
  };
  // The server counts the place among all the group's agents in its own order: the ones pinned on top of it, the ones
  // not listed (not talking to me) and the person's sort would shift a place counted among the rows.
  const placeAt = (e: DragEvent<HTMLElement>, groupId: string) => {
    const ids = rowsOf(e).map((el) => el.dataset.agentRow ?? "");
    const k = indexAt(e);
    const order = (groups.find((g) => g.id === groupId)?.agentIds ?? []).filter((id) => id !== dragging);
    const before = order.indexOf(ids[k] ?? "");
    if (before >= 0) return before;
    const after = order.indexOf(ids[k - 1] ?? "");
    return after >= 0 ? after + 1 : order.length;
  };
  const end = () => {
    setDragging(null);
    setOver(null);
  };
  return {
    dragging,
    over,
    row: (agentId: string) => ({
      draggable: true,
      onDragStart: (e: DragEvent<HTMLElement>) => {
        e.dataTransfer.setData(AGENT_DRAG, agentId);
        e.dataTransfer.effectAllowed = "move";
        setDragging(agentId);
      },
      onDragEnd: end,
    }),
    zone: (groupId: string | null) => ({
      "data-drop": over?.groupId === groupId || undefined,
      onDragOver: (e: DragEvent<HTMLElement>) => {
        if (!dragging) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const index = groupId ? indexAt(e) : 0;
        if (over?.groupId !== groupId || over.index !== index) setOver({ groupId, index });
      },
      onDragLeave: (e: DragEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setOver((o) => (o?.groupId === groupId ? null : o));
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        if (!dragging) return;
        e.preventDefault();
        const agentId = dragging;
        const index = groupId ? placeAt(e, groupId) : undefined;
        end();
        const from = groupOf(groups, agentId);
        if ((from?.id ?? null) === groupId && (groupId === null || from?.agentIds.indexOf(agentId) === index)) return;
        move(agentId, groupId, index);
      },
    }),
  };
}
