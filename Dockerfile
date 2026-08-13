# Multi-stage build for etteum-pool
FROM oven/bun:1 AS base

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    wget \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json bun.lockb* ./
COPY dashboard/package.json dashboard/

# Install dependencies
RUN bun install --frozen-lockfile || bun install
RUN cd dashboard && (bun install --frozen-lockfile || bun install)

# Copy source code
COPY . .

# Build dashboard
RUN cd dashboard && bun run build

# Production stage
FROM oven/bun:1-slim AS production

WORKDIR /app

# Install Python for auth bot
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Copy from base
COPY --from=base /app /app

# Create data directory
RUN mkdir -p /app/data

# Expose ports
EXPOSE 1930 1931

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:1930/api/health || exit 1

# Start production server
CMD ["bun", "run", "start:fast"]
