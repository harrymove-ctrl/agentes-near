import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A file of the app, as text: where a reply's parts go lives in components the tests can't render. */
const source = (path: string) => readFileSync(join(import.meta.dir, "../../src/features/chat", path), "utf8");
/** Where each piece first shows in a file, in the order given. */
const at = (text: string, pieces: string[]) =>
  pieces.map((p) => {
    const i = text.indexOf(p);
    if (i < 0) throw new Error(`not found: ${p}`);
    return i;
  });
const ascending = (xs: number[]) => xs.every((x, i) => i === 0 || (xs[i - 1] ?? 0) < x);

describe("a reply's tools sit last", () => {
  test("saved: its words, what it changed and its cards, then its tools", () => {
    const row = source("MessageRow.tsx");
    expect(
      ascending(
        at(row, [
          "{openerPart}\n                    {words}\n                  </>\n                )}",
          "<Receipts message={m} onTap={onTap} onLongPress={press} />",
          "{cards}\n            {/* Its tools after",
          "<TurnTools",
          "<SavedTools",
          "<NoAiCard message={m} />",
          // The foot is the reply's last part: only the double tap's one-time hint and its 👍 over the row follow it.
          "{foot}\n          </RowPartContext.Provider>\n          {hintNode}\n        </View>\n        {popNode}\n      </Pressable>\n    </>\n  );\n});",
        ]),
      ),
    ).toBe(true);
    // The cards above the tools are an issue's and a mission's; the thread, the reactions and the send state go under.
    const [cardsAt, footAt, endAt] = at(row, ["const cards = (", "const foot = (", "\n  if (onRight) {"]);
    const cards = row.slice(cardsAt, footAt);
    const foot = row.slice(footAt, endAt);
    for (const card of ["<IssueWorkCard", "<MissionCard", "<PlanCard", "<ReviewCard", "<SetupFailedCard"])
      expect([card, cards.includes(card)]).toEqual([card, true]);
    for (const part of ["<ThreadLink", "<Reactions", "<Sending"])
      expect([part, foot.includes(part)]).toEqual([part, true]);
  });

  test("what waits for a person's click comes after the tools, the thread and reactions under it", () => {
    const row = source("MessageRow.tsx");
    const [toolsAt, footAt] = at(row, [
      "<SavedTools\n",
      "{foot}\n          </RowPartContext.Provider>\n          {hintNode}\n        </View>\n        {popNode}\n      </Pressable>\n    </>\n  );\n});",
    ]);
    const last = row.slice(toolsAt, footAt);
    for (const card of [
      "<NoAiCard",
      "<StretchCard",
      "<ProposalCard",
      "<InstructionProposals",
      "<ApprovalInline",
      "<HandoffCard",
      "<QuestionCard",
      "<SecretCard",
      "{missionDecision}",
    ])
      expect([card, last.includes(card)]).toEqual([card, true]);
  });

  test("live: none drawn, nor any of its words: the reply brings them whole", () => {
    const live = source("LiveRows.tsx");
    for (const part of ["<TurnTools", "<RevealText", "run.text"])
      expect([part, live.includes(part)]).toEqual([part, false]);
  });
});

describe("agents it asked first: one pair row right before the reply, never inside it", () => {
  test("saved: the row sits before the reply's own row (which then shows its face and name), none in its body", () => {
    const row = source("MessageRow.tsx");
    expect(ascending(at(row, ["const grouped = groupedIn && !pair;", "{pair}\n      {quote && !inBubble"]))).toBe(true);
    const [bodyAt, endAt] = at(row, [
      "<View style={[styles.body, { gap: rhythm.part }]}>",
      "{foot}\n          </RowPartContext.Provider>\n          {hintNode}\n        </View>\n        {popNode}\n      </Pressable>",
    ]);
    expect(row.slice(bodyAt, endAt)).not.toContain("Consult");
  });

  test("live: the working line carries the pair, the one asking and the one asked, while the turn works", () => {
    const live = source("LiveRows.tsx");
    expect(live).not.toContain("useRunConsults");
    expect(
      ascending(
        at(live, [
          "if (asking && e.consult === asking)",
          '<AgentFace agentId={e.id} size={18} mode="idle" />',
          '<AgentFace agentId={asking.to} size={18} mode="think" />',
        ]),
      ),
    ).toBe(true);
  });

  test("the row says no answer: only faces, names, a short word and the time", () => {
    const pair = source("ConsultGroup.tsx");
    expect(pair).not.toContain("previewOf");
    expect(pair).not.toContain(".answer");
    expect(pair).toContain('<Icon name="swap"');
  });

  test("a notice whose reply isn't here is the same row, not a card with the answer", () => {
    const line = source("EventLine.tsx");
    expect(line).toContain("items={[pairItemOf(consulted.consultation)]}");
    expect(source("cards.tsx")).not.toContain("Consultation");
  });

  test("an answer far below its question is the same row, never a line of words or a pill", () => {
    const line = source("EventLine.tsx");
    expect(line).toContain("items={[fold.consultation]}");
    expect(line).not.toContain("consultFarKey");
    expect(source("ConsultGroup.tsx")).not.toContain("TalkPill");
  });

  test("a hand-off by direct message is the same row on its reach line, left out of the reply's own row", () => {
    const reach = source("ReachLines.tsx");
    expect(reach).toMatch(
      /<ConsultPairRow\s+askerId=\{authorId\}\s+channelId=\{channelId\}\s+items=\{\[talk\]\}\s+inline\s/,
    );
    expect(reach).not.toContain("reach.see");
    // One older than the conversation's list goes back is loaded on its own, never the "Entregue ao" text.
    expect(source("ConsultGroup.tsx")).toContain(
      "useConsultationConversation(orgId, channelId, id && list.isSuccess && !listed ? id : null)",
    );
    const row = source("MessageRow.tsx");
    expect(row).toContain("const reached = useMemo(() => reachHandoffs(m.meta), [m.meta]);");
    expect(row).toContain("    consulted,\n    reached,\n  );");
  });
});

describe("an exchange between the same two agents", () => {
  test("is one row on its first asking run's reply, and one conversation when opened", () => {
    expect(source("ConsultGroup.tsx")).toContain("groupsByRun(asExchanges(list.data ?? []))");
    expect(source("ConsultGroup.tsx")).toContain("consultPair(items, now, askerId)");
    expect(source("ChatScreen.tsx")).toContain("asExchanges(consultData)");
    expect(source("ConsultationScreen.tsx")).toContain("useExchangeConversation(");
  });
});

describe("one call is its own line", () => {
  test("live, kept and saved replies and a single question to a teammate draw the line, not the block", () => {
    const tools = source("ToolCalls.tsx");
    expect(tools).toContain("const one = oneCall(items);");
    expect(tools).toContain("one={one}");
    expect(tools).toContain("const lone = savedOneLine(meta, onCard);");
    expect(tools).toContain("<Line line={{ ...only.line, detail }} color={color} onToggle={onToggle} />");
  });
});

describe("nothing more than the message shows", () => {
  test("a lone quick read draws no block; no block opens on nothing or says it used no tools", () => {
    const tools = source("ToolCalls.tsx");
    expect(tools).toContain("const now = quietWork(items) || (done && !showsActivity(org)) ? null : toolNow(items);");
    expect(tools).toContain("if (lone && lone.ms !== null && quietLine(lone)) return null;");
    expect(tools).toContain("const shown = compact ? workSteps(compact, onCard) : 0;");
    expect(tools).not.toContain("chat.work.none");
    expect(tools).not.toContain("chat.work.see");
  });
});

describe("what agents did under each reply: the person's own setting, off by default", () => {
  test("off, a done reply keeps only what it read and a saved one draws no block; the live block stays", () => {
    const tools = source("ToolCalls.tsx");
    // Done and off: no call is "now", so only the messages it read stay (the branch for a reply with no call).
    expect(tools).toContain("(done && !showsActivity(org)) ? null : toolNow(items);");
    expect(tools).toContain('const shown = done ? items.filter((i) => i.kind === "steer") : items;');
    expect(tools).toContain("if (!compact || shown === 0 || !showsActivity(org)) return null;");
    // The cards that carry content or wait for a person aren't the tools' and stay in the row.
    const row = source("MessageRow.tsx");
    expect(row).toContain("<SecretCard");
    // Where it browsed and its desktop are step summaries (no picture): activity, gated like the tools.
    expect(row).toContain("isAgent && m.author.id && !m.local && showsActivity(org)");
    expect(row.match(/showsActivity/g)?.length).toBe(2);
  });

  test("Você has the row and its page, and a secret request's card shows without its text", () => {
    const me = readFileSync(join(import.meta.dir, "../../src/features/me/MeScreen.tsx"), "utf8");
    expect(me).toContain('onPress={() => open("/me/activity")}');
    const route = readFileSync(join(import.meta.dir, "../../app/(app)/me/activity.tsx"), "utf8");
    expect(route).toContain("<ActivityPage />");
    expect(source("logic.ts")).toMatch(/hidesBody = [^;]*secretRequestOf\(m\.meta\)/);
  });
});

describe("what an agent changed reads in one line a row, whole in its sheet", () => {
  test("a receipt's sentence and each line under it are one line (the sheet says them whole); team checks wrap", () => {
    // No renderer for the phone's components in these tests: the line limits are read from the source.
    const receipts = source("Receipts.tsx");
    // The sentence, and the one line every line under it is drawn with (its files, what it does alone, who undid it).
    const sentence = receipts.slice(receipts.indexOf("function Sentence("), receipts.indexOf("function ChangesSheet("));
    expect(sentence).toContain("numberOfLines={1}");
    const under = receipts.slice(receipts.indexOf("const UnderLine = "), receipts.indexOf("function UndoneLine("));
    expect(under).toContain("numberOfLines={1}");
    for (const line of ["lines.files", "lines.own", "lines.undone"])
      expect(receipts).toContain(`<${line === "lines.undone" ? "UndoneLine" : "UnderLine"} text={${line}} />`);
    expect(receipts).toContain(
      "<ChangesSheet row={r} channelId={m.channelId} title={title} under={under} close={sheet.close} />",
    );
    expect(source("TeamChecks.tsx")).not.toContain("numberOfLines");
  });

  test("a receipt is its sentence alone: no Desfazer, no Refazer, no time left, no clock", () => {
    const receipts = source("Receipts.tsx");
    for (const gone of ['t("agentActions.undo")', "agentActions.redo", "useAgentActions", "setInterval"])
      expect(receipts).not.toContain(gone);
    expect(receipts).not.toContain("RowButton");
    expect(receipts).not.toContain("ACT_LINE");
    // One undone elsewhere stays as history.
    expect(receipts).toContain("struck={Boolean(a.undoneAt)}");
    expect(receipts).toContain(
      "{lines.undone ? <UndoneLine text={lines.undone} /> : r.refs ? null : <CopyHook action={a} />}",
    );
  });

  test("a team check's icon stays outside its action line: Abrir goes under the words, from their edge", () => {
    const checks = source("TeamChecks.tsx");
    expect(
      ascending(
        at(checks, [
          "<LineIcon name={ICONS[targetKind(target)]}",
          "<View style={[ACT_LINE.row, styles.line]}>",
          "<RowAction",
        ]),
      ),
    ).toBe(true);
    expect(checks).not.toContain("styles.one, ACT_LINE.row");
  });

  test("they wear the tool block's card (the face a step up, a hairline), never the sunken gray of a pressed row", () => {
    for (const file of ["Receipts.tsx", "TeamChecks.tsx"]) {
      const text = source(file);
      expect(text).not.toContain("sunken");
      expect(text).toMatch(/backgroundColor: (c|colors)\.raised, borderColor: (c|colors)\.line2/);
    }
  });
});

describe("a shared approval card with actions approved ahead", () => {
  test("each waiting item says it approves a future action; an approved one says when and can be canceled", () => {
    const cards = source("cards.tsx");
    // Each item of a shared card is drawn by its own component.
    const start = cards.indexOf("function ApprovalGroupItem(");
    const group = cards.slice(start, cards.indexOf("\nfunction ", start + 1));
    expect(group).toContain("<ApprovalAheadLine approval={a} />");
    expect(group).toContain('t("approval.ahead.scheduled"');
    expect(group).toContain("cancelAhead.cancel(a.id)");
  });
});

describe("a stretch's pause on the phone (ADR 0089)", () => {
  test("waiting, a waiting pill with Continue tinted; once someone let them go on, a decided pill: who and when", () => {
    const card = source("../ai/StretchCard.tsx");
    const [doneAt, waitAt] = at(card, ["if (continued) {", "<AskWaiting"]);
    const done = card.slice(doneAt, waitAt);
    expect(done).toContain("<AskDone");
    expect(done).toContain('t("stretchCard.continuedByYou", { time })');
    expect(done).not.toContain("EventPillAction");
    const waiting = card.slice(waitAt);
    expect(waiting).not.toContain("continued");
    expect(waiting).toContain("forMe={may}");
    expect(waiting).toMatch(/<EventPillAction\s+key="continue"\s+primary/);
    expect(card).not.toContain("<Button");
  });
});

describe("a plan account on the phone (IA e uso › Contas): a row that opens", () => {
  const screen = source("../usage/UsageScreen.tsx");

  test("closed: its mark, name, plan and owner, one meter for the fullest window, the alert; it says it opens", () => {
    const row = screen.slice(...at(screen, ["function AccountRow(", "function AgentShares("]));
    const head = row.slice(...at(row, ["<Pressable", "</Pressable>"]));
    expect(head).toContain("accessibilityState={{ expanded: open }}");
    expect(
      ascending(
        at(head, ["<ProviderLogo", "accountName(t, account)", "{owner}", "text.short(line.top)", "line.alert"]),
      ),
    ).toBe(true);
    // Near its limit it starts open; every other one starts closed.
    expect(row).toContain('useState(line != null && line.state !== "ok")');
    // Nothing of the open row is drawn while it is closed.
    expect(row.indexOf("{open ? (")).toBeGreaterThan(row.indexOf("</Pressable>"));
  });

  test("open: bars split by agent, then one list, then when it renews and how old, then the month, then the way to the AI accounts screen", () => {
    const row = screen.slice(...at(screen, ["function AccountRow(", "function AgentShares("]));
    const body = row.slice(row.indexOf("{open ? ("));
    expect(
      ascending(
        at(body, ["brandOf(account)", "usage={splitUsage(", "{list}", "usageViews.monthTokens", "mobile.ai.row"]),
      ),
    ).toBe(true);
    // The row already says where the plan stands: the meter doesn't say it again.
    expect(body).toMatch(/<PlanMeter\s+plain/);
    // Only its owner manages it, on the AI accounts screen.
    expect(body).toContain("account.mine && account.accountId ?");
    expect(row).not.toContain("account.agents.map");
    const list = screen.slice(...at(screen, ["function AgentShares(", "/** The API per agent:"]));
    // One line of words per agent, no column titles over them.
    expect(list).not.toContain("usageViews.thisMonth");
    expect(ascending(at(list, ["openAgentUsage(a.agentId)", "usageViews.moreAgents"]))).toBe(true);
    // "Usa agora" only for an agent using it now, never for the folded row.
    expect(list).toContain("shareFacts(t, i18n.language, window, a)");
    expect(list).toContain(
      "shareFacts(t, i18n.language, window, { share: shares.restShare, tokens: shares.restTokens })",
    );
    // The renewal moves under the list, once.
    const parts = source("../usage/parts.tsx");
    expect(
      ascending(at(parts, ["!children ? (", "{children}\n      {children && renews ?", "text.updated(usage.at)"])),
    ).toBe(true);
  });

  test("no budget on plans alone: the API per agent, its spend by kind and the default budget wait for the API", () => {
    expect(screen).toContain("const usesApi = useWorkspaceUsesApi(orgId);");
    expect(screen).toContain("{usesApi ? <ApiCard data={data} /> : null}");
    expect(screen).toContain('{view === "summary" && allowed && usesApi && report.data ? (');
    expect(screen).toContain('{view === "summary" && allowed && usesApi ? <DefaultBudgetCard /> : null}');
    expect(screen).toContain("useUsageReport(orgId, allowed && usesApi)");
  });
});

describe("an approval card's layout", () => {
  const cards = source("cards.tsx");
  const fn = (name: string) => {
    const start = cards.indexOf(`function ${name}(`);
    return cards.slice(start, cards.indexOf("\nfunction ", start + 1));
  };

  test("the buttons sit in one row (a grouped request's at its row's end), Aprovar, Aprovar sempre and its ⓘ on a grouped request, Recusar, and only buttons there: what it covers opens from the ⓘ, under them", () => {
    const rows: [string, string[]][] = [
      ["ApprovalAsk", ['variant="primary"', 't("mobile.approval.refuse")', "</View>"]],
      [
        "ApprovalGroupItem",
        [
          'variant="primary"',
          "<ApproveAlwaysButton",
          "{info.button}",
          't("mobile.approval.refuse")',
          "</View>",
          "{info.text}",
        ],
      ],
    ];
    for (const [name, pieces] of rows) {
      const card = fn(name);
      const row = card.slice(card.indexOf("<View style={styles.itemActs}>"));
      expect([name, ascending(at(row, pieces))]).toEqual([name, true]);
      // Never a wide button stretched beside the text: each its own width, left-aligned in the row.
      expect([name, row.slice(0, row.indexOf("</View>")).includes(" wide")]).toEqual([name, false]);
    }
    // One request's card has only the two: its "Aprovar sempre" is a switch in the request's sheet.
    const ask = fn("ApprovalAsk");
    expect(ask.slice(...at(ask, ["foot={", "</AskFoot>"]))).not.toContain("ApproveAlways");
    expect(cards).toContain('itemActs: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }');
    // A grouped request: its words and its buttons on one line while the words fit theirs, the buttons under the
    // words otherwise (the action line), its words whole and their code drawn as code.
    const item = fn("ApprovalGroupItem");
    expect(
      ascending(
        at(item, [
          "<View style={[ACT_LINE.row, styles.itemWrap]}>",
          "<View style={ACT_LINE.text}>",
          "<View style={styles.itemActs}>",
        ]),
      ),
    ).toBe(true);
    expect(item.slice(0, item.indexOf("<View style={styles.itemActs}>"))).not.toContain("numberOfLines");
    expect(item).toContain("<Spans inline={parseInline(detail)} />");
    expect(item).toContain("<Spans inline={parseInline(own.why)} />");
    // A run's head too.
    expect(fn("ApprovalGroupAsk")).toContain("<View style={[ACT_LINE.row, styles.itemWrap]}>");
    expect(cards).not.toContain("flexBasis: 160");
  });

  test("waiting requests of one kind in a row fold into one run: its head, Aprovar todos and Ver cada um", () => {
    const group = fn("ApprovalGroupAsk");
    for (const piece of [
      "approvalRuns(items)",
      't("approval.run.head"',
      't("approval.run.approve")',
      'label: t("approval.run.show")',
      "approveAlwaysAlso(items, a)",
    ])
      expect([piece, group.includes(piece)]).toEqual([piece, true]);
  });
});

describe("the secret card on the phone", () => {
  const card = source("SecretCard.tsx");

  test("people read its label: its internal name only binds the box", () => {
    expect(card.match(/\br\.name\b/g)).toHaveLength(1);
    expect(card).toContain("secretAad({ requestId: r.id, orgId, name: r.name, target: r.target })");
    expect(card).toContain("title: label");
    expect(card).toContain("accessibilityLabel={label}");
  });

  test("a refused send ends the card with the real reason and clears what was typed, unless only the computer is away", () => {
    const failed = card.slice(card.indexOf("const failed = async"), card.indexOf("const showNewer"));
    expect(failed.indexOf("secretRefusalKey(err)")).toBeLessThan(failed.indexOf("api.secrets.get(orgId, r.id)"));
    expect(failed).toContain("secretClosedBy(err, r, fresh)");
    expect(failed).toContain("done(closed)");
    expect(failed).toContain('t(fresh ? "secret.changed" : "secret.failed")');
    expect(card).toContain('if (!pending) setValue("");');
    expect(card).toContain('t("secret.seeNewer")');
  });

  test('the name line reads whole (never cut mid-sentence), its mark on the title\'s line, "Ver …" under the words, the deadline at the foot', () => {
    const asks = source("asks.tsx");
    const line = asks.slice(asks.indexOf("const line = well ? ("), asks.indexOf("const opened ="));
    // The title and the detail wrap whole ("Ver …" is one word on one line).
    expect(line.slice(0, line.indexOf("{more ?"))).not.toContain("numberOfLines");
    expect(line.slice(line.indexOf("{well.detail"), line.indexOf("{more ?"))).not.toContain("numberOfLines");
    expect(asks).toContain('lineTop: { flexDirection: "row", alignItems: "flex-start", gap: 10 }');
    // The detail spans the whole width under the title, and "Ver …" comes after it, on its edge: never a column
    // beside the words.
    expect(asks).toContain("lineDetail: { marginLeft: 30, marginTop: 1 }");
    expect(line.indexOf("{more ?")).toBeGreaterThan(line.indexOf("{well.detail"));
    expect(line.slice(line.indexOf("<View style={styles.lineTop}>"), line.indexOf("{well.detail"))).not.toContain(
      "lineMore",
    );
    expect(asks).toContain(
      'lineMore: { flexDirection: "row", alignItems: "center", gap: 3, alignSelf: "flex-start", marginLeft: 30',
    );
    // The agent's words and the detail are formatted text: code between backticks is drawn as code.
    expect(line).toContain("<Spans inline={parseInline(well.detail)} />");
    expect(asks).toContain("<Spans inline={parseInline(lead)} />");
    expect(asks).toContain("lineMark: { flexShrink: 0, width: 20, height: 20,");
    // The fuse and the time left under the decision, never on the card's top line.
    expect(asks).toContain('{waitsFor === "you" && expiry ? <View style={styles.expiryRow}>{expiry}</View> : null}');
    expect(asks).toContain('{waitsFor && waitsFor !== "you" ? (');
  });
});

describe("a JSON block", () => {
  const files = (path: string) => readFileSync(join(import.meta.dir, "../../src/features/files", path), "utf8");

  test("reads formatted and wrapped, the text as written one press away, copy taking what shows", () => {
    const card = source("CodeCard.tsx");
    expect(card).toContain("isJsonLang(lang) ? formatJson(text) : null");
    expect(card).toContain("<RawToggle on={raw} onPress={() => setRaw((r) => !r)} />");
    expect(card).toContain("<CopyButton text={code} />");
    expect(card).toMatch(/\{pretty \? \(\s*<View style=\{styles\.body\}>\s*<CodeText lines=\{shown\} wrap \/>/);
    // Keys apart from the strings, in the web's colors.
    expect(card).toContain('kind === "property"');
  });

  test("a JSON file opens formatted too", () => {
    const viewer = files("DocumentViewer.tsx");
    expect(viewer).toContain("json={isJsonFile(info.name, info.mime)}");
    expect(viewer).toContain('<CodeText lines={highlightCode(raw ? text.data : formatted, "json")} wrap />');
  });
});

describe("an agent's offer card is done for everyone once it's done", () => {
  test("the skill library is read whatever the viewer may do: only the button asks for managing agents", () => {
    const offer = readFileSync(join(import.meta.dir, "../../src/features/ai/OfferCard.tsx"), "utf8");
    const install = offer.slice(offer.indexOf("function InstallSkill("), offer.indexOf("\nfunction UpdateSkills("));
    expect(install).toContain("useSkills(orgId)");
    expect(install).toContain('action={may ? t("actionCard.install_skill.open") : null}');
    // Its screen's row turns what installs on for the agent that posted it, as on the web.
    expect(install).toContain("openedFromCard({ url: card.url, agentId })");
    expect(install).toContain("&agent=");
  });

  test("Instalar skill's route keeps the agent only when that agent's card opened it, for the card's own link", async () => {
    const { openedFromCard, routeAgent } = await import("../../src/features/settings/install-from-card");
    const link = "https://github.com/acme/skills/tree/main/excel";
    // A link from outside the app that names an agent: the screen turns nothing on for it.
    expect(routeAgent(link, "a-dev")).toBeUndefined();
    openedFromCard({ url: link, agentId: "a-dev" });
    expect(routeAgent(link, "a-dev")).toBe("a-dev");
    expect(routeAgent("https://github.com/evil/skills", "a-dev")).toBeUndefined();
    expect(routeAgent(link, "a-other")).toBeUndefined();
    expect(routeAgent(link, undefined)).toBeUndefined();
    // The route hands the screen only what `routeAgent` keeps.
    const route = readFileSync(join(import.meta.dir, "../../app/(app)/settings/skills/new.tsx"), "utf8");
    expect(route).toContain("<InstallSkillScreen initialUrl={url} forAgentId={routeAgent(url, agent)} />");
    // The screen sends it only on an install from the card's link with its row checked, never on a read.
    const screen = readFileSync(join(import.meta.dir, "../../src/features/settings/SkillsScreen.tsx"), "utf8");
    expect(screen).toContain(
      "input: list ? { url: link, list } : { url: link, ...(forAgent ? { forAgentId: forAgent } : {}) }",
    );
    expect(screen).toContain("forAgentId: sendFor(url)");
    // Its row only for a live agent the server would turn it on for: not archived or gone, never the right hand.
    expect(screen).toContain("const forAgent = forAgentId ? dir.agentById.get(forAgentId) : undefined;");
    expect(screen).toContain("const forName = forAgent && !isRightHand(forAgent) ? forAgent.name : undefined;");
    // What a pick replaces, as the server marks it: an installed skill, or a removed one.
    expect(screen).toContain('c.replaces === "removed" ? "skills.pickReplacesRemoved" : "skills.pickReplaces"');
    expect(screen).toContain("turnOn && cardLink !== undefined && link.trim() === cardLink ? forAgentId : undefined");
  });
});
