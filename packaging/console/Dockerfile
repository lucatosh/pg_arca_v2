# pg_arca console image. Build context: the extracted release package (pg-arca-console-<version>-linux-x64/), e.g.
#   docker build -t pg-arca-console:$(cat VERSION) .
#   docker run -d --name pg-arca-console -p 3000:3000 -v pg-arca-console:/var/lib/pg-arca-console pg-arca-console:$(cat VERSION)
#   docker logs pg-arca-console        (first start: the setup code for the administrator account)
# TLS: mount the PEM files and set PG_ARCA_TLS_CERT / PG_ARCA_TLS_KEY, or put a TLS reverse proxy in front (PG_ARCA_TRUST_PROXY=1, PG_ARCA_COOKIE_SECURE=1).
# Pin the base image by digest in your own registry for reproducible builds.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
COPY VERSION server.mjs /opt/pg-arca-console/
COPY dist /opt/pg-arca-console/dist
COPY unix-agent /opt/pg-arca-console/unix-agent
COPY healthcheck.cjs /opt/pg-arca-console/healthcheck.cjs
RUN useradd --system --uid 10001 --home-dir /var/lib/pg-arca-console --shell /usr/sbin/nologin pgarca-console \
 && install -d -m 0700 -o 10001 -g 10001 /var/lib/pg-arca-console \
 && chmod -R go-w /opt/pg-arca-console
ENV NODE_ENV=production PG_ARCA_DATA_DIR=/var/lib/pg-arca-console PORT=3000
USER 10001
WORKDIR /var/lib/pg-arca-console
VOLUME /var/lib/pg-arca-console
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["node", "/opt/pg-arca-console/healthcheck.cjs"]
STOPSIGNAL SIGTERM
CMD ["node", "/opt/pg-arca-console/server.mjs"]
