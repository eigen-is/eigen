# Build stage
FROM oven/bun:alpine AS builder

# Set the working directory
WORKDIR /app

# Copy workspace files
COPY package.json .
COPY packages ./packages
COPY apps/api-server ./apps/api-server

# Install dependencies and build
WORKDIR /app/apps/api-server
RUN cd /app && bun install
RUN bun run build

# Production stage
FROM oven/bun:alpine

WORKDIR /app

# Copy workspace structure for dependencies
COPY package.json .
COPY packages ./packages
COPY --from=builder /app/apps/api-server/build ./apps/api-server/build
COPY --from=builder /app/apps/api-server/package.json ./apps/api-server/
COPY apps/api-server/data ./apps/api-server/data

# Install production dependencies
WORKDIR /app/apps/api-server
RUN cd /app && bun install --production

# Expose the API port
EXPOSE 8000

# Run the server
CMD ["bun", "build/index.js"]