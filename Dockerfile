# The detector shells out to git for the sparse clone of the help center repo
# and needs Node 22 for the Supabase client. Railway's default builder image
# ships neither guarantee, so the image is declared here instead.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
CMD ["node", "src/index.js"]
