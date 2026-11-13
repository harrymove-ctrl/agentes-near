import type { SidebarSection } from "@agenteschat/client";
import { useSetSidebarOrder, useSidebarOrder } from "@agenteschat/client";
import { moveSection, sameOrder, sidebarSections } from "@agenteschat/client/lib/sidebar-items";
import { Icon } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type DragEvent, type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type MenuEntry, openContextMenu } from "@/lib/context-menu";

/**
 * A section's name as its header (or, for the tools, the dialog) says it. A personal workspace's channels are its
 * group conversations (ADR 0159).
 */
export const sectionName = (t: TFunction, id: SidebarSection, personal = false) =>
  id === "tools"
    ? t("shell.sidebarSetup.tools")
    : id === "channels"
      ? t(personal ? "shell.channelsPersonal" : "shell.channels")
      : id === "agents"
        ? t("shell.agents")
        : t("shell.directMessages");

const SECTION_DRAG = "application/x-agentes-section";

/**
 * The order of the sidebar's sections, the person's own in this workspace (`…/me/sidebar/order`): Move up / Move down
 * and Restore default order for a section's menus, and dragging a section by its grip. The default is the workspace's
 * mode's (`personal`: the agents first, ADR 0159).
 */
export function useSectionOrder(orgId: string, personal = false) {
  const { t } = useTranslation();
  const order = useSidebarOrder(orgId, personal);
  const save = useSetSidebarOrder(orgId, personal);
  const dragging = useRef<SidebarSection | null>(null);
  const [mark, setMark] = useState<{ id: SidebarSection; where: "before" | "after" } | null>(null);
  const defaults = sidebarSections(personal);
  const put = (next: SidebarSection[]) => {
    if (!sameOrder(next, order)) save.mutate(sameOrder(next, defaults) ? null : next);
  };

  const restore: MenuEntry = {
    kind: "item",
    id: "restore-order",
    label: t("contextMenu.restoreOrder"),
    icon: "undo",
    disabled: sameOrder(order, defaults),
    run: () => put([...defaults]),
  };
  const entries = (id: SidebarSection): MenuEntry[] => {
    const i = order.indexOf(id);
    return [
      {
        kind: "item",
        id: "move-up",
        label: t("contextMenu.moveUp"),
        icon: "chevronUp",
        disabled: i <= 0,
        run: () => put(moveSection(order, id, -1)),
      },
      {
        kind: "item",
        id: "move-down",
        label: t("contextMenu.moveDown"),
        icon: "chevronDown",
        disabled: i >= order.length - 1,
        run: () => put(moveSection(order, id, 1)),
      },
      restore,
    ];
  };

  const end = () => {
    dragging.current = null;
    setMark(null);
  };
  /** A section's own box: it takes a dragged section before or after it. */
  const block = (id: SidebarSection, children: ReactNode, grip = true) => (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target for a dragged section; the grip's menu and the headers' menus are the keyboard way
    <div
      key={id}
      className="sidebar__block"
      data-section={id}
      data-drop={mark?.id === id ? mark.where : undefined}
      onDragOver={(e: DragEvent) => {
        const from = dragging.current;
        if (!from || from === id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const r = e.currentTarget.getBoundingClientRect();
        const where = e.clientY > r.top + r.height / 2 ? "after" : "before";
        if (mark?.id !== id || mark.where !== where) setMark({ id, where });
      }}
      onDrop={(e: DragEvent) => {
        const from = dragging.current;
        const m = mark;
        end();
        if (!from || !m) return;
        e.preventDefault();
        const rest = order.filter((s) => s !== from);
        rest.splice(rest.indexOf(m.id) + (m.where === "after" ? 1 : 0), 0, from);
        put(rest);
      }}
    >
      {grip && (
        <button
          type="button"
          className="sidebar__grip"
          draggable
          aria-label={t("shell.sidebarSetup.moveSection", { name: sectionName(t, id, personal) })}
          title={t("shell.sidebarSetup.moveSection", { name: sectionName(t, id, personal) })}
          onDragStart={(e) => {
            dragging.current = id;
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData(SECTION_DRAG, id);
            // The ghost is the section's header row, not a long list over the others; the tools have no header, so all
            // of them, which is what moves.
            const head = e.currentTarget.parentElement?.querySelector<HTMLElement>(
              ".sidebar__tools, .sidebar__section-head",
            );
            if (head) {
              const r = head.getBoundingClientRect();
              e.dataTransfer.setDragImage(head, Math.max(0, e.clientX - r.left), Math.max(0, e.clientY - r.top));
            }
          }}
          onDragEnd={end}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openContextMenu(r.right, r.bottom, [
              { kind: "header", label: sectionName(t, id, personal) },
              ...entries(id),
            ]);
          }}
        >
          <Icon name="grip" size={14} />
        </button>
      )}
      {children}
    </div>
  );

  return { order, entries, restore, block, put };
}
