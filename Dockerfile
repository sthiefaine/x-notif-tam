# Use Node.js 20 LTS
FROM node:20-alpine

# DATABASE_URL est nécessaire au build (la page d'accueil lit la base via
# unstable_cache lors du prerender).
ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL

# curl utile pour les health-checks / crons
RUN apk add --no-cache curl

# Verify Node.js version
RUN node --version && npm --version

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm install

# Generate Prisma client
RUN npx prisma generate

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Expose port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
