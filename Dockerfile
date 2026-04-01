FROM node:21.7.0-alpine AS builder

WORKDIR /app

COPY frontend/package*.json ./
RUN npm install

COPY frontend/ .

# Build-time env vars for Vite (defaults match the Selise dev environment)
ARG VITE_BLOCKS_API_URL=https://api.seliseblocks.com
ARG VITE_X_BLOCKS_KEY=Df2bcc056a20948d7b124d1be4c5925e0
ARG VITE_PROJECT_SLUG=dbwkit
ARG VITE_API_BASE=http://127.0.0.1:8000

ENV VITE_BLOCKS_API_URL=$VITE_BLOCKS_API_URL
ENV VITE_X_BLOCKS_KEY=$VITE_X_BLOCKS_KEY
ENV VITE_PROJECT_SLUG=$VITE_PROJECT_SLUG
ENV VITE_API_BASE=$VITE_API_BASE

RUN NODE_OPTIONS="--max-old-space-size=4096" npm run build

FROM nginx:stable-alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
