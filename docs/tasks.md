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

## ✅ 任务 3:企业微信机器人层
- [x] `src/wecom/bot.js`
  - `new WSClient({ botId, secret })`,`connect()` 自动认证
  - 生命周期事件:`connected`/`authenticated`/`disconnected`/`reconnecting`/`error`
  - `event.enter_chat`:`replyWelcome` 发欢迎语
  - `message.text`:流式回复("正在查询…" → onMessage 结果 → finish),全程 try/catch
  - 通过注入 `onMessage` 与 agent 解耦,导出 `startBot({ onMessage })`
  - 已核对 SDK 类型:`frame.body.text.content` / `frame.body.from.userid`,回复走 SDK 方法不手写 JSON

**状态:已完成(待 npm install 后连真机验证 frame)**

---

## 🔨 任务 4:服务层(6 源 → SpotConditions)
数据源已用真实坐标(41.48075,-71.33550)逐个请求验证(字段映射规则见 design.md)。
每个 service:请求 → 映射成自己的 object,失败/无数据返回 `{available:false, reason}`。

**命名一致:文件名 / 函数名 / 对象名三者同名(网站全名)。**
**目录:6 个数据源放 `services/dataSource/`;`stations.js`、`spotConditions.js` 放 `services/` 顶层。**
**(样例文件 `sampleConditions.js` 已删除 —— 字段契约在 design.md。)**

- [ ] `src/services/stations.js`(haversine + 站点列表缓存,就近找站;coops/ndbc/usgs 共用)
- [ ] `src/services/dataSource/nationalWeatherService.js`：`getNationalWeatherService()` → **`NationalWeatherServiceObject`**
- [ ] `src/services/dataSource/noaaCoops.js`：`getNoaaCoops()` → **`NoaaCoopsObject`**
- [ ] `src/services/dataSource/noaaNdbc.js`：`getNoaaNdbc()` → **`NoaaNdbcObject`**
- [ ] `src/services/dataSource/astronomy.js`：`getAstronomy()` → **`AstronomyObject`**(suncalc)
- [ ] `src/services/dataSource/usgsWaterData.js`：`getUsgsWaterData()` → **`UsgsWaterDataObject`**
- [ ] `src/services/dataSource/noaaBathymetry.js`：`getNoaaBathymetry()` → **`NoaaBathymetryObject`**
- [ ] `src/services/spotConditions.js`：`getSpotConditions()` → **`SpotConditions`**(并发合成上面 6 个)
- [ ] `package.json` 加 `suncalc` 依赖

---

## ⬜ 任务 5:工具层
- [ ] `src/agent/tools/queryCoords.js`
- [ ] `src/agent/tools/addCoord.js`
- [ ] `src/agent/tools/queryWeather.js`(调 `getSpotConditions(lat,lng)`)
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
- 数据源:**NOAA CO-OPS / NDBC / NWS / USGS / NCEI DEM + suncalc**(全免费,适用美国)
- 架构:**一源一 object → 合成 `SpotConditions`**(单 tool `queryWeather` 调 `getSpotConditions`)
- 回复方式:**流式 replyStream**

## 确认记录
1. ✅ 已创建「智能机器人」fishHelper(API 模式 / 长连接),拿到 botId + secret,已授权消息权限。

## 仍待确认(不影响先把骨架搭起来)
2. 是否加天气缓存(省 Stormglass 额度)?
3. 是否要代码层 userid 白名单?(可见范围已设本人)
4. 群聊 + 私聊都支持,还是只私聊?
```
