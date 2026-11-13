# Bun

The runner (`agentes-runner`) is compiled with `bun build --compile` (`.github/workflows/desktop.yml`), so the binary embeds the Bun runtime (https://github.com/oven-sh/bun) of the version in the root `package.json` (`packageManager`, Bun 1.4.4). When that version changes, take `LICENSE.md` and the two commits below from the new `bun-v<version>` tag.

- `LICENSE.md`: Bun's license and credits, from the `bun-v1.4.4` tag. Bun is MIT and statically links, among the libraries listed there, JavaScriptCore and WebCore from WebKit (GNU LGPL 2 or later) and tinycc (GNU LGPL 2.1).
- `LICENSE-LGPL-2.1.txt`: the GNU Lesser General Public License 2.1, as WebKit ships it (`Source/WebCore/LICENSE-LGPL-2.1`).

The LGPL libraries are used as Bun builds them. Their source, at the commits Bun 1.4.4 pins:

- WebKit (JavaScriptCore, WebCore): https://github.com/oven-sh/WebKit, commit `d6375c72affe0f70222cdcb45012b10f0bf3a9d5` (`scripts/build/deps/webkit.ts` in Bun).
- tinycc: https://github.com/oven-sh/tinycc, commit `05f0fafaa3be31e31d7b4b5c17dc60f62c991171` (`scripts/build/deps/tinycc.ts` in Bun).

To run the runner on a modified library: build Bun from its `bun-v1.4.4` tag with your changes (`LICENSE.md` says how), compile the runner from https://github.com/agentes-chat/agentes-chat with that `bun` (`bun build --compile apps/server/runner/main.ts --outfile agentes-runner`, without `--target`, so the binary embeds the `bun` that compiles it), put the result in place of `agentes.app/Contents/MacOS/agentes-runner` and sign the app again.
