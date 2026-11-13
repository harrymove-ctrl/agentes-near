# The `speech` service of docker-compose.yml (ADR 0100): server.py with Parakeet and the language guess. The models are
# fetched here, each from a pinned revision and checked against its sha256 (models.txt), so the service runs without
# internet. Licenses and credits: NOTICE.
FROM python:3.12.15-slim-trixie@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704 AS base

FROM base AS models
COPY models.txt /tmp/models.txt
RUN set -eu; grep -Ev '^(#|$)' /tmp/models.txt | while read -r sum _ path url; do \
      mkdir -p "$(dirname "/models/$path")"; \
      python -c 'import socket, sys, urllib.request; socket.setdefaulttimeout(60); urllib.request.urlretrieve(*sys.argv[1:])' "$url" "/models/$path"; \
      echo "$sum  /models/$path" | sha256sum -c --quiet -; \
    done

FROM base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
COPY --from=models /models /models
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --disable-pip-version-check --root-user-action=ignore --only-binary=:all: \
      --require-hashes -r /tmp/requirements.txt \
 && rm /tmp/requirements.txt
COPY server.py NOTICE /app/
# numpy's OpenBLAS would start a thread per core of the machine, past the service's CPU limit; ONNX Runtime has its own.
ENV PYTHONUNBUFFERED=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
USER 10001:10001
EXPOSE 8000
ENTRYPOINT ["python", "/app/server.py"]
