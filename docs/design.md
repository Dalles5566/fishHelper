# fishHelper 设计文档

## 1. 项目目标

一个"钓鱼助手":在微信里(通过企业微信智能机器人)向它提问,后端由一个
LLM agent 分析意图,自动调用工具(查/存钓点坐标、查风力潮汐),把结果整理成
人话、以流式方式回复。以后可扩展更多工具。

## 2. 整体架构(WebSocket 长连接方案)

```
个人微信/群聊  ⇄  企业微信智能机器人(AI Bot)
                        ⇕  WebSocket 长连接
                        ⇕  wss://openws.work.weixin.qq.com
                        ⇕  自动认证 (botId + secret)
                  ┌─────────────────────────────┐
                  │  fishHelper (Node 常驻进程)   │
                  │  @wecom/aibot-node-sdk        │
                  └─────────────────────────────┘
                        │  on('message.text')
                        ▼
                  AgentCore (OpenAI function-calling)
                        │
      ┌─────────────────┼─────────────────┐
      ▼                 ▼                 ▼
 queryWeather      queryCoords        addCoord
 (风/潮汐)          (查库)             (存库)
      │                 │                 │
      └──── tool 结果 ───┴─────────────────┘
                        │
                  AgentCore 整理
                        │  replyStream(流式)
                        ▼
个人微信/群聊  ⇄  企业微信智能机器人
```

### 关键设计决策

1. **传输层:企业微信智能机器人 + WebSocket 长连接。**
   使用官方 `@wecom/aibot-node-sdk`。SDK 内置默认网关地址
   `wss://openws.work.weixin.qq.com`,连接后自动用 botId + secret 认证,
   自带心跳保活、断线指数退避重连、消息类型分发。

2. **⚠️ 凭据 = 智能机器人的 botId + secret,不是自建应用的 agentId/corpId。**
   需要在企业微信管理后台创建"智能机器人",拿到 botId 和 secret。
   自建应用的 agentId/corpId/secret 在本方案中不使用。

3. **无需公网 / 无需 Express / 无需回调 URL / 无需 AES 自解密。**
   程序是一个常驻的 WebSocket 客户端,主动外连,不监听入站端口。
   (文件消息的 AES 解密由 SDK 的 `downloadFile` 内部处理,我们起步不用。)

4. **流式回复。**
   收到消息先 `replyStream(frame, streamId, '正在查询...', false)`,
   agent 跑完再 `replyStream(frame, streamId, 最终结果, true)` 结束流。
   agent 耗时长也没有 5 秒限制问题(欢迎语 replyWelcome 才有 5s 限制)。

5. **工具即函数 + OpenAI function calling。**
   每个 tool = 一个 JS 函数 + JSON schema。新增功能 = 加 tool + 注册,主循环不动。

6. **数据源:Stormglass**(风向/风速/潮汐一站式)。

7. **数据库:Postgres**(pg),坐标存 `coordinates` 表。

## 3. 目录结构

```
fishHelper/
├── package.json              # 依赖:@wecom/aibot-node-sdk / openai / pg (不再需要 express)
├── .env.example
├── .gitignore
├── docs/
│   ├── design.md
│   └── tasks.md
└── src/
    ├── index.js              # 入口:启动 bot,装配 message 处理 → agent → 流式回复
    ├── config.js             # 读 .env + 集中配置 + 启动校验
    ├── db/
    │   ├── pool.js           # pg 连接池
    │   ├── schema.sql        # coordinates 表
    │   ├── init.js           # 建表脚本 (npm run db:init)
    │   └── coordinates.js    # 坐标数据访问 (list/find/add)
    ├── wecom/
    │   └── bot.js            # 封装 @wecom/aibot-node-sdk 的 WSClient 与事件
    ├── agent/
    │   ├── agentCore.js      # OpenAI function-calling 主循环
    │   └── tools/
    │       ├── index.js      # 工具注册表 (schema + execute 映射)
    │       ├── queryWeather.js
    │       ├── queryCoords.js
    │       └── addCoord.js
    └── services/
        └── weather.js        # Stormglass 客户端
```

> 注:原 HTTP 回调方案的 `wecom/crypto.js`、`wecom/client.js` 已废弃并删除。

## 4. 各模块职责

### config.js
集中读取环境变量;`assertConfig()` 启动时校验关键项。
关键项改为:`WECOM_BOT_ID`、`WECOM_BOT_SECRET`、`OPENAI_API_KEY`、数据库配置。

### wecom/bot.js
- 创建 `new AiBot.WSClient({ botId, secret })`
- `on('authenticated')`:日志
- `on('event.enter_chat')`:`replyWelcome` 发欢迎语(5s 内)
- `on('message.text')`:取出 `frame.body.text.content` 和发送人 →
  `replyStream(frame, streamId, '正在查询...', false)` →
  调 `runAgent(content)` → `replyStream(frame, streamId, 结果, true)`
- 导出 `startBot()`,`connect()` 建连

### db 层(不变)
- `pool.js`:pg 连接池
- `coordinates.js`:`listCoordinates()` / `findCoordinateByName(name)` /
  `addCoordinate({name, latitude, longitude, note})`

### agent 层
- `agentCore.js`:`runAgent(userText) -> string`
  - system prompt 设定角色(钓鱼助手)
  - 循环:OpenAI(带 tools)→ 需要调工具则执行并回填 → 再问 →
    直到给出最终文本(最大轮数上限防死循环)
- `tools/`:每个工具导出 `{ name, description, parameters, execute(args) }`
  - `queryCoords`:查数据库坐标(全部或按名)
  - `addCoord`:新增坐标到数据库
  - `queryWeather`:给定经纬度,调 `services/weather.js` 取风向/风速/潮汐

### services/weather.js
封装 Stormglass:`getMarine(lat, lng)` 返回风向、风速、下几次涨/退潮时间点。

## 5. 数据模型

```sql
coordinates (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,          -- 钓点名,唯一(忽略大小写)
  latitude    DOUBLE PRECISION NOT NULL,
  longitude   DOUBLE PRECISION NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
)
```

## 6. 典型对话流程示例

用户在微信里 @机器人 或私聊:
- 「帮我把'东堤尾'加进去,坐标 22.5, 114.3」
  → agent 调 `addCoord` → 流式回复「已保存钓点:东堤尾」
- 「东堤尾今天风大不大?什么时候涨潮?」
  → agent 调 `queryCoords('东堤尾')` 拿经纬度
  → agent 调 `queryWeather(22.5, 114.3)`
  → agent 整理 → 流式回复「东堤尾:东北风约 5 级...下次涨潮 14:20,退潮 20:35」

## 7. 前置准备

1. ✅ 已在企业微信管理后台创建智能机器人 **fishHelper**(API 模式 / 长连接),
   已授权「消息」权限,可见范围为本人,已拿到 **botId**(`aib_` 开头)+ **secret**。
   - 后台路径:安全与管理 → 管理工具 → 智能机器人 → 创建 → API/MCP插件 → 使用长连接
2. ⬜ 注册 Stormglass 账号,拿 **API key**(免费额度每天 10 次)。
3. ⬜ 准备 Postgres 连接串(`DATABASE_URL`)。
4. ⬜ 准备 OpenAI API key。

## 8. 待确认 / 未来扩展

- [ ] Stormglass 免费额度每天 10 次,是否加缓存(同坐标 1 小时内复用)?
- [ ] 是否限制只有白名单 userid 能用?(可见范围已设为本人,起步可先不做代码层白名单)
- [ ] 是否支持群聊(需要 @机器人)还是只私聊?
- [ ] 未来工具:钓获记录、多天预报、最佳出钓时间推荐等。

## 9. 版本 / 环境

- Node.js:v24(本机),`package.json` engines 要求 >= 20
- `@wecom/aibot-node-sdk`:^1.0.7
- 模块规范:ESM(`"type": "module"`)
```
