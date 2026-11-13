import { describe, expect, test } from "bun:test";
import type { ApiClient, Me } from "@agenteschat/client";
import { keys } from "@agenteschat/client";
import { QueryClient } from "@tanstack/react-query";
import { requireUserIn } from "@/app/guards";

const user = { id: "u1", name: "Walter", email: "w@example.com", image: null };

describe("opening a workspace", () => {
  test("a workspace just created (not in the cached list yet) is checked with the server, not refused", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<Me>(keys.me, { user, organizations: [{ id: "old", name: "Old", role: "owner" }] });
    let calls = 0;
    const fresh: Me = {
      user,
      organizations: [
        { id: "old", name: "Old", role: "owner" },
        { id: "new", name: "Acme", role: "owner" },
      ],
    };
    const api = {
      account: {
        me: async () => {
          calls++;
          return fresh;
        },
      },
    } as unknown as ApiClient;
    const me = await requireUserIn({ queryClient, api }, "/org/new", "new");
    expect(me.organizations.some((o) => o.id === "new")).toBe(true);
    expect(calls).toBe(1);
    // Already in the list: no extra request.
    await requireUserIn({ queryClient, api }, "/org/old", "old");
    expect(calls).toBe(1);
  });
});
