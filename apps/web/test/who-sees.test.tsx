import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, type Channel } from "@agenteschat/client";
import { joinable } from "@agenteschat/client/lib/channel-access";
import { audienceKind, audienceOfKind, whoSeesLabel } from "@agenteschat/client/lib/who-sees";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { act, cleanup } from "@testing-library/react";
import type { TFunction } from "i18next";
import { IssueWhoSeesDialog } from "@/components/WhoSees";
import { IssuePage } from "@/pages/IssuePage";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderPage, settle } from "./render";

afterEach(() => cleanup());

const t = ((key: string, o?: Record<string, unknown>) =>
  o ? `${key}:${JSON.stringify(o)}` : key) as unknown as TFunction;

describe("the three options", () => {
  test("only me is a list of one with me in it; anyone else's list is people", () => {
    expect(audienceKind({ mode: "everyone" }, "me")).toBe("everyone");
    expect(audienceKind({ mode: "people", userIds: ["me"] }, "me")).toBe("me");
    expect(audienceKind({ mode: "people", userIds: ["ana"] }, "me")).toBe("people");
    expect(audienceOfKind("me", ["ana"], "me")).toEqual({ mode: "people", userIds: ["me"] });
    expect(audienceOfKind("everyone", ["ana"], "me")).toEqual({ mode: "everyone" });
  });

  test("the label names who it can, and says Specific people when it knows nobody", () => {
    const names: Record<string, string> = { a: "Ana", b: "Bia", c: "Caio", d: "Dani" };
    const label = (ids: string[]) => whoSeesLabel(t, { mode: "people", userIds: ids }, "me", (id) => names[id]);
    expect(label(["a"])).toBe('whoSees.only:{"name":"Ana"}');
    expect(label(["a", "b", "c", "d"])).toBe('whoSees.more:{"names":"Ana, Bia","count":2}');
    expect(label(["gone"])).toBe("whoSees.people");
  });

  test("an administrator may join a channel listed only for them", () => {
    const c = { visibility: "private", isMember: false } as Pick<Channel, "visibility" | "isMember">;
    expect(joinable(c)).toBe(false);
    expect(joinable({ ...c, seenAsAdmin: true })).toBe(true);
  });
});

describe("Quem vê on a task", () => {
  test("choosing Só eu saves a list of one, and the controls lock while it saves", async () => {
    const api = createFakeApi(seedState());
    const issue = await api.issues.create(ORG_ID, { title: "Plano" });
    const saved: unknown[] = [];
    let finish: () => void = () => {};
    const real = api.issues.setAudience;
    api.issues.setAudience = async (o, id, audience) => {
      saved.push(audience);
      await new Promise<void>((done) => {
        finish = done;
      });
      return real(o, id, audience);
    };
    let closed = false;
    await renderPage(<IssueWhoSeesDialog issue={issue} onClose={() => (closed = true)} />, { api, org: true });
    await settle(3);
    const button = (label: string) =>
      [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as HTMLButtonElement;
    await act(async () => button("Só eu").click());
    await act(async () => button("Salvar").click());
    await settle(2);
    expect(saved).toHaveLength(1);
    expect((saved[0] as { mode: string; userIds: string[] }).userIds).toHaveLength(1);
    expect(button("Cancelar").disabled).toBe(true);
    await act(async () => finish());
    await settle(3);
    expect(closed).toBe(true);
  });

  test("a task someone took out of my reach while it's open goes from the page", async () => {
    const api = createFakeApi(seedState());
    const issue = await api.issues.create(ORG_ID, { title: "Plano secreto" });
    let client: QueryClient | undefined;
    const Probe = () => {
      client = useQueryClient();
      return null;
    };
    await renderPage(
      <>
        <Probe />
        <IssuePage number={issue.number} />
      </>,
      { api, org: true },
    );
    await settle(5);
    expect(document.body.textContent).toContain("Plano secreto");
    api.issues.get = async () => {
      throw new ApiError(404, "not_found", "Issue not found");
    };
    await act(async () => {
      await client?.invalidateQueries({ queryKey: ["org", ORG_ID, "issues"] });
    });
    await settle(5);
    expect(document.body.textContent).not.toContain("Plano secreto");
  });
});

describe("Quem vê in a personal workspace (ADR 0159)", () => {
  /** The seeded workspace as a personal one; `alone`: Walter its only member. */
  const personal = (alone: boolean) => {
    const state = seedState();
    const org = state.me?.organizations[0];
    if (org) org.mode = "personal";
    if (alone) state.members = state.members.filter((m) => m.userId === state.me?.user.id);
    return state;
  };

  test("its words; with family, who runs it sees it too; alone, nothing about who else sees it", async () => {
    for (const alone of [false, true]) {
      const api = createFakeApi(personal(alone));
      const issue = await api.issues.create(ORG_ID, { title: "Plano" });
      await renderPage(<IssueWhoSeesDialog issue={issue} onClose={() => {}} />, { api, org: true });
      await settle(3);
      const text = document.body.textContent ?? "";
      expect(text).toContain("Todos daqui");
      expect(text).not.toContain("Administradores sempre veem.");
      expect(text.includes("Quem cuida daqui também vê.")).toBe(!alone);
      cleanup();
    }
  });

  test("alone, a task shows Quem vê only once it says anything but everyone", async () => {
    // The task's strip names each control in its label: "Quem vê: Só eu".
    const whoSees = () => document.querySelector('[aria-label^="Quem vê"]');
    const api = createFakeApi(personal(true));
    const open = await api.issues.create(ORG_ID, { title: "Plano aberto" });
    await renderPage(<IssuePage number={open.number} />, { api, org: true });
    await settle(5);
    expect(document.body.textContent).toContain("Plano aberto");
    expect(whoSees()).toBeNull();
    cleanup();
    const mine = await api.issues.create(ORG_ID, { title: "Plano meu" });
    await api.issues.setAudience(ORG_ID, mine.id, { mode: "people", userIds: ["u-walter"] });
    await renderPage(<IssuePage number={mine.number} />, { api, org: true });
    await settle(5);
    expect(whoSees()).not.toBeNull();
  });
});
