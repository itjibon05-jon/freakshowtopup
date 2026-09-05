# FREAKSHOWTOPUP - PRODUCTION DOCKERFILE
FROM node:20-alpine AS base

WORKDIR /app

# Copy package and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application source code
COPY . .

# Expose standard production port
EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

# Run production server
CMD ["node", "server.js"]
