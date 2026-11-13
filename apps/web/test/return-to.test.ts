import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { isFlowPath, notePlace, returnPlace } from "@/lib/return-to";

afterEach(() => sessionStorage.clear());

test("a flow's exits go back to the last page shown outside a flow, in that workspace only", () => {
  expect(returnPlace("o1")).toBe("/org/o1");
  notePlace("/org/o1/c/eng?m=m-9");
  // The flows themselves, and pages outside a workspace, are never a place to go back to.
  notePlace("/org/o1/agents/new?channel=eng");
  notePlace("/onboarding");
  notePlace("/login?redirect=%2F");
  expect(returnPlace("o1")).toBe("/org/o1/c/eng?m=m-9");
  // Another workspace's flow falls back to its own address.
  expect(returnPlace("o2")).toBe("/org/o2");
  expect(returnPlace("o2", "/org/o2/home")).toBe("/org/o2/home");
  // A workspace whose id starts like this one's is another workspace.
  expect(returnPlace("o")).toBe("/org/o");
  notePlace("/org/o1/settings/members");
  expect(returnPlace("o1")).toBe("/org/o1/settings/members");
});

test("which screens are flows", () => {
  expect(isFlowPath("/org/o1/agents/new")).toBe(true);
  expect(isFlowPath("/org/o1/agents/new/")).toBe(true);
  expect(isFlowPath("/onboarding")).toBe(true);
  expect(isFlowPath("/org/o1/agents/a-1")).toBe(false);
  expect(isFlowPath("/org/o1/c/eng")).toBe(false);
});
