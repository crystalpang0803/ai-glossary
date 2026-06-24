FROM node:lts-slim

WORKDIR /app

# Copy dependency files first for layer caching
COPY package.json package-lock.json* ./
RUN npm install --no-cache --no-fund --no-audit

# Copy the rest of the application
COPY . .

# DevCloud requires binding to 0.0.0.0 on port 8080
EXPOSE 8080

CMD ["node", "server.js"]