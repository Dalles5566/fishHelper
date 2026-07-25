# fishHelper —— 常驻 WebSocket 客户端(不监听入站端口)
FROM node:20-alpine

WORKDIR /app

# 先装依赖(利用层缓存):有 package-lock 用 npm ci
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 拷贝源码
COPY src ./src

# 生产环境
ENV NODE_ENV=production

# 构建时注入的 git commit(用于确认线上跑的是哪份代码)
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA

# 入口:启动前先建表/灌种子(幂等),再起常驻进程
CMD ["sh", "-c", "node src/db/init.js && node src/index.js"]
