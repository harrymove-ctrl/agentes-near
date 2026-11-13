import { expect, test } from "bun:test";
import { scrubSignIns } from "../src/tool-detail";

const NOTE = "[removed]";
const fake = (prefix: string, n = 24) => `${prefix}${"x".repeat(n)}`;

test("the right hand's reply: keys, tokens and a sign-in file's values become the note, the rest stays", () => {
  const app = `ghs_123_eyJhbGciOiJSUzI1NiJ9.${"e".repeat(40)}.${"s-ig_".repeat(8)}`;
  const cases: [string, string][] = [
    [`here: ${fake("sk-ant-oat01-")} ok`, `here: ${NOTE} ok`],
    [`refresh ${fake("sk-ant-ort01-")}`, `refresh ${NOTE}`],
    [fake("sk-proj-"), NOTE],
    [fake("sk-"), NOTE],
    [`cursor ${fake("key_", 64)}`, `cursor ${NOTE}`],
    [fake("crsr_", 40), NOTE],
    [`token ${fake("rt_", 30)}.`, `token ${NOTE}.`],
    // Codex's own `auth.json` refresh token today.
    [`token ${fake("rt.", 40)}.${"y".repeat(20)}`, `token ${NOTE}`],
    [`jwt eyJ${"F".repeat(12)}.${"F".repeat(12)}.${"F".repeat(12)}`, `jwt ${NOTE}`],
    // GitHub's stateless App token (`ghs_<app id>_<JWT>`): all of it, dots and dashes included.
    [`fetch ${app} failed`, `fetch ${NOTE} failed`],
    ['{"refresh_token": "abcdefgh12345678"}', `{"refresh_token": ${NOTE}}`],
    ['{"accessToken":"abcdefgh12345678","x":1}', `{"accessToken":${NOTE},"x":1}`],
    ["id_token=abcdefgh12345678", `id_token=${NOTE}`],
    ["OPENAI_API_KEY: abcdefgh12345678", `OPENAI_API_KEY: ${NOTE}`],
    ["-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----", NOTE],
  ];
  for (const [text, want] of cases) {
    const out = scrubSignIns(text, NOTE);
    expect(out.text).toBe(want);
    expect(out.found).toBeGreaterThan(0);
  }
});

test("plain words about sign-ins stay as they are", () => {
  for (const text of [
    "Sign in with your Claude plan in Settings › AI accounts.",
    "Paste the API key in the card's dialog, never here.",
    "Your refresh token lives on the computer, I can't see it.",
    "skills and keys are set up per agent",
  ]) {
    expect(scrubSignIns(text, NOTE)).toEqual({ text, found: 0 });
  }
});
