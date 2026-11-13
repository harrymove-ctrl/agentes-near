import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  type ConnectorDeps,
  createApiKeyConnection,
  createApprovalRequestToolSource,
  createConnectorToolSource,
  createDesktopToolSource,
  createGitToolSource,
  DESKTOP_SCOPE,
  grantScopes,
  isSensitive,
  type JsonSchema,
  SANDBOX_SCOPE,
  type ToolContext,
  type ToolDefinition,
  type ToolGateway,
  updateSandboxSettings,
} from "../src";
import { WHY_MIN_CHARS, WHY_REFUSAL } from "../src/tools/run-policy";
import { fakeHub } from "./desktop-fixtures";
import { fakeGithubMcp } from "./fake-mcp";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { giveMail, imapAccount, type MailFixture, mailSetup, runContext } from "./mail-fixtures";

/**
 * A call that asks a person takes one reason, `why`, and a refusal says so: with `why` and what its schema requires,
 * every sensitive tool reaches its card; without `why`, that is all it hears. A tool that also required a `reason` of
 * its own would be refused by one rule or the other whichever field the model sent.
 */

let f: Fixture | undefined;
let m: MailFixture | undefined;
afterEach(async () => {
  const [fixture, mail] = [f, m];
  f = undefined;
  m = undefined;
  await (fixture ?? mail?.f)?.close();
});

const WHY = "The person asked for this and I checked the current state: nothing else does it.";
const REASON_LIKE = /reason|justif|rationale|motiv|explanation|purpose/i;

/** Fields whose value must look like the real thing for the tool's own checks. */
const VALUES: Record<string, unknown> = {
  owner: "acme",
  repo: "acme/app",
  branch: "feature/x",
  to: ["ana@acme.com"],
  branches: ["feature/x"],
  steps: [{ do: "press", key: "ctrl+s" }],
};

/** The smallest value a schema takes, as a model fills in the listed tool. */
function sample(of: JsonSchema, key = ""): unknown {
  if (key in VALUES) return VALUES[key];
  if (Array.isArray(of.enum)) return of.enum[0];
  const type = Array.isArray(of.type) ? of.type[0] : of.type;
  if (type === "object") {
    const properties = (of.properties ?? {}) as Record<string, JsonSchema>;
    const required = (of.required ?? []) as string[];
    return Object.fromEntries(required.map((k) => [k, sample(properties[k] ?? {}, k)]));
  }
  if (type === "array") {
    return Array.from({ length: Number(of.minItems ?? 1) }, () => sample((of.items ?? {}) as JsonSchema));
  }
  if (type === "integer" || type === "number") return of.minimum ?? 1;
  if (type === "boolean") return true;
  return "x".repeat(Number(of.minLength ?? 1));
}

/** Every sensitive tool the run lists, called both ways; `cards`: those that must get past their own checks too. */
async function everySensitiveToolAsksOnce(tools: ToolGateway, ctx: ToolContext, cards: string[]) {
  const call = (tool: ToolDefinition, input: Record<string, unknown>) =>
    tools.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name: tool.name, input });
  const carded: string[] = [];
  for (const tool of (await tools.granted(ctx)).filter(isSensitive)) {
    const required = (tool.inputSchema.required ?? []) as string[];
    expect(required, tool.name).toContain("why");
    expect(
      required.filter((k) => k !== "why" && REASON_LIKE.test(k)),
      tool.name,
    ).toEqual([]);

    const { why: _, ...bare } = sample(tool.inputSchema) as Record<string, unknown>;
    const asked = await call(tool, { ...bare, why: WHY });
    if (asked.type === "approval") {
      carded.push(tool.name);
      expect(await call(tool, bare), tool.name).toMatchObject({
        output: { content: WHY_REFUSAL, isError: true, data: { code: "tool.why_missing" } },
      });
    } else {
      // Past both rules, stopped by what it acts on: a sample branch or message doesn't exist.
      const output = asked.type === "result" ? asked.output : null;
      expect(output?.content, tool.name).not.toStartWith("Invalid input");
      expect(output?.data?.code, tool.name).not.toBe("tool.why_missing");
    }
  }
  expect(carded).toEqual(expect.arrayContaining(cards));
}

const invoke = async (name: string, input: Record<string, unknown>) => {
  const ctx = await runContext(f as Fixture);
  const tools = f?.tools as ToolGateway;
  return tools.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
};

describe("one reason, `why`", () => {
  // Many renders/tool calls in one test: over 5 s on a loaded CI runner, well under alone.
  test("every built-in sensitive tool and connected app's reaches its card with `why` and its required fields", async () => {
    const mcp = fakeGithubMcp();
    const deps = (): ConnectorDeps => ({
      db: (f as Fixture).db,
      keyWrappers: [(f as Fixture).keyWrapper],
      publicUrl: "https://chat.example.com",
    });
    f = await setup({
      permissionTools: true,
      machines: true,
      toolSources: [
        createApprovalRequestToolSource(),
        { name: "connectors", tools: (c) => createConnectorToolSource({ ...deps(), connect: mcp.connect }).tools(c) },
        {
          name: "git",
          tools: (c) =>
            createGitToolSource({
              sandbox: { db: c.db, machines: { hub: f?.machineHub }, git: {} } as never,
              connectors: deps(),
              pubsub: f?.pubsub as Fixture["pubsub"],
            }).tools(c),
        },
      ],
    });
    await createApiKeyConnection(deps(), f.owner.id, f.org.id, { connector: "github", apiKey: "ghp_secret_123456" });
    await f.db.insert(schema.agentScopes).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      connectionId: null,
      scope: "sandbox:run",
    });
    await updateSandboxSettings(f.db, f.owner.id, f.org.id, { requireApproval: true });
    await everySensitiveToolAsksOnce(f.tools as ToolGateway, await runContext(f), [
      "request_permission",
      "request_approval",
      "github_merge_pull_request",
      "run_code",
    ]);
  }, 15_000);

  test("a mailbox's sensitive tools too", async () => {
    m = await mailSetup();
    const account = await imapAccount(m);
    await giveMail(m, account.id, "read_write", { allowedRecipients: ["@acme.com"] }, true);
    await everySensitiveToolAsksOnce(m.tools as ToolGateway, await runContext(m.f), ["mail_support_send"]);
  });

  test("a plan on the desktop too, where every command asks first", async () => {
    const computer = { machineId: "", orgId: "" };
    const { hub } = fakeHub(computer);
    f = await setup({
      toolSources: [createDesktopToolSource({ machines: { hub }, publicUrl: "https://chat.example.com" })],
    });
    const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Box" });
    Object.assign(computer, { machineId: paired.machineId, orgId: f.org.id });
    await f.db.update(schema.agents).set({ machineId: paired.machineId }).where(eq(schema.agents.id, f.agent.id));
    await grantScopes(f.db, f.org.id, f.agent.id, [
      { connectionId: null, scope: DESKTOP_SCOPE },
      { connectionId: null, scope: SANDBOX_SCOPE },
    ]);
    await updateSandboxSettings(f.db, f.owner.id, f.org.id, { requireApproval: true });
    await everySensitiveToolAsksOnce(f.tools as ToolGateway, await runContext(f), ["desktop_do"]);
  });

  test("request_permission: `why` alone is enough, and the card shows it", async () => {
    f = await setup({ permissionTools: true });
    const asked = await invoke("request_permission", { why: WHY, permission: "issues:write" });
    if (asked.type !== "approval") throw new Error(`expected an approval, got ${JSON.stringify(asked)}`);
    expect(asked.approval).toMatchObject({ why: WHY, detail: "", params: { permission: "issues:write" } });
  });

  test("the refusal names the field and its length, for none and for too short", async () => {
    expect(WHY_REFUSAL).toContain("`why`");
    expect(WHY_REFUSAL).toContain(`at least ${WHY_MIN_CHARS} characters`);
    f = await setup({ permissionTools: true });
    for (const input of [{ permission: "issues:write" }, { permission: "issues:write", why: "short" }]) {
      expect(await invoke("request_permission", input)).toMatchObject({
        output: { content: WHY_REFUSAL, isError: true },
      });
    }
  });

  test("a call wrong in two ways hears both at once: its field and `why`", async () => {
    f = await setup({ permissionTools: true });
    expect(await invoke("request_permission", { permission: "issues:write", reason: "Need it." })).toMatchObject({
      output: { content: `Invalid input: input.reason: not allowed. ${WHY_REFUSAL}`, isError: true },
    });
    expect(await f.db.select().from(schema.approvals).where(eq(schema.approvals.orgId, f.org.id))).toEqual([]);
  });

  test("through use_tool the input it is shown has `why`", async () => {
    f = await setup({ permissionTools: true, issueTools: true });
    const ctx = { ...(await runContext(f)), loadedGroups: [] };
    const asked = await f.tools?.invoke(ctx, {
      toolUseId: "tu_use",
      name: "use_tool",
      input: { tool: "request_permission", arguments: { reason: "Need it." } },
    });
    const content = asked?.type === "result" ? asked.output.content : "";
    expect(content).toStartWith("Invalid input: input.permission: required; input.reason: not allowed.");
    expect(content.slice(content.indexOf("Input schema of request_permission:"))).toContain('"why":');
  });
});
