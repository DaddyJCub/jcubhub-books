FROM node:18-alpine

# Image labels
LABEL org.opencontainers.image.title="JcubHub Books"
LABEL org.opencontainers.image.description="Book request and library portal with Readarr/CWA integration"
LABEL org.opencontainers.image.source="https://github.com/DaddyJCub/jcubhub-books"
LABEL org.opencontainers.image.licenses="MIT"

# Install build tools for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy application code
COPY . .

# Copy frontend assets from parent directory during build
# Note: In docker-compose, we mount/copy books-landing-page to public

# Data directory will be created by the app or mounted as volume
# Setting DATA_PATH env var to ensure consistent path
ENV DATA_PATH=/app/data

# Create data directory (will be overwritten by volume mount if used)
RUN mkdir -p /app/data

# Expose port 3003 (unified server)
EXPOSE 3003

# Set environment variable for port
ENV PORT=3003

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3003/api/health || exit 1

CMD ["node", "server.js"]