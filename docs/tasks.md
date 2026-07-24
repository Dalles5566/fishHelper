# fishHelper 任务清单

传输层已从「HTTP 回调」改为「企业微信智能机器人 + WebSocket 长连接」
(官方 `@wecom/aibot-node-sdk`)。按顺序推进,每个任务做完停下等 review。

---

## ✅ 任务 0:方案调整清理(因传输层变更)
- [x] 删除废弃文件 `src/wecom/crypto.js`、`src/wecom/client.js`
- [x] `package.json`:移除 `express`,加入 `@wecom/aibot-node-sdk@^1.0.7`
- [x] `.env.example`:改为 `WECOM_BOT_ID` / `WECOM_BOT_SECRET`
      (去掉 corpId/agentId/callbackToken/encodingAesKey)
- [x] `config.js`:`assertConfig` 改校验 botId/botSecret

**状态:已完成**

---

## ✅ 任务 1:项目初始化
- [x] `package.json`(ESM、脚本、依赖已按任务 0 调整)
- [x] `.gitignore`
- [x] `.env.example`(凭据字段已改)
- [x] `src/config.js`(校验项已改)

**状态:已完成**

---

## ✅ 任务 2:数据库层(已写)
- [x] `src/db/pool.js`
- [x] `src/db/schema.sql`
- [x] `src/db/init.js`
- [x] `src/db/coordinates.js`

**状态:已写,待 review**

---

## ⬜ 任务 3:企业微信机器人层(重写)
- [ ] `src/wecom/bot.js`
  - `new AiBot.WSClient({ botId, secret })`
  - 事件:`authenticated` / `event.enter_chat`(欢迎语) / `message.text`
  - `message.text`:流式回复("正在查询..." → agent 结果 → finish)
  - 导出 `startBot()`

---

## ⬜ 任务 4:天气服务层
- [ ] `src/services/weather.js`
  - `getMarine(lat, lng)` 调 Stormglass,解析风向/风速/潮汐
  - 额度耗尽 / 无数据的兜底

---

## ⬜ 任务 5:工具层
- [ ] `src/agent/tools/queryCoords.js`
- [ ] `src/agent/tools/addCoord.js`
- [ ] `src/agent/tools/queryWeather.js`
- [ ] `src/agent/tools/index.js`(注册表)

---

## ⬜ 任务 6:Agent 核心
- [ ] `src/agent/agentCore.js`
  - `runAgent(userText)`:OpenAI function-calling 循环
  - system prompt(钓鱼助手角色)
  - 最大轮数上限,工具异常捕获回填

---

## ⬜ 任务 7:入口装配
- [ ] `src/index.js`
  - `assertConfig()` → `startBot()`
  - 优雅退出(SIGINT 断开连接)
  - (不再需要 Express / 端口监听)

---

## ⬜ 任务 8:验证
- [ ] `npm install`
- [ ] 语法/启动自检(缺配置时给清晰报错)
- [ ] 连接自测(有 botId/secret 时能认证成功)

---

## 决策记录
- 传输:**企业微信智能机器人 + WebSocket 长连接**(`@wecom/aibot-node-sdk`)
- 凭据:**botId + secret**(智能机器人),非自建应用 agentId/corpId
- LLM:**OpenAI**(function calling),默认 gpt-4o-mini(可配)
- 数据库:**Postgres**(pg)
- 天气潮汐:**Stormglass**
- 回复方式:**流式 replyStream**

## 确认记录
1. ✅ 已创建「智能机器人」fishHelper(API 模式 / 长连接),拿到 botId + secret,已授权消息权限。

## 仍待确认(不影响先把骨架搭起来)
2. 是否加天气缓存(省 Stormglass 额度)?
3. 是否要代码层 userid 白名单?(可见范围已设本人)
4. 群聊 + 私聊都支持,还是只私聊?
```
