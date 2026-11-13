#!/usr/bin/env node
// Fake xcode-select, xcodebuild, xcrun, defaults, plutil and open for the iPhone setup tests:
// `fake-xcode-tools.mjs <tool> args…`. Answers come from $FAKE_XCODE_STATE (JSON, read on every call); every call is
// logged to $FAKE_XCODE_LOG as one JSON line, [tool, ...args]. State:
//   noTools: xcode-select fails (no developer tools)   xcode: what `xcodebuild -version` names (absent: only the CLT)
//   runtimes: what `simctl list runtimes -j` lists      teams: IDEProvisioningTeamByIdentifier (absent: no account)
//   download: lines `-downloadPlatform` prints, then it waits for $FAKE_XCODE_GO to exist   downloadFail: exits 1
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [tool, ...args] = process.argv.slice(2);
appendFileSync(process.env.FAKE_XCODE_LOG, `${JSON.stringify([tool, ...args])}\n`);
const state = existsSync(process.env.FAKE_XCODE_STATE)
  ? JSON.parse(readFileSync(process.env.FAKE_XCODE_STATE, "utf8"))
  : {};
const out = (text, code = 0) => process.stdout.write(text, () => process.exit(code));
const fail = (text) => process.stderr.write(text, () => process.exit(1));

if (tool === "xcode-select") state.noTools ? fail("no developer tools\n") : out("/Applications/Xcode.app\n");
else if (tool === "xcodebuild") {
  if (args[0] === "-version")
    state.xcode ? out(`Xcode ${state.xcode}\nBuild version 17C529\n`) : fail("xcodebuild requires Xcode\n");
  else if (args[0] === "-downloadPlatform") {
    for (const line of state.download ?? []) process.stdout.write(`${line}\n`);
    const wait = setInterval(() => {
      if (!existsSync(process.env.FAKE_XCODE_GO)) return;
      clearInterval(wait);
      state.downloadFail ? fail("Download failed: the network connection was lost.\n") : out("Done.\n");
    }, 20);
  } else out("");
} else if (tool === "xcrun") out(JSON.stringify({ runtimes: state.runtimes ?? [] }));
else if (tool === "defaults") {
  writeFileSync(args.at(-1), "plist");
  out("");
} else if (tool === "plutil") state.teams ? out(JSON.stringify(state.teams)) : fail("No value at that key path\n");
else if (tool === "open") out("");
else out("", 1);
