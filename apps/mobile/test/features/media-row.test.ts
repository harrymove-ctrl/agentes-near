import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MEDIA_ROW, mediaRowAxis } from "../../src/ui/media-row";
import { readingMiddle } from "../../src/ui/type-scale";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

describe("MediaRow", () => {
  test("the web's numbers: a face of 32 in a card and 24 in a list, 12 and 8 from the name, 8 between what's under", () => {
    expect(MEDIA_ROW).toEqual({ card: { face: 32, gap: 12 }, row: { face: 24, gap: 8 }, under: 8 });
  });

  test("the name and what it is share one line beside the face; the rest goes under at the row's full width", () => {
    const row = src("ui/MediaRow.tsx");
    // One Text holds the name and the meta, so they wrap as words, never as two columns.
    // A quieter name (a step done or waiting) takes its tone at the text's own weight.
    expect(row).toMatch(
      /<Text variant="subhead" style=\{\[styles\.words, \{ paddingTop: axis\.words \}\]\}>\s*<Text variant="subhead" tone=\{quiet\} style=\{quiet \? undefined : styles\.name\}>/,
    );
    // The children come after the head's View, not inside it: under the face, not beside it.
    const head = row.indexOf("<View style={[styles.head, { gap }]}>");
    const close = row.indexOf("</View>", row.indexOf("{end}</View> : null}") + "{end}</View>".length);
    expect(head).toBeGreaterThan(0);
    expect(row.indexOf("{children}")).toBeGreaterThan(close);
    expect(row).toContain("row: { gap: MEDIA_ROW.under }");
  });

  test("a wrapped name keeps its first line on the face's middle, and what ends the line sits there too", () => {
    // Subhead (15 on 20) is read 11.2 down its line: beside a face of 32 the words come down, the face stays.
    const subhead = { middle: readingMiddle(15, 20) };
    expect(mediaRowAxis(32, subhead).face).toBe(0);
    expect(mediaRowAxis(32, subhead).words).toBeCloseTo(4.8);
    expect(mediaRowAxis(24, subhead).words).toBeCloseTo(0.8);
    // At a larger text size the line is read lower than a small face's middle: the face comes down instead.
    const large = { middle: readingMiddle(19.5, 26) };
    expect(mediaRowAxis(24, large).face).toBeCloseTo(large.middle - 12);
    expect(mediaRowAxis(24, large).words).toBe(0);
    const row = src("ui/MediaRow.tsx");
    expect(row).toContain('head: { flexDirection: "row", alignItems: "flex-start" }');
    expect(row).toContain("<View style={[styles.end, { height: side, marginTop: axis.face }]}>{end}</View>");
  });

  test("an agent's ask to show a board: its face and the ask on one line, who would see it and why under them, whole", () => {
    const parts = src("features/dashboards/parts.tsx");
    expect(parts).toMatch(
      /<MediaRow\s+size="row"\s+face=\{<AgentFace agentId=\{p\.agentId\} size=\{MEDIA_ROW\.row\.face\}/,
    );
    expect(parts).not.toContain("proposalTop");
    expect(parts).not.toContain("numberOfLines={3}");
  });

  test("Definir status' preview: what it is over the row, your face and name on one line, your status under them", () => {
    const screen = src("features/status/StatusScreen.tsx");
    expect(screen).toContain("<WithPresence size={MEDIA_ROW.card.face} presence={shown} ring={c.raised}>");
    expect(screen).toMatch(/name=\{name\}\s*>\s*<Text variant="small" tone="muted">/);
    expect(screen).toContain("preview: { gap: 8, paddingHorizontal: 16, paddingVertical: 14 },");
  });

  test("a grouped row with a lead and lines under its label: lead, label and end on one line, the rest under", () => {
    const grouped = src("ui/Grouped.tsx");
    expect(grouped).toContain("const flat = media && Boolean(icon || leading) && Boolean(sub || below || belowText);");
    // The head holds the lead, the label and what ends it; what was under the label goes under the head, whole width.
    expect(grouped).toMatch(
      /<View style=\{styles\.mediaHead\}>\s*\{lead\}\s*<View style=\{styles\.grow\}>\{labelText\}<\/View>\s*\{end\}\s*<\/View>\s*<View>\{under\}<\/View>/,
    );
    expect(grouped).toContain('media: { flexDirection: "column", alignItems: "stretch", gap: MEDIA_ROW.under }');
    expect(grouped).toContain('mediaHead: { flexDirection: "row", alignItems: "center", gap: 12 }');
  });

  test("release 13's rows, a lead beside three lines or more on the web, are media rows on the phone too", () => {
    const uses: [string, number][] = [
      // The computers' own rows are the devices list's now, a tree under each computer's portrait.
      ["features/settings/ComputersScreen.tsx", 1],
      ["features/settings/MachineScreen.tsx", 6],
      ["features/chats/ArchivedChannelsScreen.tsx", 1],
      ["features/routines/RoutineScreen.tsx", 1],
      ["features/members/MembersPage.tsx", 3],
      ["features/members/InviteLinkRows.tsx", 1],
      ["features/settings/RolesScreen.tsx", 7],
      ["features/vault/VaultScreen.tsx", 3],
      ["features/vault/parts.tsx", 3],
    ];
    for (const [file, count] of uses)
      expect([file, src(file).match(/^\s*media(: true,)?$/gm)?.length ?? 0]).toEqual([file, count]);
    // An invitation's or a suggestion's address wraps instead of ending in "…".
    const members = src("features/members/MembersPage.tsx");
    expect(members).toMatch(/label=\{inv\.email\}\s*labelLines=\{2\}/);
    expect(members).toMatch(/label=\{s\.email\}\s*labelLines=\{2\}/);
  });

  test("usage: an agent's API row and a plan account's head keep their mark on the name's line, the rest under", () => {
    const usage = src("features/usage/UsageScreen.tsx");
    expect(usage).toMatch(
      /<MediaRow\s+size="row"\s+face=\{<AgentFace agentId=\{a\.agentId\} size=\{MEDIA_ROW\.row\.face\}/,
    );
    expect(usage).toContain("api: { paddingVertical: 10 },");
    const parts = src("features/usage/parts.tsx");
    const head = parts.slice(parts.indexOf("export function AccountHead("), parts.indexOf("function Tag("));
    // Whose it is comes after the head's row, not in the logo's column.
    expect(head.indexOf("brandOf(account), whose, extra")).toBeGreaterThan(head.lastIndexOf("</View>\n      </View>"));
  });

  test("screens import it from the design system", () => {
    expect(src("ui/index.ts")).toContain('export { MediaRow, type MediaRowProps } from "./MediaRow";');
  });
});
