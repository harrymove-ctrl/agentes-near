#!/usr/bin/env bash
# Deploys a commit of this repository on a server that runs docker-compose.yml from a checkout of it:
# builds the commit's image (or pulls DEPLOY_IMAGE), migrates the database while the running app still
# serves, recreates what changed and waits for it to be healthy, or goes back to the previous image
# and commit. Run it on the server, by hand or over SSH.
#   deploy/deploy.sh [SHA [VERSION]]    a commit of main, in full (default: main's tip), and this deploy's
#                                       version (2026.10.31.4), set in the image as APP_VERSION: the release
#                                       its error reports are filed under (without it, the server's own)
#
# The app restarts in place: requests fail for a few seconds while the new container boots, and up to
# about 25 s more while agent runs finish (they get 20 s, then resume in the new container). A version
# that never gets healthy keeps the app down for up to 150 s more, until the rollback.
#
# Setup: .env sets AGENTES_IMAGE=agentes:current, the tag this script moves (with the backup profile,
# AGENTES_BACKUP_IMAGE=agentes-backup:current too), and RUN_MIGRATIONS_ON_BOOT=false: this script
# migrates on every deploy, a restored dump included, and after a rollback the previous version runs
# on a database the newer one may have migrated, which a boot that migrates refuses. With
# MACHINE_PROVISIONING=external (agentes.chat Cloud), uploaded files must not live on this server's
# disk alone, so the script refuses to deploy without S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and
# S3_SECRET_ACCESS_KEY. Set them before the first upload: files already on the disk are not moved to
# the bucket, and the app stops finding them once it is set. A test server that keeps its files on its disk
# on purpose says so with FILES_ON_DISK=accepted in .env. With the speech profile, .env sets
# AGENTES_SPEECH_IMAGE=agentes-speech:current, which this script builds from deploy/speech when that
# folder changed; the speech service is optional, so it never holds a deploy or a rollback: an image
# that doesn't build, or a service that doesn't start, leaves voice messages to the next engine in
# SPEECH_ENGINES. Over SSH,
# a deploy key's line in authorized_keys can run this script alone, with the commit the caller sends:
#   command="/srv/agentes/deploy/deploy.sh $SSH_ORIGINAL_COMMAND",restrict ssh-ed25519 AAAA...
# With DEPLOY_IMAGE=ghcr.io/agentes-chat/agentes:edge before the script's path there, it pulls the
# image CI publishes instead of building one.
#
# Back by hand to the version that ran before the current one (one step; the next deploy moves on):
#   git checkout --quiet --detach refs/deploy/previous && docker tag agentes:previous agentes:current
#   docker compose up --detach --wait $(docker compose config --services | grep -vx speech)
set -euo pipefail

main() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  if [[ -n ${1:-} && ! $1 =~ ^[0-9a-f]{40}$ ]]; then
    echo "deploy: not a full commit SHA: $1" >&2
    return 2
  fi
  local version=${2:-}
  if [[ -n $version && ! $version =~ ^[A-Za-z0-9_.+-]{1,64}$ ]]; then
    echo "deploy: not a version (letters, digits, . _ + -): $version" >&2
    return 2
  fi
  [[ -n ${DEPLOY_PREVIOUS:-} ]] || git fetch --quiet origin main
  local target head
  target=$(git rev-parse --verify "${1:-origin/main}^{commit}")
  if ! git merge-base --is-ancestor "$target" origin/main; then
    echo "deploy: ${target:0:7} is not on main" >&2
    return 2
  fi
  head=$(git rev-parse HEAD)
  if [[ $target != "$head" ]]; then
    # CI run again on an older commit must not take production back to it.
    if git merge-base --is-ancestor "$target" "$head"; then
      echo "deploy: ${target:0:7} is older than the checkout (${head:0:7}), nothing to do"
      return 0
    fi
    git checkout --quiet --detach "$target"
    # The commit's own version of this script does the rest.
    DEPLOY_PREVIOUS=$head exec bash deploy/deploy.sh "$target" ${version:+"$version"}
  fi
  local previous=${DEPLOY_PREVIOUS:-$head}
  # Until the new version is healthy, a failure puts the checkout back on the commit that runs.
  trap 'git checkout --quiet --detach "$previous"' ERR

  if ! docker compose config --images | grep -x 'agentes:current' >/dev/null ||
    ! grep -qx 'RUN_MIGRATIONS_ON_BOOT=false' .env; then
    echo "deploy: .env needs AGENTES_IMAGE=agentes:current and RUN_MIGRATIONS_ON_BOOT=false (top of deploy/deploy.sh)" >&2
    false
  fi
  if grep -Eq "^MACHINE_PROVISIONING=[\"']?external([\"'[:space:]#]|$)" .env && ! grep -qx 'FILES_ON_DISK=accepted' .env; then
    local key missing=""
    for key in S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
      grep -Eq "^${key}=[\"']?[^\"'[:space:]#]" .env || missing+=" $key"
    done
    if [[ -n $missing ]]; then
      echo "deploy: .env sets MACHINE_PROVISIONING=external, so files go to the S3_* bucket, and it lacks${missing} (top of deploy/deploy.sh). Files already on this server's disk are not moved: once the bucket is set, the app stops finding them." >&2
      false
    fi
  fi
  echo "deploy: ${target:0:7}${version:+ ($version)}"
  if [[ -n ${DEPLOY_IMAGE:-} ]]; then
    docker pull --quiet "$DEPLOY_IMAGE"
    docker tag "$DEPLOY_IMAGE" agentes:next
  else
    docker build --tag agentes:next .
  fi
  if [[ -n $version ]]; then
    # In the image, not in the container's environment: a rollback to it, or a restart by hand, keeps its version.
    docker build --quiet --tag agentes:next - <<<$'FROM agentes:next\nENV APP_VERSION='"$version" >/dev/null
  fi
  if docker compose config --services | grep -x backup >/dev/null; then
    docker build --quiet --tag agentes-backup:current deploy/backup
  fi

  # A dump in progress (the backup service's pg_dump) holds every table until it ends: a migration that
  # changes one would wait for it, and the running app's requests to that table would wait behind it.
  local waited=0
  while [[ $(docker compose exec -T postgres psql -U agentes -d agentes -tAc \
    "select 1 from pg_stat_activity where application_name = 'pg_dump' and datname = current_database() limit 1" \
    2>/dev/null) == 1 ]]; do
    if ((waited >= 300)); then
      echo "deploy: a dump of the database is still running after 5 minutes, deploy again once it ends" >&2
      false
    fi
    sleep 10
    waited=$((waited + 10))
  done
  # Before the swap, so a migration that fails leaves the running app serving.
  AGENTES_IMAGE=agentes:next docker compose run --rm agentes migrate
  local current next
  current=$(docker image inspect --format '{{.Id}}' agentes:current 2>/dev/null || true)
  next=$(docker image inspect --format '{{.Id}}' agentes:next)
  docker tag agentes:next agentes:current
  local services
  mapfile -t services < <(docker compose config --services | grep -vx speech)
  # Past the image's health check start period (120 s, Dockerfile): a slow boot isn't a broken version.
  if ! docker compose up --detach --wait --wait-timeout 150 "${services[@]}"; then
    docker compose logs --no-color --tail 50 agentes >&2 || true
    echo "deploy: ${target:0:7} is not healthy, going back to ${previous:0:7}" >&2
    git checkout --quiet --detach "$previous"
    if [[ -n $current ]]; then
      docker tag "$current" agentes:current
    fi
    # The previous commit's services: the new compose file may name one the previous file doesn't have.
    mapfile -t services < <(docker compose config --services | grep -vx speech)
    docker compose up --detach --wait --wait-timeout 150 "${services[@]}" || echo "deploy: the rollback is not healthy either" >&2
    return 1
  fi
  trap - ERR
  # Moved only once the new version is healthy, so a failed deploy leaves the way back as it was.
  if [[ -n $current && $current != "$next" ]]; then
    docker tag "$current" agentes:previous
    git update-ref refs/deploy/previous "$previous"
  fi
  # The speech service, once the app is live: built again only when deploy/speech changed (the image's
  # label says), and not waited for, since its models load while the next engine answers. A download that
  # stalls ends the build after 15 minutes.
  local speech
  if docker compose config --services | grep -x speech >/dev/null && speech=$(git rev-parse HEAD:deploy/speech 2>/dev/null); then
    if [[ $(docker image inspect --format '{{index .Config.Labels "agentes.speech"}}' agentes-speech:current 2>/dev/null) != "$speech" ]]; then
      echo "deploy: building the speech image (about 1 GB of models the first time)"
      timeout 900 docker build --quiet --label "agentes.speech=$speech" --tag agentes-speech:current deploy/speech >/dev/null ||
        echo "deploy: the speech image didn't build; voice messages go to the next engine until a deploy builds it" >&2
    fi
    docker compose up --detach speech >/dev/null 2>&1 ||
      echo "deploy: the speech service didn't start; voice messages go to the next engine" >&2
  fi
  docker image prune --force >/dev/null
  docker builder prune --force --filter until=24h >/dev/null
  echo "deploy: ${target:0:7}${version:+ ($version)} is live"
}

# The checkout changes under this file while it runs: bash has read all of it once this line starts.
main "$@"; exit
