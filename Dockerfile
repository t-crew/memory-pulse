# memory-pulse http: the remote MCP server (docs/REMOTE.md). No dependencies to install.
FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY lib ./lib
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
USER node
CMD ["node", "server.mjs", "http"]
