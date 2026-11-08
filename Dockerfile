# Chromium système pour le mode navigateur ; aucun téléchargement au démarrage.
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium curl ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV TZ=Europe/Paris

# Verify Node.js version
RUN node --version && npm --version

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci

# Generate Prisma client
RUN npx prisma generate

# Copy source code
COPY . .

# Build the application
RUN npm run build

RUN mkdir -p /app/.x-browser && chown -R node:node /app
USER node

# Expose port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
