FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --registry https://registry.yarnpkg.com

COPY . .

EXPOSE 3002

CMD ["node", "server.js"]
