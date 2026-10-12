FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --omit=optional
COPY . .
USER node
CMD ["npm", "start"]
