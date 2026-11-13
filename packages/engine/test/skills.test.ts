import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { orgTopic } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  createApiKeyConnection,
  createOrganization,
  deleteSkill,
  drainOutbox,
  enabledSkills,
  ForbiddenError,
  forgetInstallationTokens,
  type GitHubAppConfig,
  getSkill,
  getSkillFile,
  importPickedSkills,
  importSkillFromUrl,
  importSkillZip,
  listAgentScopes,
  listConnections,
  listSkills,
  NotFoundError,
  parseSkillMarkdown,
  postPersonMessage,
  RIGHT_HAND,
  reimportSkill,
  revokeConnection,
  SKILL_LIMITS,
  type SkillDetail,
  saveSkill,
  setAgentAccess,
  setAgentSkills,
  type TooManyError,
  ValidationError,
} from "../src";
import { toolDetail } from "../src/tool-detail";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const SKILL_MD = `---
name: relatorio-semanal
description: >
  Escreve o relatório semanal do time
  no formato da empresa.
license: MIT
allowed-tools:
  - create_artifact
---
# Relatório semanal

1. Junte as entregas da semana.
2. Use o modelo em templates/relatorio.md.
`;

/**
 * A minimal zip writer (stored entries) for tests. `zip64`: the end record as git archive writes it past 65,535 files,
 * its count at the maximum and the real values in a zip64 record before it.
 */
/** The first bytes of a PNG: enough for the type read from its bytes. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function zip(files: Record<string, string | Uint8Array>, options: { zip64?: boolean } = {}) {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = enc.encode(path);
    const data = typeof text === "string" ? enc.encode(text) : text;
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const zip64: Uint8Array[] = [];
  if (options.zip64) {
    const record = new Uint8Array(56);
    const rv = new DataView(record.buffer);
    rv.setUint32(0, 0x06064b50, true);
    rv.setBigUint64(4, 44n, true);
    rv.setBigUint64(24, BigInt(centrals.length), true);
    rv.setBigUint64(32, BigInt(centrals.length), true);
    rv.setBigUint64(40, BigInt(centralSize), true);
    rv.setBigUint64(48, BigInt(offset), true);
    const locator = new Uint8Array(20);
    const lv = new DataView(locator.buffer);
    lv.setUint32(0, 0x07064b50, true);
    lv.setBigUint64(8, BigInt(offset + centralSize), true);
    lv.setUint32(16, 1, true);
    zip64.push(record, locator);
  }
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, Math.min(centrals.length, 0xffff), true);
  ev.setUint16(10, Math.min(centrals.length, 0xffff), true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, ...zip64, eocd];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const skillDeps = () => ({ db: f.db, blobs: f.artifactDeps.blobs, resolveHost: async () => ["140.82.112.3"] });

/** acme/skills as its archive holds it: under the archive's own folder, a skill with a skill inside, two more. */
const REPOSITORY = {
  "skills-main/README.md": "# Skills",
  "skills-main/docs/guide.md": "# Guia",
  "skills-main/relatorio-semanal/SKILL.md": SKILL_MD,
  "skills-main/relatorio-semanal/templates/relatorio.md": "# Semana {{n}}",
  "skills-main/relatorio-semanal/build.py": "print(1)",
  "skills-main/relatorio-semanal/logo.png": "PNG",
  "skills-main/relatorio-semanal/examples/inner/SKILL.md": "---\nname: inner\ndescription: Um exemplo.\n---\nx",
  "skills-main/team/deploy/SKILL.md": "---\nname: deploy\ndescription: Antes de qualquer deploy.\n---\n# Deploy",
  "skills-main/team/review/SKILL.md": "---\nname: review\ndescription: Revisa um pull request.\n---\n# Review",
};

/**
 * Fake GitHub: github.com redirects acme/skills' archive (`archive`, else REPOSITORY's) to codeload (a branch by name,
 * the default branch by its commit), which sends it; anything else is a 404. `limited`: every answer is GitHub
 * limiting us, with these headers.
 */
function fakeGithub(
  options: { redirect?: string; limited?: Record<string, string>; status?: number; archive?: Uint8Array } = {},
) {
  const fetched: string[] = [];
  const fetch = async (url: string) => {
    fetched.push(url);
    if (options.limited) return new Response("slow down", { status: options.status ?? 429, headers: options.limited });
    const ref = /^https:\/\/github\.com\/acme\/skills\/archive\/(.+)\.zip$/.exec(url)?.[1];
    if (ref) {
      const at = ref === "HEAD" ? "0123abc" : ref === "main" ? "refs/heads/main" : ref;
      const location = options.redirect ?? `https://codeload.github.com/acme/skills/zip/${at}`;
      return new Response(null, { status: 302, headers: { location } });
    }
    if (/^https:\/\/codeload\.github\.com\/acme\/skills\/zip\/(refs\/heads\/main|0123abc)$/.test(url)) {
      return new Response(options.archive ?? zip(REPOSITORY));
    }
    return new Response("404: Not Found", { status: 404 });
  };
  return { fetch, fetched };
}

describe("SKILL.md", () => {
  test("frontmatter and body; other fields kept; name and description validated", () => {
    const s = parseSkillMarkdown(SKILL_MD);
    expect(s).toMatchObject({
      name: "relatorio-semanal",
      description: "Escreve o relatório semanal do time no formato da empresa.",
      metadata: { license: "MIT", "allowed-tools": ["create_artifact"] },
    });
    expect(s.body.startsWith("# Relatório semanal")).toBe(true);
    expect(() => parseSkillMarkdown("# no frontmatter")).toThrow(ValidationError);
    expect(() => parseSkillMarkdown("---\nname: Relatorio Semanal\ndescription: x\n---\nbody")).toThrow("kebab-case");
    expect(() => parseSkillMarkdown(`---\nname: ok\ndescription: ${"x".repeat(1025)}\n---\nbody`)).toThrow("1024");
    expect(() => parseSkillMarkdown(`---\nname: ${"a".repeat(65)}\ndescription: x\n---\nb`)).toThrow("64");
  });

  test("nested YAML survives (OpenClaw and Hermes metadata, multi-line blocks); YAML that isn't is read by line", () => {
    const openclaw = parseSkillMarkdown(`---
name: github-triage
description: |
  Triage new issues.
  Label and assign them.
metadata:
  openclaw:
    emoji: "🦞"
    requires:
      bins: [gh]
      env:
        - GITHUB_TOKEN
    user-invocable: true
  hermes:
    tags: [github, triage]
---
Body.`);
    expect(openclaw.description).toBe("Triage new issues.\nLabel and assign them.");
    expect(openclaw.metadata).toEqual({
      metadata: {
        openclaw: { emoji: "🦞", requires: { bins: ["gh"], env: ["GITHUB_TOKEN"] }, "user-invocable": true },
        hermes: { tags: ["github", "triage"] },
      },
    });
    // Not YAML (a second colon), as many published skills are: the line reading, as before.
    const loose = parseSkillMarkdown("---\nname: pdf\ndescription: Use when: the user sends a PDF\n---\nBody.");
    expect(loose.description).toBe("Use when: the user sends a PDF");
    // YAML would make these a boolean and a number: the text as written.
    expect(parseSkillMarkdown("---\nname: yes-no\ndescription: Yes\n---\nb").description).toBe("Yes");
    // Aliases that expand past the budget are refused as YAML (then read by line: no nested fields).
    const bomb = ["a: &a [x, x, x, x, x, x, x, x, x, x]", "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]"];
    bomb.push("c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]", "d: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]");
    const expanded = parseSkillMarkdown(`---\nname: bomb\ndescription: x\n${bomb.join("\n")}\n---\nb`);
    expect(Array.isArray(expanded.metadata.d)).toBe(false);
  });
});

describe("import", () => {
  test("a zip of the folder: SKILL.md, text files and images stored, scripts kept as scripts", async () => {
    f = await setup();
    const skill = await importSkillZip(
      skillDeps(),
      f.owner.id,
      f.org.id,
      zip({
        "relatorio-semanal/SKILL.md": SKILL_MD,
        "relatorio-semanal/templates/relatorio.md": "# Semana {{n}}",
        "relatorio-semanal/scripts/build.py": "print('no')",
        "relatorio-semanal/run.sh": "rm -rf /",
        "relatorio-semanal/logo.png": "PNG",
      }),
    );
    expect(skill).toMatchObject({ name: "relatorio-semanal", version: 1, source: "upload" });
    expect(skill.files.map((x) => [x.path, x.status])).toEqual([
      ["logo.png", "stored"],
      ["run.sh", "script"],
      ["scripts/build.py", "script"],
      ["templates/relatorio.md", "stored"],
    ]);
    const audit = await f.db.select().from(schema.auditLog);
    expect(audit.some((a) => a.action === "skill.installed")).toBe(true);
    // The same name again is a new version.
    const again = await saveSkill(skillDeps(), f.owner.id, f.org.id, {
      ...parseSkillMarkdown(SKILL_MD),
      source: "manual",
    });
    expect(again.version).toBe(2);
  });

  test("two files that collapse to one path are refused (no shared blob key, no undercounted size)", async () => {
    f = await setup();
    // `a.md` and `./a.md` both normalize to `a.md`: without the guard the big one overwrites the small one
    // on disk while its row is dropped, so the metered size (1 byte) no longer matches 100 KB on disk.
    await expect(
      importSkillZip(
        skillDeps(),
        f.owner.id,
        f.org.id,
        zip({ "SKILL.md": SKILL_MD, "a.md": "x", "./a.md": "y".repeat(100_000) }),
      ),
    ).rejects.toThrow(/share the path/);
  });

  test("a skill's folder link: the repository's archive, through codeload's redirect, never the REST API", async () => {
    f = await setup();
    const github = fakeGithub();
    const deps = { ...skillDeps(), fetch: github.fetch };
    const url = "https://github.com/acme/skills/tree/main/relatorio-semanal";
    const skill = await importSkillFromUrl(deps, f.owner.id, f.org.id, url);
    expect(skill).toMatchObject({ name: "relatorio-semanal", source: "url", sourceUrl: url });
    expect("files" in skill && skill.files.map((x) => [x.path, x.status])).toEqual([
      ["build.py", "script"],
      ["examples/inner/SKILL.md", "stored"],
      ["logo.png", "stored"],
      ["templates/relatorio.md", "stored"],
    ]);
    expect(github.fetched).toEqual([
      "https://github.com/acme/skills/archive/main.zip",
      "https://codeload.github.com/acme/skills/zip/refs/heads/main",
    ]);

    // A file in the folder, its SKILL.md included, is the folder: the same skill again, with its files.
    const again = await importSkillFromUrl(
      deps,
      f.owner.id,
      f.org.id,
      "https://github.com/acme/skills/blob/main/relatorio-semanal/SKILL.md",
    );
    expect(again).toMatchObject({ name: "relatorio-semanal", version: 2 });
    expect("files" in again && again.files.map((x) => x.path)).toContain("templates/relatorio.md");
    expect(github.fetched.filter((u) => /api\.github\.com|raw\.githubusercontent\.com/.test(u))).toEqual([]);

    await expect(importSkillFromUrl(deps, f.owner.id, f.org.id, "https://example.com/SKILL.md")).rejects.toThrow(
      "GitHub",
    );
    const privateDns = { ...deps, resolveHost: async () => ["10.0.0.7"] };
    await expect(importSkillFromUrl(privateDns, f.owner.id, f.org.id, url)).rejects.toBeInstanceOf(ValidationError);
    // A redirect off GitHub is refused like a link off GitHub.
    const away = fakeGithub({ redirect: "https://example.com/acme.zip" });
    await expect(importSkillFromUrl({ ...skillDeps(), fetch: away.fetch }, f.owner.id, f.org.id, url)).rejects.toThrow(
      "Only GitHub URLs",
    );
    expect(away.fetched.some((u) => u.includes("example.com"))).toBe(false);
  });

  test("a repository holding several skills lists them by name and description; the picked ones install", async () => {
    f = await setup();
    const github = fakeGithub();
    const deps = { ...skillDeps(), fetch: github.fetch };
    const url = "https://github.com/acme/skills";
    const listed = await importSkillFromUrl(deps, f.owner.id, f.org.id, url);
    // The SKILL.md inside relatorio-semanal is one of its files, not a skill; nothing is installed yet.
    expect(listed).toEqual({
      choices: [
        { path: "relatorio-semanal", name: "relatorio-semanal", description: expect.stringContaining("semanal") },
        { path: "team/deploy", name: "deploy", description: "Antes de qualquer deploy." },
        { path: "team/review", name: "review", description: "Revisa um pull request." },
      ],
    });
    expect(await listSkills(f.db, f.owner.id, f.org.id)).toEqual([]);
    expect(github.fetched).toEqual([
      "https://github.com/acme/skills/archive/HEAD.zip",
      "https://codeload.github.com/acme/skills/zip/0123abc",
    ]);

    const installed = await importPickedSkills(deps, f.owner.id, f.org.id, url, ["team/deploy", "relatorio-semanal"]);
    expect(installed.map((s) => [s.name, s.sourceUrl])).toEqual([
      ["deploy", "https://github.com/acme/skills/tree/HEAD/team/deploy"],
      ["relatorio-semanal", "https://github.com/acme/skills/tree/HEAD/relatorio-semanal"],
    ]);
    expect(installed[1]?.files.map((x) => x.path)).toContain("examples/inner/SKILL.md");
    expect((await listSkills(f.db, f.owner.id, f.org.id)).map((s) => s.name)).toEqual(["deploy", "relatorio-semanal"]);
    await expect(importPickedSkills(deps, f.owner.id, f.org.id, url, ["docs"])).rejects.toThrow("no skill at docs");
    // A folder holding skills lists only its own.
    const team = await importSkillFromUrl(deps, f.owner.id, f.org.id, "https://github.com/acme/skills/tree/main/team");
    expect("choices" in team && team.choices.map((c) => c.path)).toEqual(["team/deploy", "team/review"]);
    expect(github.fetched.filter((u) => /api\.github\.com|raw\.githubusercontent\.com/.test(u))).toEqual([]);
  });

  test("installed from an agent's card (offer_install_skill), what the link holds goes on for that agent", async () => {
    f = await setup({ rightHand: true });
    const deps = { ...skillDeps(), fetch: fakeGithub().fetch, pubsub: f.pubsub };
    const told: string[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => {
      if (e.type === "org.broadcast") told.push((e.event as { type: string }).type);
    });
    const on = async (agentId = f.agent.id) => (await enabledSkills(f.db, f.org.id, agentId)).map((k) => k.name);
    const forAgentId = f.agent.id;
    await importSkillFromUrl(deps, f.owner.id, f.org.id, "https://github.com/acme/skills/tree/main/team/deploy", {
      forAgentId,
    });
    expect(await on()).toEqual(["deploy"]);
    // An open agent page saves its whole list: it hears of the change and reads it again.
    expect(told.filter((t) => t === "agents.changed")).toHaveLength(1);
    await importPickedSkills(deps, f.owner.id, f.org.id, "https://github.com/acme/skills", ["team/review"], {
      forAgentId,
    });
    expect(await on()).toEqual(["deploy", "review"]);
    // An agent gone, archived or the right hand: the install still stands, on for nobody, and nothing to hear.
    const url = "https://github.com/acme/skills/tree/main/relatorio-semanal";
    const [lodi] = await f.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
    await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, f.agent.id));
    told.length = 0;
    for (const agentId of [crypto.randomUUID(), f.agent.id, lodi?.id ?? ""])
      expect(await importSkillFromUrl(deps, f.owner.id, f.org.id, url, { forAgentId: agentId })).toMatchObject({
        name: "relatorio-semanal",
      });
    expect(await on()).toEqual(["deploy", "review"]);
    expect(await on(lodi?.id)).toEqual([]);
    expect(told).toEqual([]);
  });

  test("from a link or a pick, a removed skill's name comes back on for none of its old agents; the list says so", async () => {
    f = await setup();
    const deps = { ...skillDeps(), fetch: fakeGithub().fetch };
    const on = async () => (await enabledSkills(f.db, f.org.id, f.agent.id)).map((k) => k.name);
    const mine = (name: string) =>
      saveSkill(deps, f.owner.id, f.org.id, {
        name,
        description: "Do time.",
        body: "1. old",
        metadata: {},
        source: "manual",
      });
    const deploy = await mine("deploy");
    await mine("review");
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: deploy.id, enabled: true }]);
    await deleteSkill(f.db, f.owner.id, f.org.id, deploy.id);
    const team = "https://github.com/acme/skills/tree/main/team";
    const listed = await importSkillFromUrl(deps, f.owner.id, f.org.id, team);
    expect("choices" in listed && listed.choices.map((c) => [c.name, c.replaces])).toEqual([
      ["deploy", "removed"],
      ["review", "installed"],
    ]);
    // Picked with its box unchecked: back under its name, on for nobody.
    await importPickedSkills(deps, f.owner.id, f.org.id, team, ["team/deploy"]);
    expect(await on()).toEqual([]);
    // The same from the link alone, then with the box: on for the card's agent only.
    await deleteSkill(f.db, f.owner.id, f.org.id, deploy.id);
    await importSkillFromUrl(deps, f.owner.id, f.org.id, `${team}/deploy`);
    expect(await on()).toEqual([]);
    await deleteSkill(f.db, f.owner.id, f.org.id, deploy.id);
    await importSkillFromUrl(deps, f.owner.id, f.org.id, `${team}/deploy`, { forAgentId: f.agent.id });
    expect(await on()).toEqual(["deploy"]);
  });

  test("the skills a link holds that can't be installed are listed apart with why, never offered", async () => {
    f = await setup();
    const md = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}`;
    const archive = zip({
      "skills-main/logo/SKILL.md": md("logo", "Desenha com o logo da marca."),
      "skills-main/logo/brand.svg": "x".repeat(SKILL_LIMITS.maxBytes),
      "skills-main/good/SKILL.md": md("good", "Funciona."),
      "skills-main/long/SKILL.md": md("long", "x".repeat(1100)),
    });
    const deps = { ...skillDeps(), fetch: fakeGithub({ archive }).fetch };
    const url = "https://github.com/acme/skills";
    expect(await importSkillFromUrl(deps, f.owner.id, f.org.id, url)).toEqual({
      choices: [{ path: "good", name: "good", description: "Funciona." }],
      skipped: [
        {
          path: "logo",
          code: "skill.too_large",
          message: "This skill has 16.1 MB of text and scripts (max 16 MB)",
          params: { size: 16.1, max: 16 },
        },
        {
          path: "long",
          code: "skill.invalid_description",
          message: "description: 1 to 1024 characters",
          params: { max: 1024 },
        },
      ],
    });
    await expect(importPickedSkills(deps, f.owner.id, f.org.id, url, ["good", "long"])).rejects.toThrow(
      "long: description",
    );
    expect(await listSkills(f.db, f.owner.id, f.org.id)).toEqual([]);
  });

  test("a repository of 40,000 one-file skill folders is refused for holding too many in a moment", async () => {
    f = await setup();
    const files: Record<string, string> = {};
    for (let i = 0; i < 40_000; i++) files[`skills-main/s${i}/SKILL.md`] = `---\nname: s${i}\ndescription: x\n---\n`;
    const deps = { ...skillDeps(), fetch: fakeGithub({ archive: zip(files) }).fetch };
    const started = Date.now();
    const refusal = await importSkillFromUrl(deps, f.owner.id, f.org.id, "https://github.com/acme/skills").catch(
      (e: ValidationError) => e,
    );
    expect(refusal).toMatchObject({ code: "skill.too_many_skills" });
    // Every folder found looked up among those above it, never compared with each skill found before it.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a kit published for other agents installs: one skill in skills/<name>/, thousands of files, the rest of the repository left out", async () => {
    f = await setup();
    const blob = new Uint8Array(1_400_000);
    const files: Record<string, string | Uint8Array> = {
      "skills-main/README.md": "# Kit",
      "skills-main/.claude-plugin/marketplace.json": "{}",
      "skills-main/assets/wordmark.png": PNG,
      "skills-main/examples/v2/coffee.webp": blob,
      "skills-main/skills/kit/SKILL.md": "---\nname: kit\ndescription: >-\n  Dá bom gosto\n  às páginas.\n---\n# Kit",
      "skills-main/skills/kit/scripts/consistency.mjs": "x".repeat(885_000),
    };
    for (let i = 0; i < 930; i++) files[`skills-main/skills/kit/assets/icons/i${i}.svg`] = "<svg/>".repeat(800);
    for (let i = 0; i < 150; i++) files[`skills-main/skills/kit/assets/fx/c${i}/component.js`] = "y".repeat(10_000);
    for (let i = 0; i < 20; i++) files[`skills-main/skills/kit/assets/photos/p${i}.webp`] = blob;
    const deps = { ...skillDeps(), fetch: fakeGithub({ archive: zip(files) }).fetch };
    const skill = await importSkillFromUrl(deps, f.owner.id, f.org.id, "https://github.com/acme/skills");
    if ("choices" in skill) throw new Error("expected one skill installed");
    expect(skill).toMatchObject({
      name: "kit",
      description: "Dá bom gosto às páginas.",
      sourceUrl: "https://github.com/acme/skills/tree/HEAD/skills/kit",
    });
    expect(skill.files).toHaveLength(1101);
    expect(skill.files.filter((x) => x.status === "ignored")).toEqual([]);
    expect(skill.files.some((x) => /README|marketplace|coffee/.test(x.path))).toBe(false);
  });

  test("past the limits the refusal says the skill's own number; a repository past the archive's cap has its code", async () => {
    f = await setup();
    const url = "https://github.com/acme/skills";
    const md = "---\nname: kit\ndescription: Grande.\n---\n# Kit";
    const many: Record<string, string> = { "skills-main/SKILL.md": md };
    for (let i = 1; i <= SKILL_LIMITS.maxFiles; i++) many[`skills-main/f${i}.md`] = "y";
    await expect(
      importSkillFromUrl(
        { ...skillDeps(), fetch: fakeGithub({ archive: zip(many) }).fetch },
        f.owner.id,
        f.org.id,
        url,
      ),
    ).rejects.toMatchObject({ code: "skill.too_many_files", params: { files: 3001, max: 3000 } });
    const wide = { "skills-main/SKILL.md": md, "skills-main/big.md": "x".repeat(SKILL_LIMITS.maxBytes) };
    await expect(
      importSkillFromUrl(
        { ...skillDeps(), fetch: fakeGithub({ archive: zip(wide) }).fetch },
        f.owner.id,
        f.org.id,
        url,
      ),
    ).rejects.toMatchObject({ code: "skill.too_large", params: { size: 16.1, max: 16 } });
    const archive = new Uint8Array(50 * 1024 * 1024 + 1);
    await expect(
      importSkillFromUrl({ ...skillDeps(), fetch: fakeGithub({ archive }).fetch }, f.owner.id, f.org.id, url),
    ).rejects.toMatchObject({ code: "skill.repo_too_large", params: { max: 50 } });
    expect(await listSkills(f.db, f.owner.id, f.org.id)).toEqual([]);
  });

  test("a repository archive past 65,535 files is refused, never read in part", async () => {
    f = await setup();
    const files: Record<string, string> = {};
    for (let i = 0; i < 65_500; i++) files[`skills-main/aaa/f${i}.txt`] = "x";
    files["skills-main/big/SKILL.md"] = "---\nname: big\ndescription: Muitos arquivos.\n---\n# Big";
    for (let i = 0; i < 100; i++) files[`skills-main/big/f${i}.md`] = "y";
    const deps = { ...skillDeps(), fetch: fakeGithub({ archive: zip(files, { zip64: true }) }).fetch };
    const url = "https://github.com/acme/skills/tree/main/big";
    await expect(importSkillFromUrl(deps, f.owner.id, f.org.id, url)).rejects.toThrow("Too many files to read");
    expect(await listSkills(f.db, f.owner.id, f.org.id)).toEqual([]);
  });

  test("errors say what happened: a hidden repository, a missing ref, GitHub limiting us, no SKILL.md", async () => {
    f = await setup();
    const refusal = async (url: string, github = fakeGithub()) => {
      const err = await importSkillFromUrl({ ...skillDeps(), fetch: github.fetch }, f.owner.id, f.org.id, url).then(
        () => null,
        (e: ValidationError | TooManyError) => e,
      );
      return { kind: err?.constructor.name, code: err?.code, params: err?.params };
    };
    expect(await refusal("https://github.com/acme/secret/tree/main/x")).toEqual({
      kind: "ValidationError",
      code: "github.repo_missing",
      params: { repo: "acme/secret", connection: "none", app: false },
    });
    expect(await refusal("https://github.com/acme/skills/tree/v9/relatorio-semanal")).toEqual({
      kind: "ValidationError",
      code: "github.ref_missing",
      params: { repo: "acme/skills", ref: "v9" },
    });
    expect(await refusal("https://github.com/acme/skills/tree/main/docs")).toEqual({
      kind: "ValidationError",
      code: "skill.no_skill_md",
      params: { path: "acme/skills/docs" },
    });
    expect(await refusal("https://github.com/acme/skills", fakeGithub({ limited: { "retry-after": "120" } }))).toEqual({
      kind: "TooManyError",
      code: "github.limited",
      params: { count: 2 },
    });
    // The REST API's way: a 403 with none remaining until the reset.
    const reset = String(Math.floor(Date.now() / 1000) + 290);
    const spent = fakeGithub({ limited: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }, status: 403 });
    expect(await refusal("https://github.com/acme/skills", spent)).toMatchObject({ params: { count: 5 } });
  });

  test("images and videos are kept apart from the text's limit, up to their own; past it they are only listed", async () => {
    f = await setup();
    // A repository shaped like a real one: a video and screenshots past 2 MB next to a little Markdown.
    const url = "https://github.com/acme/skills";
    const media = zip({
      "skills-main/SKILL.md": SKILL_MD,
      "skills-main/assets/demo.mp4": "x".repeat(2_200_000),
      "skills-main/assets/shot.jpg": "x".repeat(670_000),
      "skills-main/references/pricing.md": "# Pricing",
    });
    const skill = await importSkillFromUrl(
      { ...skillDeps(), fetch: fakeGithub({ archive: media }).fetch },
      f.owner.id,
      f.org.id,
      url,
    );
    expect("files" in skill && skill.files.map((x) => [x.path, x.status])).toEqual([
      ["assets/demo.mp4", "stored"],
      ["assets/shot.jpg", "stored"],
      ["references/pricing.md", "stored"],
    ]);
    expect("files" in skill && skill.files.find((x) => x.path === "assets/shot.jpg")).toMatchObject({
      mime: "image/jpeg",
      size: 670_000,
    });

    const book = zip({ "skills-main/SKILL.md": SKILL_MD, "skills-main/book.md": "x".repeat(SKILL_LIMITS.maxBytes) });
    await expect(
      importSkillFromUrl({ ...skillDeps(), fetch: fakeGithub({ archive: book }).fetch }, f.owner.id, f.org.id, url),
    ).rejects.toThrow("MB of text and scripts");

    // The same in a zip: images past the limit in all are listed and never inflated, a big text file is refused.
    const zipped = await importSkillZip(
      skillDeps(),
      f.owner.id,
      f.org.id,
      zip({
        "SKILL.md": SKILL_MD,
        "assets/shot.png": "x".repeat(2_200_000),
        "assets/huge.png": "x".repeat(SKILL_LIMITS.assetBytes),
      }),
    );
    expect(zipped.files.map((x) => [x.path, x.status, x.size])).toEqual([
      ["assets/huge.png", "ignored", SKILL_LIMITS.assetBytes],
      ["assets/shot.png", "stored", 2_200_000],
    ]);
    await expect(
      importSkillZip(
        skillDeps(),
        f.owner.id,
        f.org.id,
        zip({ "SKILL.md": SKILL_MD, "book.md": "x".repeat(SKILL_LIMITS.maxBytes) }),
      ),
    ).rejects.toThrow("MB of text and scripts");
  });
});

const CONNECTION_TOKEN = "ghp_fake_connection_token";
const APP_TOKEN = "ghs_fake_app_token";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP: GitHubAppConfig = {
  appId: "123",
  privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
};

/** acme/private as the API's zipball holds it (`{owner}-{repo}-{commit}/`): two skills and a video. */
const PRIVATE = {
  "acme-private-0123abc/team/deploy/SKILL.md":
    "---\nname: deploy\ndescription: Antes de qualquer deploy.\n---\n# Deploy",
  "acme-private-0123abc/team/deploy/demo.mp4": "x".repeat(2_200_000),
  "acme-private-0123abc/team/review/SKILL.md": "---\nname: review\ndescription: Revisa um pull request.\n---\n# Review",
};

/**
 * Fake GitHub where acme/private is private: github.com answers 404 for it, and the API's zipball answers a token that
 * sees it with a redirect to codeload carrying a short-lived link of its own. A token GitHub doesn't take is answered
 * 401, one that doesn't see the repository 404 (`sees`, changed by a test as GitHub's side changes). `installed`: the
 * GitHub App is installed on it (installation 77); `installation.status` is what the app's lookup gets instead.
 */
function privateGithub(options: { installed?: boolean } = {}) {
  const requests: { url: string; auth: string | null }[] = [];
  const valid = new Set([CONNECTION_TOKEN, APP_TOKEN]);
  const sees = new Set([CONNECTION_TOKEN, APP_TOKEN]);
  const installation = { status: options.installed ? 200 : 404 };
  const fetch = async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    requests.push({ url, auth });
    const token = auth?.replace(/^Bearer /, "") ?? "";
    if (url === "https://api.github.com/repos/acme/private/installation") {
      const { status } = installation;
      return status === 200 ? Response.json({ id: 77 }) : new Response("installation", { status });
    }
    if (url === "https://api.github.com/app/installations/77/access_tokens") {
      return Response.json({ token: APP_TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    // The app's own requests go with a JWT (`ey…`); any other token GitHub doesn't take is refused.
    if (url.startsWith("https://api.github.com/") && token && !token.startsWith("ey") && !valid.has(token)) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    if (sees.has(token) && /^https:\/\/api\.github\.com\/repos\/acme\/private\/zipball(\/main)?$/.test(url)) {
      const location = "https://codeload.github.com/acme/private/legacy.zip/refs/heads/main?token=short-lived";
      return new Response(null, { status: 302, headers: { location } });
    }
    if (sees.has(token) && url === "https://api.github.com/repos/acme/private") {
      return Response.json({ full_name: "acme/private", private: true });
    }
    if (url === "https://codeload.github.com/acme/private/legacy.zip/refs/heads/main?token=short-lived") {
      return new Response(zip(PRIVATE));
    }
    return new Response("404: Not Found", { status: 404 });
  };
  return { fetch, requests, sees, installation };
}

/** The GitHub App installed for the fixture's workspace on `account` (installation `id`). */
const installApp = (account = "acme", id = 77) =>
  f.db.insert(schema.githubAppInstallations).values({
    orgId: f.org.id,
    installationId: id,
    accountLogin: account,
    accountType: "Organization",
    repositorySelection: "selected",
    createdByUserId: f.owner.id,
  });

/** What a refused read says: its code and params. */
const refusalOf = (read: Promise<unknown>) =>
  read.then(
    () => null,
    (e: ValidationError) => ({ code: e.code, params: e.params }),
  );

describe("private repositories", () => {
  const connectors = () => ({ db: f.db, keyWrappers: [f.keyWrapper], publicUrl: "https://agentes.test" });
  const connectGithub = () =>
    createApiKeyConnection(connectors(), f.owner.id, f.org.id, { connector: "github", apiKey: CONNECTION_TOKEN });

  test("read with the workspace's GitHub connection, its token sent to api.github.com only; updating reads through it", async () => {
    f = await setup();
    const github = privateGithub();
    const deps = { ...skillDeps(), fetch: github.fetch, github: { connectors: connectors() } };
    const url = "https://github.com/acme/private";
    // No GitHub connected: the link looks private or missing, nothing tried.
    expect(await importSkillFromUrl(deps, f.owner.id, f.org.id, url).catch((e) => e)).toMatchObject({
      code: "github.repo_missing",
      params: { repo: "acme/private", connection: "none", app: false },
    });

    const connection = await connectGithub();
    const listed = await importSkillFromUrl(deps, f.owner.id, f.org.id, url);
    expect(listed).toEqual({
      choices: [
        { path: "team/deploy", name: "deploy", description: "Antes de qualquer deploy." },
        { path: "team/review", name: "review", description: "Revisa um pull request." },
      ],
      via: "github",
    });
    // Without credentials first; the token only to the API, never to codeload.
    expect(github.requests.slice(-3)).toEqual([
      { url: "https://github.com/acme/private/archive/HEAD.zip", auth: null },
      { url: "https://api.github.com/repos/acme/private/zipball", auth: `Bearer ${CONNECTION_TOKEN}` },
      { url: "https://codeload.github.com/acme/private/legacy.zip/refs/heads/main?token=short-lived", auth: null },
    ]);
    expect(github.requests.filter((r) => r.auth && !r.url.startsWith("https://api.github.com/"))).toEqual([]);

    // The same limits as a public link: the video is kept.
    const [deploy] = await importPickedSkills(deps, f.owner.id, f.org.id, url, ["team/deploy"]);
    expect(deploy).toMatchObject({ name: "deploy", sourceVia: "github" });
    expect(deploy?.files.map((x) => [x.path, x.status])).toEqual([["demo.mp4", "stored"]]);

    // Updating reads through the connection again, not without credentials first.
    const before = github.requests.length;
    expect(await reimportSkill(deps, f.owner.id, f.org.id, deploy?.id ?? "")).toMatchObject({ version: 2 });
    expect(github.requests.slice(before).map((r) => r.url)).toEqual([
      "https://api.github.com/repos/acme/private/zipball",
      "https://codeload.github.com/acme/private/legacy.zip/refs/heads/main?token=short-lived",
    ]);

    // Disconnected: updating says the connection that read it is gone.
    await revokeConnection(f.db, f.owner.id, f.org.id, connection.id);
    expect(await reimportSkill(deps, f.owner.id, f.org.id, deploy?.id ?? "").catch((e) => e)).toMatchObject({
      code: "skill.connection_gone",
      params: { repo: "acme/private" },
    });
  });

  test("the GitHub App's token for the repository comes first; a ref, a repository none reaches, and who may read", async () => {
    f = await setup();
    await installApp();
    await connectGithub();
    const github = privateGithub({ installed: true });
    const deps = { ...skillDeps(), fetch: github.fetch, github: { connectors: connectors(), app: APP } };
    const folder = "https://github.com/acme/private/tree/main/team/review";
    const skill = (await importSkillFromUrl(deps, f.owner.id, f.org.id, folder)) as SkillDetail;
    expect(skill).toMatchObject({ name: "review", sourceUrl: folder, sourceVia: "github_app" });
    expect(github.requests.map((r) => r.auth).filter(Boolean)).not.toContain(`Bearer ${CONNECTION_TOKEN}`);
    expect(github.requests.at(-2)).toEqual({
      url: "https://api.github.com/repos/acme/private/zipball/main",
      auth: `Bearer ${APP_TOKEN}`,
    });

    // `list`: the one skill a folder holds, to pick, nothing installed again; it says it replaces the one installed.
    expect(await importSkillFromUrl(deps, f.owner.id, f.org.id, folder, { list: true })).toEqual({
      choices: [{ path: "team/review", name: "review", description: "Revisa um pull request.", replaces: "installed" }],
      via: "github_app",
    });
    expect(await listSkills(f.db, f.owner.id, f.org.id)).toMatchObject([{ name: "review", version: 1 }]);

    // A ref the repository lacks, told apart from a repository the token can't see.
    const v9 = "https://github.com/acme/private/tree/v9/team/review";
    expect(await importSkillFromUrl(deps, f.owner.id, f.org.id, v9).catch((e) => e)).toMatchObject({
      code: "github.ref_missing",
      params: { repo: "acme/private", ref: "v9" },
    });
    // Neither the app nor the connection reaches it: private or missing, with a connection that works.
    expect(
      await importSkillFromUrl(deps, f.owner.id, f.org.id, "https://github.com/acme/other").catch((e) => e),
    ).toMatchObject({ code: "github.repo_missing", params: { repo: "acme/other", connection: "ok", app: true } });

    // Reading through the workspace's GitHub is installing skills: a member who may not is refused before any read.
    const member = await addMember(f.db, f.org.id, "member");
    const before = github.requests.length;
    await expect(importSkillFromUrl(deps, member.id, f.org.id, folder)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(importPickedSkills(deps, member.id, f.org.id, folder, ["team/review"])).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(reimportSkill(deps, member.id, f.org.id, skill.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(github.requests.length).toBe(before);
  });

  test("updating falls back to the workspace's other GitHub connection when the one that read it no longer can, and keeps it", async () => {
    f = await setup();
    await installApp();
    const connection = await connectGithub();
    const github = privateGithub({ installed: true });
    const deps = { ...skillDeps(), fetch: github.fetch, github: { connectors: connectors(), app: APP } };
    const folder = "https://github.com/acme/private/tree/main/team/review";
    const skill = (await importSkillFromUrl(deps, f.owner.id, f.org.id, folder)) as SkillDetail;
    expect(skill.sourceVia).toBe("github_app");

    // The repository left the app's installation: the connection reads it, and is the one updating reads through now.
    github.sees.delete(APP_TOKEN);
    github.installation.status = 404;
    expect(await reimportSkill(deps, f.owner.id, f.org.id, skill.id)).toMatchObject({
      version: 2,
      sourceVia: "github",
    });
    // And back: the connection gone, the app reaching it again.
    await revokeConnection(f.db, f.owner.id, f.org.id, connection.id);
    github.sees.add(APP_TOKEN);
    github.installation.status = 200;
    expect(await reimportSkill(deps, f.owner.id, f.org.id, skill.id)).toMatchObject({
      version: 3,
      sourceVia: "github_app",
    });
  });

  test("updating says GitHub didn't answer when it didn't, and that the connection is gone only when the workspace lost it", async () => {
    f = await setup();
    await installApp();
    const github = privateGithub({ installed: true });
    const deps = { ...skillDeps(), fetch: github.fetch, github: { connectors: connectors(), app: APP } };
    const skill = (await importSkillFromUrl(
      deps,
      f.owner.id,
      f.org.id,
      "https://github.com/acme/private/tree/main/team/review",
    )) as SkillDetail;
    expect(skill.sourceVia).toBe("github_app");
    forgetInstallationTokens(77);

    // GitHub failing to answer the app's lookup is a refusal to try again, never a connection gone.
    github.installation.status = 502;
    expect(await refusalOf(reimportSkill(deps, f.owner.id, f.org.id, skill.id))).toEqual({
      code: "github.unreachable",
      params: undefined,
    });
    // Still installed on acme, the repository no longer in it: hidden, with the app on some account.
    github.installation.status = 404;
    expect(await refusalOf(reimportSkill(deps, f.owner.id, f.org.id, skill.id))).toEqual({
      code: "github.repo_missing",
      params: { repo: "acme/private", connection: "none", app: true },
    });
    // Uninstalled from acme: now the connection that read it is gone.
    await f.db.delete(schema.githubAppInstallations).where(eq(schema.githubAppInstallations.installationId, 77));
    expect(await refusalOf(reimportSkill(deps, f.owner.id, f.org.id, skill.id))).toEqual({
      code: "skill.connection_gone",
      params: { repo: "acme/private" },
    });
  });

  test("a repository none reads says how the connection fared: a token GitHub refuses, the app on another account", async () => {
    f = await setup();
    const github = privateGithub();
    const deps = { ...skillDeps(), fetch: github.fetch, github: { connectors: connectors(), app: APP } };
    const url = "https://github.com/acme/private";
    await createApiKeyConnection(connectors(), f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_fake_revoked_token",
    });
    expect(await refusalOf(importSkillFromUrl(deps, f.owner.id, f.org.id, url))).toEqual({
      code: "github.repo_missing",
      params: { repo: "acme/private", connection: "refused", app: false },
    });

    // No connection, the app installed for this workspace on another account only.
    const [connection] = await listConnections(f.db, f.owner.id, f.org.id);
    await revokeConnection(f.db, f.owner.id, f.org.id, connection?.id ?? "");
    await installApp("contoso", 88);
    expect(await refusalOf(importSkillFromUrl(deps, f.owner.id, f.org.id, url))).toEqual({
      code: "github.repo_missing",
      params: { repo: "acme/private", connection: "none", app: true },
    });
  });

  test("a link whose owner, repository or ref climbs out of the repository is never read with a token", async () => {
    f = await setup();
    await installApp();
    await connectGithub();
    const github = privateGithub({ installed: true });
    const deps = { ...skillDeps(), fetch: github.fetch, github: { connectors: connectors(), app: APP } };
    for (const url of [
      "https://github.com/acme/private/tree/..%2F..%2Fuser/x",
      "https://github.com/acme/..%2F..%2Fuser",
      "https://github.com/..%2F..%2Fuser/x",
      "https://raw.githubusercontent.com/acme/private/..%2F..%2Fuser/x/SKILL.md",
      // Dot segments the URL itself resolves: no owner or repository left to read.
      "https://github.com/%2E%2E/user",
      "https://github.com/acme/%2E%2E",
    ]) {
      const refusal = await refusalOf(importSkillFromUrl(deps, f.owner.id, f.org.id, url));
      expect([url, ["github.repo_missing", "skill.not_github_link"].includes(refusal?.code ?? "")]).toEqual([
        url,
        true,
      ]);
    }
    expect(github.requests.filter((r) => r.auth)).toEqual([]);
  });
});

describe("runtime", () => {
  test("the prompt lists only the agent's enabled skills; load_skill returns the body; read_skill_file a file", async () => {
    let step = 0;
    f = await setup({
      skillTools: true,
      reply: (req: ModelRequest) => {
        step++;
        if (step === 1) return { chunks: [], toolUses: [{ name: "load_skill", input: { name: "relatorio-semanal" } }] };
        if (step === 2)
          return {
            chunks: [],
            toolUses: [
              { name: "read_skill_file", input: { name: "relatorio-semanal", path: "templates/relatorio.md" } },
            ],
          };
        if (step === 3)
          return {
            chunks: [],
            toolUses: [{ name: "read_skill_file", input: { name: "relatorio-semanal", path: "run.sh" } }],
          };
        return { chunks: [JSON.stringify(req.messages.length)] };
      },
    });
    expect((await listAgentScopes(f.db, f.org.id, f.agent.id)).map((g) => g.scope)).toContain("skills:read");
    const mine = await importSkillZip(
      skillDeps(),
      f.owner.id,
      f.org.id,
      zip({ "SKILL.md": SKILL_MD, "templates/relatorio.md": "# Semana {{n}}", "run.sh": "echo" }),
    );
    await saveSkill(skillDeps(), f.owner.id, f.org.id, {
      name: "outra-skill",
      description: "Não é deste agente.",
      body: "x",
      metadata: {},
      source: "manual",
    });
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: mine.id, enabled: true }]);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev faz o relatório semanal",
    });
    await drainOutbox(f.db, f.handlers);

    const prompt = systemText(f.provider.calls[0]?.request.system ?? "");
    expect(prompt).toContain("# Available skills");
    expect(prompt).toContain("- relatorio-semanal: Escreve o relatório semanal");
    expect(prompt).not.toContain("outra-skill");
    const results = (await f.db.select().from(schema.agentRunSteps))
      .filter((s) => s.kind === "tool_result")
      .map((s) => s.data as { name: string; content: string; isError: boolean });
    expect(results[0]).toMatchObject({ name: "load_skill", isError: false });
    expect(results[0]?.content).toContain('Skill "relatorio-semanal" (v1) loaded.');
    expect(results[0]?.content).toContain("1. Junte as entregas da semana.");
    expect(results[0]?.content).toContain("run.sh (script: runs with run_skill_script");
    expect(results[0]?.content).not.toContain("echo");
    expect(results[1]).toMatchObject({ name: "read_skill_file", isError: false });
    expect(results[1]?.content).toContain("# Semana {{n}}");
    expect(results[2]).toMatchObject({ name: "read_skill_file", isError: true });
  });

  test("read_skill_file shows an image to a model brain; a PDF is described; files too large say so", async () => {
    const reads = [
      "references/diagram.png",
      "references/photo.png",
      "references/manual.pdf",
      "references/big.jpg",
      "references/huge.webp",
    ];
    let step = 0;
    f = await setup({
      skillTools: true,
      reply: () => {
        const path = reads[step++];
        return path
          ? { chunks: [], toolUses: [{ name: "read_skill_file", input: { name: "relatorio-semanal", path } }] }
          : { chunks: ["ok"] };
      },
    });
    const skill = await importSkillZip(
      skillDeps(),
      f.owner.id,
      f.org.id,
      zip({
        "SKILL.md": SKILL_MD,
        "references/diagram.png": PNG,
        "references/photo.png": "GIF89a",
        "references/manual.pdf": "%PDF-1.4",
        "references/big.jpg": Uint8Array.from(
          { length: SKILL_LIMITS.imageBytes + 1 },
          (_, i) => [0xff, 0xd8, 0xff][i] ?? 0,
        ),
        "references/huge.webp": "x".repeat(SKILL_LIMITS.assetBytes),
      }),
    );
    expect(skill.files.map((x) => [x.path, x.status])).toEqual([
      ["references/big.jpg", "stored"],
      ["references/diagram.png", "stored"],
      ["references/huge.webp", "ignored"],
      ["references/manual.pdf", "stored"],
      ["references/photo.png", "stored"],
    ]);
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: skill.id, enabled: true }]);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev olha o diagrama",
    });
    await drainOutbox(f.db, f.handlers);

    // The image goes to the model with the tool's result, as base64 of its bytes.
    const results = f.provider.calls.flatMap((c) =>
      c.request.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content)),
    );
    const diagram = results.find((b) => b.type === "tool_result" && b.content.includes("diagram.png"));
    expect(diagram).toMatchObject({
      images: [{ mediaType: "image/png", data: Buffer.from(PNG).toString("base64") }],
    });
    // Its type from its bytes, never its name: an API refuses an image sent under another type.
    const photo = results.find((b) => b.type === "tool_result" && b.content.includes("photo.png"));
    expect(photo).toMatchObject({ images: [{ mediaType: "image/gif" }] });
    const steps = (await f.db.select().from(schema.agentRunSteps))
      .filter((s) => s.kind === "tool_result")
      .map((s) => s.data as { content: string; isError: boolean });
    expect(steps[0]?.content).toBe(
      "relatorio-semanal/references/diagram.png (image/png, 8 bytes): the image is attached.",
    );
    // Never the bytes in the run's steps.
    expect(JSON.stringify(steps)).not.toContain(Buffer.from(PNG).toString("base64"));
    expect(steps[2]).toMatchObject({ isError: false });
    expect(steps[2]?.content).toContain(
      "manual.pdf (application/pdf, 8 bytes): not text, so its content isn't shown here.",
    );
    expect(steps[3]?.content).toContain("It is too large to show you here (max 3.6 MB).");
    expect(steps[4]).toMatchObject({ isError: true });
    expect(steps[4]?.content).toContain("huge.webp (40.0 MB) was not kept: a skill keeps up to 40 MB of images");
  });

  test("denying the tools hides them; other orgs never see the skill", async () => {
    f = await setup({ skillTools: true, reply: () => ({ chunks: ["ok"] }) });
    const skill = await importSkillZip(skillDeps(), f.owner.id, f.org.id, zip({ "SKILL.md": SKILL_MD }));
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: skill.id, enabled: true }]);
    await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, {
      all: true,
      connectors: {},
      scopes: [],
      tools: {
        allow: [],
        deny: [
          { connectionId: null, name: "load_skill" },
          { connectionId: null, name: "read_skill_file" },
        ],
      },
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
    await drainOutbox(f.db, f.handlers);
    const request = f.provider.calls[0]?.request;
    expect(request?.tools?.map((t) => t.name) ?? []).not.toContain("load_skill");
    expect(systemText(request?.system ?? "")).not.toContain("# Available skills");

    const other = await addUser(f.db, "zed");
    const { organization } = await createOrganization(f.db, other.id, { name: "Outra" });
    await expect(getSkill(f.db, other.id, organization.id, skill.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: crypto.randomUUID(), enabled: true }]),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("files, counts and delete", () => {
  const folder = {
    "relatorio-semanal/SKILL.md": SKILL_MD,
    "relatorio-semanal/templates/relatorio.md": "# Semana {{n}}",
    "relatorio-semanal/run.sh": "echo no",
  };

  test("a stored file by version; ignored files are 404", async () => {
    f = await setup();
    const v1 = await importSkillZip(skillDeps(), f.owner.id, f.org.id, zip(folder));
    await importSkillZip(
      skillDeps(),
      f.owner.id,
      f.org.id,
      zip({ ...folder, "relatorio-semanal/templates/relatorio.md": "# Semana v2" }),
    );
    const current = await getSkillFile(skillDeps(), f.owner.id, f.org.id, v1.id, "templates/relatorio.md");
    expect(current).toMatchObject({ version: 2, mime: "text/markdown", content: "# Semana v2" });
    const old = await getSkillFile(skillDeps(), f.owner.id, f.org.id, v1.id, "templates/relatorio.md", 1);
    expect(old.content).toBe("# Semana {{n}}");
    await expect(getSkillFile(skillDeps(), f.owner.id, f.org.id, v1.id, "run.sh")).rejects.toThrow(/script/);
    await expect(getSkillFile(skillDeps(), f.owner.id, f.org.id, v1.id, "run.sh")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(getSkillFile(skillDeps(), f.owner.id, f.org.id, v1.id, "nope.md")).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // A picture an older import only listed: reinstalling keeps it now. A kept one isn't text for this route.
    const pictured = await importSkillZip(
      skillDeps(),
      f.owner.id,
      f.org.id,
      zip({ ...folder, "relatorio-semanal/a.png": "PNG" }),
    );
    await expect(getSkillFile(skillDeps(), f.owner.id, f.org.id, pictured.id, "a.png")).rejects.toThrow(
      "not a text file (image/png, 3 bytes)",
    );
    await f.db
      .update(schema.skillFiles)
      .set({ status: "ignored", blobKey: null, size: 0 })
      .where(eq(schema.skillFiles.path, "a.png"));
    await expect(getSkillFile(skillDeps(), f.owner.id, f.org.id, pictured.id, "a.png")).rejects.toThrow(
      "a.png was installed before skills kept images and other files that aren't text: ask a person to reinstall the skill",
    );
  });

  test("agentsCount; deleting keeps assignments and the same name again brings them back", async () => {
    f = await setup();
    const skill = await importSkillZip(skillDeps(), f.owner.id, f.org.id, zip(folder));
    expect((await listSkills(f.db, f.owner.id, f.org.id))[0]).toMatchObject({ id: skill.id, agentsCount: 0 });
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: skill.id, enabled: true }]);
    expect((await listSkills(f.db, f.owner.id, f.org.id))[0]?.agentsCount).toBe(1);

    await deleteSkill(f.db, f.owner.id, f.org.id, skill.id);
    expect(await listSkills(f.db, f.owner.id, f.org.id)).toEqual([]);
    expect(await enabledSkills(f.db, f.org.id, f.agent.id)).toEqual([]);
    await expect(getSkill(f.db, f.owner.id, f.org.id, skill.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await f.db.select().from(schema.agentSkills)).toHaveLength(1);

    const back = await saveSkill(skillDeps(), f.owner.id, f.org.id, {
      ...parseSkillMarkdown(SKILL_MD),
      source: "manual",
    });
    expect(back).toMatchObject({ id: skill.id, version: 2 });
    expect((await enabledSkills(f.db, f.org.id, f.agent.id)).map((s) => s.id)).toEqual([skill.id]);
    expect((await listSkills(f.db, f.owner.id, f.org.id))[0]?.agentsCount).toBe(1);
    const audit = await f.db.select().from(schema.auditLog);
    expect(audit.some((a) => a.action === "skill.restored")).toBe(true);
  });
});

describe("agent.tool detail", () => {
  test("only the safe field of built-in tools, ≤ 80 chars", () => {
    expect(toolDetail("load_skill", { name: "relatorio-semanal" })).toBe("relatorio-semanal");
    expect(toolDetail("read_skill_file", { name: "relatorio-semanal", path: "templates/a.md" })).toBe(
      "relatorio-semanal/templates/a.md",
    );
    expect(toolDetail("create_issue", { title: "Corrigir login", body: "segredo" })).toBe("Corrigir login");
    expect(toolDetail("update_issue", { issue: "131", status: "done" })).toBe("#131");
    expect(toolDetail("comment_issue", { issue: "#7", text: "x" })).toBe("#7");
    expect(toolDetail("create_artifact", { title: "Relatório Q3", content: "..." })).toBe("Relatório Q3");
    expect(toolDetail("create_issue", { title: "a".repeat(200) })?.length).toBe(80);
    expect(toolDetail("search_context", { query: "salários" })).toBeUndefined();
    expect(toolDetail("load_skill", { name: 42 })).toBeUndefined();
  });
});
