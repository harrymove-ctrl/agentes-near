import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Member } from "@agenteschat/client";
import { cleanup } from "@testing-library/react";
import { PollCard } from "@/components/blocks/PollCard";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderPage, settle } from "./render";

afterEach(() => cleanup());

/** A member's photo with no network: a small drawing. */
const photo = (color: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4" fill="${color}"/></svg>`)}`;

/** A vote where the first `count` of nine people chose its first option; João has no photo. */
async function voting(count: number) {
  const state = seedState();
  const [walter, joao] = state.members as [Member, Member];
  walter.image = photo("#c9a27e");
  const others = ["Ana Souza", "Bruno", "Iara", "Lia", "Marina", "Otto"];
  state.members.push(
    ...others.map((name, i) => ({
      ...joao,
      userId: `u-voter-${i}`,
      name,
      email: `voter${i}@example.com`,
      handle: `voter${i}`,
      image: photo(["#8fb3d9", "#d98f8f", "#9fd98f", "#d9c98f", "#b38fd9", "#8fd9cf"][i] as string),
    })),
  );
  const api = createFakeApi(state);
  const poll = await api.artifacts.create(ORG_ID, {
    title: "Almoço",
    content: { kind: "poll", question: "Onde almoçamos na sexta?", options: ["Pizzaria", "Japonês"], multiple: false },
  });
  const voters = state.members.slice(0, count).map((m) => m.userId);
  api.artifacts.poll = async (_orgId, id) => ({
    id,
    closesAt: new Date(Date.now() + 3_600_000).toISOString(),
    closedAt: null,
    people: 9,
    votes: voters.map((userId) => ({ userId, option: 0 })),
  });
  await renderPage(<PollCard id={poll.id} />, { api, org: true });
  await settle(6);
  return document.querySelector(".poll__option .poll__faces") as HTMLElement;
}

test("each voter is their face as the conversation shows it, in the kit's stack: the photo, else the initials", async () => {
  const faces = await voting(2);
  expect(faces.getAttribute("aria-label")).toBe("Walter, João");
  const avatars = [...faces.querySelectorAll<HTMLElement>(".ac-avatar-stack > .ac-avatar")];
  expect(avatars.map((a) => a.title)).toEqual(["Walter", "João"]);
  expect(avatars[0]?.querySelector("img")?.getAttribute("src")).toStartWith("data:image/svg+xml");
  expect(avatars[1]?.querySelector("img")).toBeNull();
  expect(avatars[1]?.textContent).toBe("J");
  expect(faces.querySelector(".poll__more")).toBeNull();
  // An option nobody chose shows no faces at all.
  expect(document.querySelectorAll(".poll__faces")).toHaveLength(1);
  // The share fills the option up to the faces, never under their rings.
  const option = faces.closest(".poll__option") as HTMLElement;
  expect(option.querySelector(".poll__track > .poll__fill")).not.toBeNull();
  expect(faces.closest(".poll__track")).toBeNull();
});

test("seven voters: five faces, then how many more, those named in its tip", async () => {
  const faces = await voting(7);
  expect(faces.querySelectorAll(".ac-avatar")).toHaveLength(5);
  const more = faces.querySelector(".poll__more") as HTMLElement;
  expect(more.textContent).toBe("+2");
  expect(more.title).toBe("Lia, Marina");
  expect(faces.getAttribute("aria-label")?.split(", ")).toHaveLength(7);
});
