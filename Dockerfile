FROM node:22-bookworm-slim

WORKDIR /app

# Install Node dependencies first so Docker can cache this layer.
COPY package.json ./
RUN npm install --no-audit --no-fund

# Appbit's APK download resolver uses Playwright Chromium when LiteAPKs
# generates the final APK URL with JavaScript. Install Chromium plus the
# Linux libraries Playwright requires inside the image.
RUN npx playwright install --with-deps chromium

COPY . .

# Validate the actual Appbit sources and build the existing Astro middleware
# runtime. This does not change the Appbit framework.
RUN npm run check && npm run build

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
