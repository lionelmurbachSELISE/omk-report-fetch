FROM node:21.7.0-alpine AS builder

WORKDIR /app

COPY frontend/package*.json ./
RUN npm install

COPY frontend/ .

# Build-time env vars for Vite
# VITE_API_BASE is intentionally empty — nginx proxies /api/ to uvicorn internally
ARG VITE_BLOCKS_API_URL=https://api.seliseblocks.com
ARG VITE_X_BLOCKS_KEY=D34fa08e8393a45979425e658d5a4963e
ARG VITE_PROJECT_SLUG=dnnjno
ARG VITE_API_BASE=

ENV VITE_BLOCKS_API_URL=$VITE_BLOCKS_API_URL
ENV VITE_X_BLOCKS_KEY=$VITE_X_BLOCKS_KEY
ENV VITE_PROJECT_SLUG=$VITE_PROJECT_SLUG
ENV VITE_API_BASE=$VITE_API_BASE

RUN NODE_OPTIONS="--max-old-space-size=4096" npm run build

FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends nginx supervisor \
    && rm -rf /var/lib/apt/lists/*

# Backend
WORKDIR /backend
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ .

# Frontend static files
COPY --from=builder /app/dist /usr/share/nginx/html

# nginx + supervisord config
RUN rm -f /etc/nginx/sites-enabled/default
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY supervisord.conf /etc/supervisor/conf.d/app.conf

EXPOSE 80

CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
