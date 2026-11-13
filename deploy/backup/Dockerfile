# The `backup` service of docker-compose.yml: pg_dump and rclone, nothing else. Its Postgres major
# version follows the compose file's postgres service: pg_dump refuses a newer server.
FROM postgres:18.6-alpine3.24@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
RUN apk add --no-cache rclone
COPY --chmod=755 backup.sh /usr/local/bin/backup.sh
# This entrypoint replaces the image's own, which is what steps down from root.
USER postgres
ENTRYPOINT ["/usr/local/bin/backup.sh"]
