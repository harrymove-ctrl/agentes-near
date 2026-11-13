# Security policy

agentes.chat keeps organizations' model keys and connector credentials, and its agents act with
real permissions. We take reports seriously and appreciate coordinated disclosure.

## Reporting a vulnerability

**Please do not open a public issue.** Instead:

1. Use GitHub's private vulnerability reporting: in this repository, go to
   **Security → Report a vulnerability**. This is the preferred channel.
2. If that's not possible, email **security@agentes.chat**.

You'll get an acknowledgment within 72 hours. Please include reproduction steps, the version (the
image tag, or `version` from `/api/health`) and the deployment type (agentes.chat Cloud or
self-hosted).

## Scope

This repository (the server, the web app, the runner, and the phone and desktop apps) and
agentes.chat Cloud. Most wanted: anything that crosses an organization's boundary, gets past a
person's role, an agent's scopes or an approval, or exposes a stored key. A prompt that only makes
an agent misuse access it was given is a known limit of agents; report it when our defaults make it
easier than they should.

For self-hosted instances, issues in third-party software (Postgres, Docker, your reverse proxy, a
model provider) go to those projects, but if our default configuration makes one unsafe, that's
ours and we want to know. Fixes ship in new releases: keep instances on the latest one
([SELF_HOSTING.md](SELF_HOSTING.md), Upgrades).
