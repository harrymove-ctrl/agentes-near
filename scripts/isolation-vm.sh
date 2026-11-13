#!/usr/bin/env bash
# CI's isolation-root job: boots a distribution's cloud image in QEMU and runs the isolation test there as root.
# Debian 13 has its own kernel and a systemd built with BPF_FRAMEWORK, which the agents' bind policy needs; Ubuntu
# 24.04 has its own kernel and a systemd without it, so the policy is left out there, and Chrome. The test runs
# with the toolchain an Android build needs under that policy (Debian's JDK and adb, Gradle, and the
# Kotlin compile daemon Gradle fetches), Xtigervnc as the agents' desktops run it, cron and at, and bpftool to
# count the bind programs on a slice. The guest's second serial port is this job's log (its console, where a getty starts, goes to
# a file), and the test's exit code comes back on it.
# Usage: scripts/isolation-vm.sh <bundled test> <runner bundle> <image folder (kept between runs)> [debian13|ubuntu]
set -euo pipefail
test_js=$1 runner=$2 images=$3 distro=${4:-debian13}
# A dated build of the distribution's own cloud image (its standard kernel, as on a VPS), checked against the
# checksums published beside it.
case $distro in
  debian13)
    image_url=https://cloud.debian.org/images/cloud/trixie/20261026-2643/debian-13-generic-amd64-20261026-2643.qcow2
    image_sum=5bd891c6e62d01639f52a5587b72a4607421e445732214be787dba6043cf9797a6ff90bed982aada6a6c7e619f1f956d961c4fad76757171abd607920aac098a
    image_check=sha512sum
    ;;
  ubuntu)
    image_url=https://cloud-images.ubuntu.com/noble/20261017/noble-server-cloudimg-amd64.img
    image_sum=04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94
    image_check=sha256sum
    ;;
  *)
    echo "Unknown distribution: $distro (debian13 or ubuntu)" >&2
    exit 2
    ;;
esac
# Gradle's distribution, checked against the SHA-256 Gradle publishes beside it (services.gradle.org).
gradle_version=8.14.3
gradle_url=https://services.gradle.org/distributions/gradle-$gradle_version-bin.zip
gradle_sha256=bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531
work=${RUNNER_TEMP:-/tmp}/isolation-vm
image=$images/$distro.qcow2
gradle=$images/gradle-$gradle_version-bin.zip

mkdir -p "$images"
if ! echo "$image_sum  $image" | "$image_check" -c --quiet - > /dev/null 2>&1; then
  curl -fsSL --retry 3 -o "$image" "$image_url"
  echo "$image_sum  $image" | "$image_check" -c --quiet -
fi
if ! echo "$gradle_sha256  $gradle" | sha256sum -c --quiet - > /dev/null 2>&1; then
  curl -fsSL --retry 3 -o "$gradle" "$gradle_url"
  echo "$gradle_sha256  $gradle" | sha256sum -c --quiet -
fi
rm -rf "$work"
mkdir -p "$work/seed"
qemu-img create -q -f qcow2 -F qcow2 -b "$image" "$work/disk.qcow2" 12G

# The NoCloud seed (volume cidata): cloud-init's files, and what the guest runs.
seed=$work/seed
cp "$test_js" "$seed/isolation.root.test.js"
cp "$runner" "$seed/agentes-runner.mjs"
cp "$(command -v bun)" "$seed/bun"
cp "$gradle" "$seed/gradle.zip"
printf '%s\n' "$distro" > "$seed/distro"
printf 'instance-id: isolation\nlocal-hostname: isolation\n' > "$seed/meta-data"
cat > "$seed/user-data" << 'EOF'
#cloud-config
runcmd:
  - mkdir -p /mnt/seed
  - mount -o ro LABEL=cidata /mnt/seed
  - sh /mnt/seed/guest.sh
EOF
cat > "$seed/guest.sh" << 'EOF'
#!/bin/sh
# In the guest, as root: the test, then its exit code, on ttyS1, then off.
code=0
sh /mnt/seed/run.sh > /dev/ttyS1 2>&1 || code=$?
echo "ISOLATION-EXIT $code" > /dev/ttyS1
poweroff
EOF
cat > "$seed/run.sh" << 'EOF'
set -eu
export DEBIAN_FRONTEND=noninteractive
echo "== Linux $(uname -r)"
systemctl --version | head -2
distro=$(cat /mnt/seed/distro)
# A first boot's own package runs may hold the lock for a while.
apt="apt-get -qq -o DPkg::Lock::Timeout=300"
$apt update
if [ "$distro" = debian13 ]; then
  systemctl --version | grep -q '+BPF_FRAMEWORK' || { echo "This systemd has no BPF_FRAMEWORK"; exit 1; }
  # bpftool counts the bind programs on a slice.
  $apt install -y --no-install-recommends bpftool > /dev/null
else
  # Chrome as people install it, for the test that runs it as an agent.
  curl -fsSL --retry 3 -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  $apt install -y /tmp/chrome.deb > /dev/null
  google-chrome --version
fi
$apt install -y --no-install-recommends nftables default-jdk-headless adb unzip cron at \
  tigervnc-standalone-server xauth x11-xkb-utils xkb-data > /dev/null
# Gradle where the agents' users run it, as GitHub's image has it.
unzip -q /mnt/seed/gradle.zip -d /opt
ln -sf /opt/gradle-*/bin/gradle /usr/bin/gradle
java -version 2>&1 | head -1
gradle --version | grep -E '^(Gradle|Kotlin)'
adb version | head -1
mkdir -p /root/isolation
cp /mnt/seed/bun /mnt/seed/isolation.root.test.js /root/isolation/
chmod 755 /root/isolation/bun
cd /root/isolation
AGENTES_ROOT_TESTS=1 AGENTES_TEST_RUNNER=/mnt/seed/agentes-runner.mjs ./bun test ./isolation.root.test.js
EOF
genisoimage -quiet -output "$work/seed.iso" -volid cidata -rational-rock "$seed"

accel=tcg cpu=max
if [ -e /dev/kvm ]; then
  sudo chmod 666 /dev/kvm
  accel=kvm cpu=host
fi
echo "QEMU with $accel"
timeout 40m qemu-system-x86_64 -machine "q35,accel=$accel" -cpu "$cpu" -smp 4 -m 8192 \
  -drive "file=$work/disk.qcow2,if=virtio" \
  -drive "file=$work/seed.iso,media=cdrom,readonly=on" \
  -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
  -display none -serial "file:$work/console.log" -serial stdio -no-reboot < /dev/null | tee "$work/out.log" || true
if ! tr -d '\r' < "$work/out.log" | grep -Eq 'ISOLATION-EXIT 0$'; then
  echo "== The guest's console"
  tail -n 100 "$work/console.log"
  exit 1
fi
