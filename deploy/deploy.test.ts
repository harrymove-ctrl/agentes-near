import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "agentes-deploy-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** An executable stand-in on a PATH of its own. */
function stub(bin: string, name: string, script: string) {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), script);
  chmodSync(join(bin, name), 0o755);
}

// deploy.sh itself, run against git repositories of its own and a stand-in for docker that records every call.
describe("deploy/deploy.sh", () => {
  const origin = join(dir, "origin.git");
  const bin = join(dir, "bin");
  const identity = {
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const commits = { first: "", second: "", third: "" };
  let runs = 0;

  function git(cwd: string, ...args: string[]): string {
    const run = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...identity } });
    if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
    return run.stdout.toString().trim();
  }

  function commit(work: string, notes: string): string {
    writeFileSync(join(work, "notes"), notes);
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", notes);
    return git(work, "rev-parse", "HEAD");
  }

  beforeAll(() => {
    git(dir, "init", "--quiet", "--bare", "--initial-branch=main", origin);
    const work = join(dir, "work");
    git(dir, "clone", "--quiet", origin, work);
    mkdirSync(join(work, "deploy/speech"), { recursive: true });
    copyFileSync(join(root, "deploy/deploy.sh"), join(work, "deploy/deploy.sh"));
    writeFileSync(join(work, "deploy/speech/Dockerfile"), "FROM scratch\n");
    writeFileSync(join(work, ".gitignore"), ".env\n");
    commits.first = commit(work, "first");
    commits.second = commit(work, "second");
    // A later version whose compose file has a service the versions before it don't have.
    writeFileSync(join(work, "services"), "postgres\nagentes\nnewcomer\nspeech\n");
    commits.third = commit(work, "third");
    git(work, "push", "--quiet", "origin", "HEAD:main");

    // `compose config` answers as for an .env with AGENTES_IMAGE=agentes:current and no backup profile, or with the
    // services in the checkout's `services`, else the state's. Files in the state make the speech image's build, the
    // speech service's start or the app's health check fail.
    stub(
      bin,
      "docker",
      `#!/usr/bin/env bash
set -euo pipefail
state=$STUB_STATE
printf '%s\\n' "\${AGENTES_IMAGE:+AGENTES_IMAGE=$AGENTES_IMAGE }docker $*" >>"$state/calls"
id_of() { awk -v tag="$1" '$1 == tag { id = $2 } END { if (id == "") exit 1; print id }' "$state/tags"; }
tag() { { grep -v "^$1 " "$state/tags" || true; echo "$1 $2"; } >"$state/tags.new" && mv "$state/tags.new" "$state/tags"; }
case "$*" in
"compose config --images") printf 'pgvector/pgvector:0.8.7-pg18\\nagentes:current\\n' ;;
"compose config --services") cat services 2>/dev/null || cat "$state/services" 2>/dev/null || printf 'postgres\\nagentes\\n' ;;
"image inspect --format {{index"*) cat "$state/speech-label" 2>/dev/null ;;
"image inspect --format "*) id_of "$5" ;;
"build "*" -") cat >"$state/dockerfile" && tag agentes:next sha256:versioned ;;
"build "*" deploy/speech") [[ ! -f $state/speech-fails ]] && echo "\${4#*=}" >"$state/speech-label" ;;
"compose up --detach speech") [[ ! -f $state/speech-down ]] ;;
"compose up --detach --wait "*) [[ ! -f $state/unhealthy ]] ;;
"build "*) tag agentes:next sha256:new ;;
"tag "*) tag "$3" "$(id_of "$2" || echo "$2")" ;;
"compose exec -T postgres psql "*)
  left=$(cat "$state/dumping")
  if ((left > 0)); then echo $((left - 1)) >"$state/dumping" && echo 1; fi ;;
esac
`,
    );
    stub(bin, "sleep", `#!/bin/sh\necho "sleep $*" >>"$STUB_STATE/calls"\n`);
  });

  /**
   * A server's checkout at `at` with this .env, where `agentes:current` is the image `sha256:old`, and the next
   * `dumping` looks at the database find a dump running.
   */
  function server(at: string, env: string, dumping = 0) {
    runs += 1;
    const path = join(dir, `server-${runs}`);
    const state = join(dir, `state-${runs}`);
    git(dir, "clone", "--quiet", origin, path);
    git(path, "checkout", "--quiet", "--detach", at);
    writeFileSync(join(path, ".env"), env);
    mkdirSync(state);
    writeFileSync(join(state, "tags"), "agentes:current sha256:old\n");
    writeFileSync(join(state, "calls"), "");
    writeFileSync(join(state, "dumping"), String(dumping));
    return {
      state,
      head: () => git(path, "rev-parse", "HEAD"),
      deploy(args: string[]) {
        const run = Bun.spawnSync(["bash", join(path, "deploy/deploy.sh"), ...args], {
          cwd: dir,
          env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, STUB_STATE: state, ...identity },
        });
        const calls = readFileSync(join(state, "calls"), "utf8").split("\n").filter(Boolean);
        return { code: run.exitCode, out: `${run.stdout}${run.stderr}`, calls };
      },
    };
  }

  const cloud = [
    "AGENTES_IMAGE=agentes:current",
    "RUN_MIGRATIONS_ON_BOOT=false",
    "MACHINE_PROVISIONING=external",
    "S3_ENDPOINT=https://account.r2.cloudflarestorage.com",
    'S3_BUCKET="agentes-files"',
    "S3_ACCESS_KEY_ID=key",
    "S3_SECRET_ACCESS_KEY=secret",
  ];

  test("a Cloud server with its files' bucket: built, migrated before the switch, up with a wait past the image's start period", () => {
    const at = server(commits.first, `${cloud.join("\n")}\n`);
    const { code, out, calls } = at.deploy([commits.second]);
    expect({ code, out }).toMatchObject({ code: 0 });
    expect(at.head()).toBe(commits.second);
    const steps = [
      "docker build --tag agentes:next .",
      "AGENTES_IMAGE=agentes:next docker compose run --rm agentes migrate",
      "docker tag agentes:next agentes:current",
      "docker compose up --detach --wait --wait-timeout ",
    ].map((step) => calls.findIndex((call) => call.startsWith(step)));
    expect(steps.filter((index) => index < 0)).toEqual([]);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    // A version that boots slowly but well is not rolled back: the wait outlasts the health check's start period.
    const wait = Number(/--wait-timeout (\d+)/.exec(calls[steps[3] ?? -1] ?? "")?.[1]);
    const startPeriod = Number(/--start-period=(\d+)s/.exec(readFileSync(join(root, "Dockerfile"), "utf8"))?.[1]);
    expect(startPeriod).toBeGreaterThan(0);
    expect(wait).toBeGreaterThan(startPeriod);
  });

  test("a Cloud server without its files' bucket stops before anything is built: files would live on its disk alone", () => {
    for (const lacking of ["S3_BUCKET", "S3_SECRET_ACCESS_KEY"]) {
      const env = cloud.map((line) => (line.replace(/"/g, "").startsWith(`${lacking}=`) ? `${lacking}=` : line));
      const at = server(commits.first, `${env.join("\n")}\n`);
      const { code, out, calls } = at.deploy([commits.second]);
      expect(code).toBe(1);
      expect(out).toContain(`MACHINE_PROVISIONING=external, so files go to the S3_* bucket, and it lacks ${lacking}`);
      expect(out).toContain("Files already on this server's disk are not moved");
      expect(at.head()).toBe(commits.first);
      expect(calls.filter((call) => call.startsWith("docker build") || call.includes(" migrate"))).toEqual([]);
    }
    // A test server that keeps its files on its disk on purpose says so, and deploys without a bucket.
    const test = cloud.filter((line) => !line.startsWith("S3_")).concat("FILES_ON_DISK=accepted");
    expect(server(commits.first, `${test.join("\n")}\n`).deploy([commits.second]).code).toBe(0);
    // A self-hosted server keeps its files where it likes (FILES_DIR or Postgres).
    const selfHosted = server(commits.first, "AGENTES_IMAGE=agentes:current\nRUN_MIGRATIONS_ON_BOOT=false\n");
    expect(selfHosted.deploy([commits.second]).code).toBe(0);
  });

  test("a version as the second argument goes into the image as APP_VERSION, through the commit's own script", () => {
    const env = "AGENTES_IMAGE=agentes:current\nRUN_MIGRATIONS_ON_BOOT=false\n";
    const at = server(commits.first, env);
    const { code, out, calls } = at.deploy([commits.second, "2026.10.31.4"]);
    expect({ code, out }).toMatchObject({ code: 0 });
    expect(out).toContain("(2026.10.31.4) is live");
    const steps = [
      "docker build --tag agentes:next .",
      "docker build --quiet --tag agentes:next -",
      "AGENTES_IMAGE=agentes:next docker compose run --rm agentes migrate",
    ].map((step) => calls.findIndex((call) => call.startsWith(step)));
    expect(steps.filter((index) => index < 0)).toEqual([]);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(readFileSync(join(at.state, "dockerfile"), "utf8")).toBe(
      "FROM agentes:next\nENV APP_VERSION=2026.10.31.4\n",
    );

    // Without one, the image is the commit's build alone, as before.
    const plain = server(commits.first, env).deploy([commits.second]);
    expect(plain.code).toBe(0);
    expect(plain.calls.filter((call) => call.endsWith(" -"))).toEqual([]);

    const bad = server(commits.first, env);
    const refused = bad.deploy([commits.second, "1.0; rm -rf /"]);
    expect(refused.code).toBe(2);
    expect(refused.out).toContain("not a version");
    expect(refused.calls).toEqual([]);
  });

  test("the speech service never holds the app: built only when deploy/speech changed, started once the app is live, its failures only said", () => {
    const env =
      "AGENTES_IMAGE=agentes:current\nRUN_MIGRATIONS_ON_BOOT=false\nAGENTES_SPEECH_IMAGE=agentes-speech:current\n";
    const withSpeech = (...trouble: string[]) => {
      const at = server(commits.first, env);
      writeFileSync(join(at.state, "services"), "postgres\nagentes\nspeech\n");
      for (const file of trouble) writeFileSync(join(at.state, file), "");
      return at;
    };
    const index = (calls: string[], start: string) => calls.findIndex((call) => call.startsWith(start));

    const at = withSpeech();
    const first = at.deploy([commits.second]);
    expect({ code: first.code, out: first.out }).toMatchObject({ code: 0 });
    const tree = git(join(dir, `server-${runs}`), "rev-parse", "HEAD:deploy/speech");
    const build = `docker build --quiet --label agentes.speech=${tree} --tag agentes-speech:current deploy/speech`;
    // The app's wait names its services, never speech, and the speech image builds only after the app is live.
    expect(first.calls).toContain("docker compose up --detach --wait --wait-timeout 150 postgres agentes");
    expect(index(first.calls, build)).toBeGreaterThan(index(first.calls, "docker compose up --detach --wait"));
    expect(index(first.calls, "docker compose up --detach speech")).toBeGreaterThan(index(first.calls, build));
    expect(first.out).toContain("building the speech image");
    // The next deploy of the same folder finds its label and builds nothing.
    const again = at.deploy([commits.second]);
    expect(again.calls.filter((call) => call.endsWith(" deploy/speech"))).toHaveLength(1);

    for (const [trouble, said] of [
      ["speech-fails", "the speech image didn't build"],
      ["speech-down", "the speech service didn't start"],
    ]) {
      const run = withSpeech(trouble).deploy([commits.second]);
      expect({ code: run.code }).toEqual({ code: 0 });
      expect(run.out).toContain(said);
      expect(run.out).toContain("is live");
    }

    // An app that doesn't get healthy goes back without speech, which is neither built nor started.
    const failed = withSpeech("unhealthy").deploy([commits.second]);
    expect(failed.code).toBe(1);
    expect(failed.calls.filter((call) => call.startsWith("docker compose up --detach --wait"))).toEqual([
      "docker compose up --detach --wait --wait-timeout 150 postgres agentes",
      "docker compose up --detach --wait --wait-timeout 150 postgres agentes",
    ]);
    expect(failed.calls.filter((call) => call.includes("speech"))).toEqual([]);
  });

  test("a rollback brings up the previous version's own services, never ones only the new compose file has", () => {
    const at = server(commits.second, "AGENTES_IMAGE=agentes:current\nRUN_MIGRATIONS_ON_BOOT=false\n");
    writeFileSync(join(at.state, "unhealthy"), "");
    const run = at.deploy([commits.third]);
    expect(run.code).toBe(1);
    expect(at.head()).toBe(commits.second);
    expect(run.calls.filter((call) => call.startsWith("docker compose up --detach --wait"))).toEqual([
      "docker compose up --detach --wait --wait-timeout 150 postgres agentes newcomer",
      "docker compose up --detach --wait --wait-timeout 150 postgres agentes",
    ]);
  });

  test("a dump in progress holds every table: the migration waits for it to end, and one that outlasts the wait stops the deploy", () => {
    const env = "AGENTES_IMAGE=agentes:current\nRUN_MIGRATIONS_ON_BOOT=false\n";
    const looks = (calls: string[]) =>
      calls.flatMap((call) =>
        call.startsWith("docker compose exec -T postgres psql") ? ["look"] : call.startsWith("sleep ") ? [call] : [],
      );

    const at = server(commits.first, env, 2);
    const { code, out, calls } = at.deploy([commits.second]);
    expect({ code, out }).toMatchObject({ code: 0 });
    const migrate = calls.findIndex((call) => call.includes(" migrate"));
    expect(looks(calls.slice(0, migrate))).toEqual(["look", "sleep 10", "look", "sleep 10", "look"]);
    expect(looks(calls.slice(migrate))).toEqual([]);

    const stuck = server(commits.first, env, 1000);
    const run = stuck.deploy([commits.second]);
    expect(run.code).toBe(1);
    expect(run.out).toContain("a dump of the database is still running after 5 minutes");
    expect(run.calls.filter((call) => call.includes(" migrate") || call.startsWith("docker tag"))).toEqual([]);
    expect(stuck.head()).toBe(commits.first);
  });
});

// The backup service's schedule, with stand-ins for the clock, the bucket and the wait: the stand-in for `sleep`
// writes down how long the service would wait for its next dump, then stops it.
describe("deploy/backup/backup.sh", () => {
  const bin = join(dir, "backup-bin");
  // Thursday 2026-10-29, 10:20 UTC.
  const now = Date.UTC(2026, 9, 29, 10, 20) / 1000;

  beforeAll(() => {
    copyFileSync(join(root, "deploy/backup/backup.sh"), join(dir, "backup.sh"));
    chmodSync(join(dir, "backup.sh"), 0o755);
    // A dump from a moment ago is in the bucket, so the service goes straight to its schedule.
    stub(
      bin,
      "rclone",
      `#!/bin/sh\necho "$*" >>"$STUB_STATE/rclone"\ncase "$*" in *lsf*) echo agentes-20261029-100000.dump ;; esac\n`,
    );
    stub(bin, "date", `#!/bin/sh\ncase "$*" in *+%s*) echo "${now}" ;; *) exec /bin/date "$@" ;; esac\n`);
    stub(bin, "sleep", `#!/bin/sh\necho "$1" >"$STUB_STATE/sleep"\nkill -TERM "$PPID"\n`);
  });

  function schedule(hours?: string) {
    const state = mkdtempSync(join(dir, "backup-"));
    const run = Bun.spawnSync(["sh", join(dir, "backup.sh")], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        STUB_STATE: state,
        S3_BACKUP_BUCKET: "backups",
        ...(hours === undefined ? {} : { BACKUP_INTERVAL_HOURS: hours }),
      },
      timeout: 10_000,
    });
    return {
      err: run.stderr.toString(),
      maxAge: /--max-age (\S+)/.exec(readFileSync(join(state, "rclone"), "utf8"))?.[1],
      sleep: Number(readFileSync(join(state, "sleep"), "utf8")),
    };
  }

  test("a dump a day at 03:00 UTC by default; BACKUP_INTERVAL_HOURS dumps every that many hours from then", () => {
    // Until tomorrow 03:00; a dump younger than 26 hours at start counts.
    expect(schedule()).toMatchObject({ maxAge: "26h", sleep: 16 * 3600 + 40 * 60 });
    // Until 11:00.
    expect(schedule("1")).toMatchObject({ maxAge: "3h", sleep: 40 * 60 });
    // 03:00, 09:00, 15:00, 21:00: until 15:00.
    expect(schedule("6")).toMatchObject({ maxAge: "8h", sleep: 4 * 3600 + 40 * 60 });
  });

  test("an interval that isn't a whole number of hours says so and keeps a dump a day", () => {
    for (const hours of ["abc", "0", "1.5"]) {
      const run = schedule(hours);
      expect(run.err).toContain(`BACKUP_INTERVAL_HOURS=${hours} is not a whole number of hours`);
      expect(run).toMatchObject({ maxAge: "26h", sleep: 16 * 3600 + 40 * 60 });
    }
  });
});
