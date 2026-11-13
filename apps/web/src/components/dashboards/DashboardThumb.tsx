import type { DashboardSummary } from "@agenteschat/client";
import { useDarkTheme, widgetTileVars } from "@agenteschat/ui";
import { BOARD_COLUMNS } from "@agenteschat/ui/widgets/spec";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";

/**
 * A board's thumbnail on the Dashboards list (ADR 0135 §14): its first widgets as small tiles, each in the tones of
 * the agent that looks after it (the stroke and the 2px dither of its charts), as wide as the widget. An empty board
 * shows one dashed tile. Decorative: the card's title and line say what it is.
 */
export function DashboardThumb({ thumbs }: { thumbs: DashboardSummary["thumbs"] }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const dark = useDarkTheme();
  return (
    <span className="db-thumb" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${BOARD_COLUMNS}, 1fr)` }}>
      {thumbs.length === 0 ? (
        <i className="db-thumb__tile db-thumb__tile--empty" style={{ gridColumn: `span ${BOARD_COLUMNS}` }} />
      ) : (
        thumbs.map((thumb, i) => (
          <i
            // biome-ignore lint/suspicious/noArrayIndexKey: the first widgets in their order, never reordered here
            key={i}
            className="db-thumb__tile"
            style={{ gridColumn: `span ${thumb.w}`, ...widgetTileVars(colorOf(dir.anyAgent(thumb.agentId)), dark) }}
          />
        ))
      )}
    </span>
  );
}
