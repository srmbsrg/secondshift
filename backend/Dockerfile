# SecondShift backend. Zero npm dependencies, so the image is just Node + the source.
# Added 2026-10-19: Railway's railpack 0.42 "prepare" step started failing for this service
# (it failed on the unchanged backend-mvp code too), so the build is pinned to this Dockerfile.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY tenants ./tenants
COPY tools ./tools
ENV NODE_ENV=production
CMD ["node", "src/server.js"]
