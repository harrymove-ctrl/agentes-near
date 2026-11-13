import { describe, expect, test } from "bun:test";
import { HELP_PAGES, type HelpSlug } from "../src/help";
import { helpEn } from "../src/help/pages.en";
import { helpPtBR } from "../src/help/pages.pt-BR";
import { en, ptBR } from "../src/index";
import { bannedIn, SELFHOST_BANNED } from "./edition-words";
import { leaves } from "./leaves";
import { type Locale, misplaced, staleLines } from "./setups";

const strings = (tree: unknown) => leaves(tree).filter((leaf): leaf is [string, string] => typeof leaf[1] === "string");

/** A help page's lines keyed by its edition, so the page's edition gates them: `help.<edition>.<slug>.<path>`. */
const helpLines = (tree: unknown) =>
  strings(tree).map(([key, text]): [string, string] => {
    const edition = HELP_PAGES[key.split(".")[0] as HelpSlug];
    return [`help.${edition === "both" ? "any" : edition}.${key}`, text];
  });

const TREES: Record<Locale, [string, string][]> = {
  en: [...strings(en), ...helpLines(helpEn)],
  "pt-BR": [...strings(ptBR), ...helpLines(helpPtBR)],
};

describe("words true in every setup", () => {
  for (const locale of ["en", "pt-BR"] as const) {
    test(`${locale}: a phrase true only somewhere sits in a key shown only there`, () => {
      expect(misplaced(TREES[locale], locale)).toEqual([]);
    });

    test(`${locale}: nobody says the cloud, the help pages included`, () => {
      expect(TREES[locale].filter(([, text]) => bannedIn(text, SELFHOST_BANNED).length > 0)).toEqual([]);
    });
  }

  test("every line of the registry still names a key", () => {
    const keys = [...TREES.en, ...TREES["pt-BR"]].map(([key]) => key);
    expect(staleLines(keys, "")).toEqual([]);
  });

  test("the probes: each phrase passes only under its condition", () => {
    expect(misplaced([["storage.text", "Your files stay in our storage"]], "en")).toHaveLength(1);
    expect(misplaced([["storage.agentesText", "Your files stay in our storage"]], "en")).toEqual([]);
    // Words a line keeps together with no-break spaces are the same phrase.
    expect(misplaced([["storage.text", "Something went wrong. We're on it."]], "en")).toHaveLength(1);
    expect(misplaced([["storage.agentesText", "This server"]], "en")).toHaveLength(1);
    expect(misplaced([["machines.download.text", "Install it on this Mac"]], "en")).toHaveLength(1);
    expect(misplaced([["machines.download.step1", "Install it on this Mac"]], "en")).toEqual([]);
    expect(misplaced([["machines.download.text", "Download the app for Mac"]], "en")).toHaveLength(1);
    expect(misplaced([["machines.download.text", "Baixar o app para Mac"]], "pt-BR")).toHaveLength(1);
    expect(misplaced([["machines.download.step1", "Download the app for Mac"]], "en")).toEqual([]);
    expect(misplaced([["onboarding.done.sent", "We emailed 2 invitations."]], "en")).toHaveLength(1);
    expect(misplaced([["onboarding.done.sent", "We'll email you."]], "en")).toHaveLength(1);
    expect(misplaced([["onboarding.done.invited_other", "We emailed 2 invitations."]], "en")).toEqual([]);
    expect(misplaced([["connectFlow.needsKey", "Connect with this server's API key."]], "en")).toEqual([]);
  });
});

test("the new-agent form asks for what the agent does, not a one-word role", () => {
  for (const help of [en.agent.roleHelp, ptBR.agent.roleHelp]) {
    expect(help).not.toMatch(/PM, Dev|One line|Uma linha/);
  }
});
