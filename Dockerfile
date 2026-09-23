FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json requirements-ml.txt ./
RUN npm ci --ignore-scripts \
    && pip3 install --break-system-packages --no-cache-dir -r requirements-ml.txt

COPY . .
RUN npm run build

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
