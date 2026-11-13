#!/bin/sh
# `PATCHELF` for linuxdeploy while the Linux AppImage is bundled (.github/workflows/desktop.yml): every call goes to
# the patchelf linuxdeploy would use, except setting an rpath on the two sidecars, which keep their bytes as built
# (and as the deb ships them). linuxdeploy gives every file in usr/bin an rpath; rewriting the runner, a single-file
# Bun executable, left it unreadable on ARM64 ("Failed to run ldd" when the GTK plugin's pass reached it), and
# neither sidecar needs one: they load nothing but the system's C library, which an AppImage never carries.
set -eu

# linuxdeploy's own patchelf sits next to it (in its AppImage); linuxdeploy is the process that runs this.
real="$(dirname "$(readlink -f "/proc/$PPID/exe")")/patchelf"
[ -x "$real" ] || real="$(command -v patchelf)"

if [ "${1:-}" = "--set-rpath" ] && [ "$#" -eq 3 ]; then
  case "$(basename "$3")" in
    agentes-runner | agent-browser)
      echo "Keeping $3 as built (no rpath)" >&2
      exit 0
      ;;
  esac
fi
exec "$real" "$@"
