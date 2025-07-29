# Use Node.js 20 LTS
FROM node:20-alpine

# Define build arguments
ARG USER_EMAIL
ARG USER_PASSWORD
ARG DATABASE_URL
ARG TWITTER_VERIFICATION_CODE

# Install system dependencies for Puppeteer and Chromium
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    curl \
    wget \
    tar \
    brotli

# Set Puppeteer environment variables to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Set build-time environment variables from ARGs
ENV USER_EMAIL=$USER_EMAIL \
    USER_PASSWORD=$USER_PASSWORD \
    DATABASE_URL=$DATABASE_URL \
    TWITTER_VERIFICATION_CODE=$TWITTER_VERIFICATION_CODE

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