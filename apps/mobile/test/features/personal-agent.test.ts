import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCENE_FACES, SCENE_LINES } from "@agenteschat/client/lib/purpose-scene";

// A personal workspace's onboarding drawings and agent screens on the phone (ADR 0159 §2, §3): the web's, the same data.
const ROOT = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("the first question's drawings", () => {
  test("two cards side by side, drawn from the web's numbers, you as your photo or initial", () => {
    const flow = read("src/features/onboarding/OnboardingFlow.tsx");
    expect(flow).toContain("<PurposeScene kind={mode} chosen={on} width={cardWidth} you={{ name: youName, photo }} />");
    expect(flow).toContain("const photo = usePersonPhoto(me.data?.user.image);");
    const scene = read("src/features/onboarding/PurposeScene.tsx");
    expect(scene).toContain('from "@agenteschat/client/lib/purpose-scene"');
    expect(scene).toContain("<PersonAvatar name={you.name} size={size} photo={you.photo} />");
    expect(scene).toContain('mode={chosen ? "idle" : "sleep"}');
    // You amid six agents, each joined to you; a chart of five lines under you.
    expect(SCENE_FACES.personal.filter((f) => "look" in f)).toHaveLength(6);
    expect(SCENE_LINES.personal).toHaveLength(6);
    expect(SCENE_LINES.team).toHaveLength(5);
  });
});

describe("a personal workspace's agent", () => {
  test("Advanced is a screen of its own, with the brakes, who it reports to, its rules, repositories and deleting it", () => {
    expect(read("app/(app)/_layout.tsx")).toContain('<Stack.Screen name="agent-more/[id]"');
    const more = read("src/features/agents/AgentMoreScreen.tsx");
    for (const piece of [
      "<BrakesSection",
      "<ReportsToSection",
      "<AlwaysApproved",
      "<MergeReposSection",
      "openAgentDelete",
    ])
      expect(more).toContain(piece);
  });

  test("its edit screen and its access leave those for Advanced, with a row to it", () => {
    const edit = read("src/features/agents/AgentEditScreen.tsx");
    expect(edit).toContain("{personal ? null : (");
    expect(edit).toContain("{admin && !rightHand && !personal ? (");
    expect(edit).toContain("onPress={() => openAgentMore(id)}");
    const profile = read("src/features/agents/AgentProfileScreen.tsx");
    expect(profile).toContain("const personal = isPersonal(org);");
    expect(profile).toContain("onPress={() => openAgentMore(id)}");
  });

  test("creating one by hand starts from the right hand's personal agents, not a company's roles", () => {
    const create = read("src/features/agents/NewAgentScreen.tsx");
    expect(create).toContain("{(personal ? [] : ROLE_GROUPS).map((group) => (");
    expect(create).toContain("{PERSONAL_STARTERS.map((s) => (");
    expect(create).toContain("onPress={() => pickStarter(s)}");
  });
});
