import { expect, test } from "bun:test";
import { messagePath, parseMessageLink } from "../src/message-links";

const ORG = "00000000-0000-4000-8000-000000000001";
const CH = "00000000-0000-4000-8000-0000000000c1";
const TH = "00000000-0000-4000-8000-0000000000d1";
const M = "00000000-0000-4000-8000-0000000000e1";

test("a reply links to its thread, every other message to its conversation", () => {
  expect(messagePath(ORG, { id: M, channelId: CH })).toBe(`/org/${ORG}/c/${CH}?m=${M}`);
  expect(messagePath(ORG, { id: M, channelId: CH, threadId: TH })).toBe(`/org/${ORG}/threads/${TH}?m=${M}`);
  // A thread's root opens in the channel.
  expect(messagePath(ORG, { id: TH, channelId: CH, threadId: TH })).toBe(`/org/${ORG}/c/${CH}?m=${TH}`);
});

test("only this server's permalinks parse", () => {
  const origins = ["https://agentes.example/"];
  const path = messagePath(ORG, { id: M, channelId: CH });
  expect(parseMessageLink(path)).toEqual({ orgId: ORG, messageId: M, channelId: CH, threadId: null });
  expect(parseMessageLink(`https://agentes.example${path}`, origins)?.channelId).toBe(CH);
  expect(parseMessageLink(`https://AGENTES.example/org/${ORG}/threads/${TH}?x=1&m=${M}`, origins)).toEqual({
    orgId: ORG,
    messageId: M,
    channelId: null,
    threadId: TH,
  });
  expect(parseMessageLink(`https://other.example${path}`, origins)).toBeNull();
  expect(parseMessageLink(`/org/${ORG}/c/${CH}`)).toBeNull();
  expect(parseMessageLink(`/org/${ORG}/c/${CH}?m=nope`)).toBeNull();
  expect(parseMessageLink(`/org/${ORG}/issues/${CH}?m=${M}`)).toBeNull();
  expect(parseMessageLink(`/org/${ORG}/c/${CH}/x?m=${M}`)).toBeNull();
});
