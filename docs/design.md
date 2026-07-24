# fishHelper 设计文档

## 1. 项目目标

一个"钓鱼助手":在微信里(通过企业微信智能机器人)向它提问,后端由一个
LLM agent 分析意图,自动调用工具(查/存钓点坐标、查某坐标的综合海况),
把结果整理成人话、以流式方式回复。

核心价值不是"报天气",而是**判断鱼口**:综合潮汐/潮流窗口、日月(solunar)、
水温、风、水深等变量,帮用户判断某个钓点**何时、好不好钓**。以后可扩展更多工具。

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
 (查综合状况)       (查库)             (存库)
      │
      ▼  getSpotConditions(lat,lng) 并发查 6 源
 ┌────────┬────────┬────────┬───────────┬────────┬────────────┐
 │ coops  │ ndbc   │ nws    │ astronomy │ usgs   │ bathymetry │
 │ 潮汐   │ 浪/海温 │ 天气/风 │ 日月       │ 河流   │ 水深        │
 └────────┴────────┴────────┴───────────┴────────┴────────────┘
      │  各自映射成子 object，合成 SpotConditions
      ▼
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

6. **数据源:全部免费的美国政府 API + 一个离线库(适用美国东部水域)。**
   一源一 service,各查各的 → 映射成自己的子 object → 合成 `SpotConditions`。
   - **NOAA CO-OPS** — 高低潮/实时水位/潮流(按最近站)
   - **NOAA NDBC** — 浪高/浪周期/浪向/海温/能见度(按最近浮标,返回文本需解析)
   - **NWS**(api.weather.gov) — 天气/风/阵风/降雨/雷暴/警报(要 User-Agent,坐标 4 位小数)
   - **Astronomy = `suncalc`**(离线库) — 日出日落/月出月落/月相/月照率
   - **USGS Water** — 河流流量/水位/水温(按最近站)
   - **NOAA NCEI DEM** — 点水深(直接按坐标)
   全部**免费、无需 API key**(NWS 仅需 User-Agent;suncalc 本地计算)。

7. **数据库:Postgres**(pg),坐标存 `coordinates` 表。

8. **单一天气 tool + 6 object 聚合。**
   agent 只调 `queryWeather(lat,lng)` → 内部 `getSpotConditions` 用
   `Promise.allSettled` 并发查 6 源,某源失败/无数据只让其子 object
   `available:false`,不影响整体。新增数据源 = 加一个 service + 往合成里挂一个 object。

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
    │       ├── queryWeather.js  # 调 getSpotConditions(lat,lng)
    │       ├── queryCoords.js
    │       └── addCoord.js
    └── services/
        ├── spotConditions.js            # getSpotConditions(lat,lng) → SpotConditions（合成 6 源）
        ├── stations.js                  # 就近找站的通用工具(haversine + 站点列表缓存)
        └── dataSource/                  # 6 个数据源 service（一源一 object）
            ├── nationalWeatherService.js# getNationalWeatherService() → NationalWeatherServiceObject
            ├── noaaCoops.js             # getNoaaCoops()              → NoaaCoopsObject
            ├── noaaNdbc.js              # getNoaaNdbc()               → NoaaNdbcObject
            ├── astronomy.js             # getAstronomy()              → AstronomyObject (suncalc)
            ├── usgsWaterData.js         # getUsgsWaterData()          → UsgsWaterDataObject
            └── noaaBathymetry.js        # getNoaaBathymetry()         → NoaaBathymetryObject
```

> 注:原 HTTP 回调方案的 `wecom/crypto.js`、`wecom/client.js` 已废弃并删除。
> 原 `services/weather.js`(Stormglass)方案已弃用,改为上面的 6 个 NOAA/USGS service。

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
  - `queryWeather`:给定经纬度,调 `services/combination.js` 的 `getSpotConditions`

### services 层(一源一 object → 合成 SpotConditions)
每个 service 导出 `getXxx(lat, lng)`,内部**请求 → 映射成自己的 object**;
失败/无数据返回 `{ available:false, reason }`,绝不抛异常拖累别的源。

**命名约定:文件名 / 函数名 / 对象名三者一致,都用网站全名。**
| 文件 | 函数 | 对象 |
|---|---|---|
| `noaaCoops.js` | `getNoaaCoops()` | `NoaaCoopsObject` |
| `noaaNdbc.js` | `getNoaaNdbc()` | `NoaaNdbcObject` |
| `nationalWeatherService.js` | `getNationalWeatherService()` | `NationalWeatherServiceObject` |
| `astronomy.js` | `getAstronomy()` | `AstronomyObject` |
| `usgsWaterData.js` | `getUsgsWaterData()` | `UsgsWaterDataObject` |
| `noaaBathymetry.js` | `getNoaaBathymetry()` | `NoaaBathymetryObject` |
| `spotConditions.js` | `getSpotConditions()` | `SpotConditions` |

- `spotConditions.js`:`getSpotConditions(lat, lng) -> SpotConditions`
  用 `Promise.allSettled` 并发调下面 6 个,合成:
  ```js
  {
    latitude, longitude, fetchedAt, timezone,
    sources: {
      noaaCoops,              // NoaaCoopsObject
      noaaNdbc,               // NoaaNdbcObject
      nationalWeatherService, // NationalWeatherServiceObject
      astronomy,              // AstronomyObject
      usgsWaterData,          // UsgsWaterDataObject
      noaaBathymetry,         // NoaaBathymetryObject
    }
  }
  ```
- `noaaCoops.js`:就近找潮汐站 → 高低潮(predictions/hilo)+ 实时水位(water_level);
  潮流(currents_predictions,仅 PCT 类站点有,否则 available:false)
- `noaaNdbc.js`:就近找浮标 → 下 realtime2 文本 → 解析 WVHT/DPD/MWD/WTMP/VIS
- `nationalWeatherService.js`:`points/{lat,lng}`(4 位小数)→ grid + forecastHourly;
  阵风/雷暴来自 forecastGridData;警报 `/alerts/active`
- `astronomy.js`:`suncalc` 本地算日/月(无网络)
- `usgsWaterData.js`:就近找站 → iv 接口(00060 流量/00065 水位/00010 水温)
- `noaaBathymetry.js`:NCEI DEM identify 直接按坐标 → 点水深
- `stations.js`:haversine + 站点列表(带缓存),供 coops/ndbc/usgs 就近找站

### 字段映射规则(真实请求验证得出)
- NWS `windSpeed:"7 mph"` → `{ value:7, unit:'mph' }`;`windDirection:"S"` → `{ cardinal:'S' }`
- NDBC 缺测 `MM` → `null`;USGS 缺测 `-999999` → `null`
- Bathymetry `value:"-7.17"`(负高程)→ 取绝对值 `depth:7.17 m`
- CO-OPS 时间为站点本地时(lst_ldt),统一转 ISO8601
- 数值字段统一 `{ value, unit }`;站点类子 object 带 `station:{id,name,distanceKm}`

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
- 「帮我把'Narragansett'加进去,坐标 41.48075, -71.33550」
  → agent 调 `addCoord` → 流式回复「已保存钓点:Narragansett」
- 「Narragansett 今天好钓吗?什么时候涨潮?」
  → agent 调 `queryCoords('Narragansett')` 拿经纬度
  → agent 调 `queryWeather(41.48075, -71.33550)`(内部 getSpotConditions 并发 6 源)
  → agent 综合潮汐窗口 + 日月 + 风 + 水温推理
  → 流式回复「Newport 站高潮 16:10、日落 20:12,南风 7mph,水温 21.6°C,
    傍晚涨潮配日落是好窗口;该点水深约 7m 偏浅」

## 7. 前置准备

1. ✅ 已在企业微信管理后台创建智能机器人 **fishHelper**(API 模式 / 长连接),
   已授权「消息」权限,可见范围为本人,已拿到 **botId**(`aib_` 开头)+ **secret**。
   - 后台路径:安全与管理 → 管理工具 → 智能机器人 → 创建 → API/MCP插件 → 使用长连接
2. ✅ 天气/海洋数据源全部免费、无需 API key(NWS 仅需 User-Agent;suncalc 本地)。
   - 适用范围:**美国**水域(用户在美国东部 MA/NH/RI,覆盖良好)。
3. ⬜ 准备 Postgres 连接串(`DATABASE_URL`)。
4. ⬜ 准备 OpenAI API key。
5. ⬜ `npm i suncalc` 依赖(astronomy 用)。

## 8. 待确认 / 未来扩展

- [ ] NWS User-Agent 里放的联系邮箱(config 配置)。
- [ ] 是否限制只有白名单 userid 能用?(可见范围已设为本人,起步可先不做代码层白名单)
- [ ] 是否支持群聊(需要 @机器人)还是只私聊?
- [ ] 未来工具:钓获记录、最佳出钓时间(solunar)推荐等。

## 9. 版本 / 环境

- Node.js:v24(本机),`package.json` engines 要求 >= 20
- `@wecom/aibot-node-sdk`:^1.0.7
- `suncalc`:astronomy 数据(离线)
- 数据源:NOAA CO-OPS / NOAA NDBC / NWS / USGS Water / NOAA NCEI DEM(全免费)
- 模块规范:ESM(`"type": "module"`)
```
