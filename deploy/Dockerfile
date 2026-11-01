# DeepSeek Harness with Hodos, for self-hosting. Build from the repository root:
#
#   docker build -f deploy/Dockerfile -t hodos .
#
# or use deploy/docker-compose.yml. See docs/self-hosting.md.
FROM node:24-bookworm-slim

# bash and hostname run the scripts. git and curl are tools the agent's shell commonly needs;
# add more here if you want the agent to be able to use them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl git hostname \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@11.28.5

# Everything the Harness may change at run time lives in /data (its home: settings,
# sign-in secret, sessions, Hodos records) and /workspace (the agent's working directory).
ENV DSH_PREFIX=/opt/dsh \
    DSH_HOME=/data/dsh \
    HODOS_WORKSPACE=/workspace \
    HODOS_PORT=8787
RUN mkdir -p /opt/hodos /opt/dsh /data /workspace \
 && chown -R node:node /opt/hodos /opt/dsh /data /workspace

USER node
WORKDIR /opt/hodos
COPY --chown=node:node . /opt/hodos
RUN deploy/install.sh build

VOLUME ["/data", "/workspace"]
EXPOSE 8787
WORKDIR /workspace
ENTRYPOINT ["/opt/hodos/deploy/docker-entrypoint.sh"]
