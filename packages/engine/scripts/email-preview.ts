/**
 * Every email, as people get it, from the samples the tests use:
 *
 *   bun packages/engine/scripts/email-preview.ts [outDir]
 *
 * writes `<id>.html`, `<id>.txt` (with its subject and preheader) and `index.json` into `outDir`
 * (default `packages/engine/scripts/out/`). The pictures come from `apps/web/public/email/`, so the files
 * open from disk; the dark design shows when the browser's developer tools emulate
 * `prefers-color-scheme: dark`. No browser, database or network.
 *
 *   bun packages/engine/scripts/email-preview.ts --send you@example.com
 *
 * mails every sample to that address through the sender in `.env` (`MILLIONSEND_API_KEY` or `SMTP_URL`,
 * `EMAIL_FROM`), with the pictures as `EMAIL_ART` and `PUBLIC_URL` say: attached unless the server's
 * address is public. For trying them in real mail clients.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createMillionSendSender, createSmtpEmailSender } from "@agenteschat/adapters";
import { defaultEmailFrom, emailArtFor, renderEmail } from "../src/email";
import { EMAIL_SAMPLES, PERSONAL_EMAIL_SAMPLES } from "../test/email-samples";

const webDir = resolve(import.meta.dir, "../../../apps/web/public");
const args = process.argv.slice(2);
const to = args.includes("--send") ? args[args.indexOf("--send") + 1] : undefined;

if (to) {
  const env = process.env;
  const publicUrl = env.PUBLIC_URL ?? "http://localhost:3000";
  const from = env.EMAIL_FROM ?? defaultEmailFrom(publicUrl);
  const sender = env.MILLIONSEND_API_KEY
    ? createMillionSendSender({ apiKey: env.MILLIONSEND_API_KEY, baseURL: env.MILLIONSEND_API_URL, from })
    : env.SMTP_URL
      ? createSmtpEmailSender({ url: env.SMTP_URL, from })
      : null;
  if (!sender) throw new Error("Set MILLIONSEND_API_KEY or SMTP_URL in .env to send the samples.");
  const art = await emailArtFor(publicUrl, webDir, env.EMAIL_ART === "attach" ? "attach" : "auto");
  for (const [id, template] of Object.entries(EMAIL_SAMPLES)) {
    const { subject, html, text, inline } = renderEmail(template, art);
    await sender.send({ to: [to], subject, html, text, inline, idempotencyKey: `preview:${id}:${Date.now()}` });
    console.log("sent", id);
  }
} else {
  const out = resolve(args[0] ?? join(import.meta.dir, "out"));
  mkdirSync(out, { recursive: true });
  const base = `${relative(out, join(webDir, "email"))}/`;
  const index: Record<string, { subject: string; preheader: string }> = {};
  const samples = {
    ...EMAIL_SAMPLES,
    // A personal workspace's (ADR 0159), where its words differ.
    ...PERSONAL_EMAIL_SAMPLES,
    // A self-hosted server: its footer names it.
    "verify_email-selfhost.en": EMAIL_SAMPLES["verify_email.en"],
  };
  for (const [id, template] of Object.entries(samples)) {
    if (!template) continue;
    const home = id.endsWith("selfhost.en") ? "https://chat.alvesstudio.com" : "https://agentes.chat";
    const email = renderEmail(template, { home, base, files: null });
    writeFileSync(join(out, `${id}.html`), email.html);
    writeFileSync(join(out, `${id}.txt`), `Subject: ${email.subject}\nPreheader: ${email.preheader}\n\n${email.text}`);
    index[id] = { subject: email.subject, preheader: email.preheader };
  }
  writeFileSync(join(out, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  console.log(Object.keys(index).length, "emails in", out);
}
