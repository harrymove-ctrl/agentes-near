import type { AccessTool } from "@agenteschat/client";
import { type AccessResource, type LevelState, toolsAt } from "@agenteschat/client/lib/access-levels";
import type { ConnectedItem } from "@agenteschat/client/lib/connected";
import { humanize } from "@agenteschat/client/lib/custom-tools";
import { labelIsName } from "@agenteschat/client/lib/tool-labels";
import { partsOf, type ReviewTool, reviewTool, toolName } from "@agenteschat/client/lib/tool-review";
import { Button, DetailsDialog, GroupHeading, Icon } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ResourceIcon, resourceName } from "@/components/AccessLevels";
import { ToolLevelsView } from "@/components/ToolReview";

/**
 * What an agent can use, per connector, in the tool review's read-only view
 * (subjects, pixel strips, each tool's level). Never a paragraph of tool
 * names: the agent page says how many actions ask for approval and "Ver"
 * opens this.
 */
export interface AgentConnectorTools {
  resource: AccessResource;
  name: string;
  tools: ReviewTool[];
  asks: number;
}

function fromAccessTool(t: TFunction, r: AccessResource, tool: AccessTool): ReviewTool {
  const parts = partsOf(tool.name, r.connector && !r.custom ? r.connector : null);
  const level = tool.sensitive ? "approval" : tool.readOnly ? "read" : "write";
  return {
    name: tool.name,
    label: r.custom && !labelIsName(tool.label ?? "", tool.name) ? (tool.label ?? "") : toolName(t, parts, tool.name),
    description: tool.description,
    subject: parts.subject,
    level,
    suggested: level,
    reason: null,
    sensitive: tool.sensitive,
    pending: false,
    savedLabel: tool.label || humanize(tool.name),
  };
}

/** The tools each connector gives the agent at its level (sensitive ones included: they ask). */
export function agentConnectorTools(
  t: TFunction,
  connectors: AccessResource[],
  levels: Record<string, LevelState>,
  items: Map<string, ConnectedItem>,
): AgentConnectorTools[] {
  return connectors.map((r) => {
    const granted = toolsAt(r, levels[r.id] ?? "none");
    const server = r.connectionId ? items.get(r.connectionId)?.server : null;
    const tools = granted.map((at) => {
      // A server by address: its reviewed tool (readable name, subject, level) when we find it.
      const st = server?.tools.find((x) => at.name === x.name || at.name.endsWith(`_${x.name}`));
      if (st) {
        const rt = reviewTool(t, st);
        return at.sensitive && rt.level !== "approval" && rt.level !== "off"
          ? { ...rt, level: "approval" as const }
          : rt;
      }
      return fromAccessTool(t, r, at);
    });
    return {
      resource: r,
      name: resourceName(t, r, items),
      tools,
      asks: tools.filter((x) => x.level === "approval").length,
    };
  });
}

/**
 * One line under "Pode usar": the lock on the first line, how many actions
 * ask for approval, and "Ver" (the read-only review per connector).
 */
export function AgentAsksLine({
  agentName,
  groups,
  items,
  canChange,
  onChange,
}: {
  agentName: string;
  groups: AgentConnectorTools[];
  items: Map<string, ConnectedItem>;
  canChange: boolean;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const total = groups.reduce((a, g) => a + g.asks, 0);
  if (total === 0) return null;
  const shown = groups.filter((g) => g.tools.length > 0);
  return (
    <>
      <p className="small muted agp-asks ac-iconline">
        <Icon name="lock" size={14} />
        <span className="agp-asks__t">
          {t("toolReview.asks", { count: total })}{" "}
          <button
            type="button"
            className="agp-asks__see"
            aria-label={t("toolReview.seeAsks")}
            onClick={() => setOpen(true)}
          >
            {t("toolReview.see")}
          </button>
        </span>
      </p>
      <DetailsDialog
        open={open}
        onOpenChange={setOpen}
        title={t("toolReview.agentTitle", { name: agentName })}
        subtitle={t("toolReview.agentSub")}
        closeLabel={t("common.close")}
        actions={
          canChange ? (
            <Button
              size="sm"
              variant="ghost"
              icon="edit"
              onClick={() => {
                setOpen(false);
                onChange();
              }}
            >
              {t("agentPage.overview.changeAccess")}
            </Button>
          ) : null
        }
      >
        <div className="agp-tools">
          {shown.map((g) => (
            <section key={g.resource.id} className="agp-tools__conn" aria-label={g.name}>
              <GroupHeading
                level={3}
                title={
                  <>
                    <ResourceIcon resource={g.resource} items={items} name={g.name} />
                    {g.name}
                  </>
                }
                aside={g.asks > 0 && t("toolReview.many.approval", { count: g.asks })}
              />
              <ToolLevelsView tools={g.tools} />
            </section>
          ))}
        </div>
      </DetailsDialog>
    </>
  );
}
