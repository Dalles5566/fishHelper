# fishHelper 设计文档

## 1. 项目目标

一个"钓鱼助手":在微信里(通过企业微信智能机器人)向它提问,后端由一个
LLM agent 分析意图,自动调用工具(查/存钓点坐标、查某坐标的综合海况),
把结果整理成人话、以流式方式回复。

核心价值不是"报天气",而是**判断鱼口**:综合潮汐/潮流窗口、日月(solunar)、
水温、风、水深等变量,帮用户判断某个钓点**何时、好不好钓**。以后可扩展更多工具。

## 2. 整体架构(多传输层 + 单一大脑)

**两个入口(传输层)并存,共用同一个 AgentCore 大脑;都是"只出不进",无需公网 URL/域名/备案:**

```
企业微信(智能机器人)          Telegram(个人/朋友,可选)
  ⇕ WebSocket 长连接             ⇕ long polling(getUpdates)
  ⇕ wss://openws.work.weixin…    ⇕ api.telegram.org
  ⇕ botId + secret               ⇕ Bot token(+ 白名单 TELEGRAM_ALLOWED)
        └───────────────┬───────────────┘
                        ▼  统一 onMessage → { text, files }
                  ┌─────────────────────────────┐
                  │  fishHelper (Node 常驻进程)   │
                  │  wecom/bot.js + telegram/bot.js│
                  └─────────────────────────────┘
                        ▼
                  AgentCore (OpenAI function-calling)
                        │
   ┌──────────────┬─────────────┼──────────────┬──────────┐
   ▼              ▼             ▼              ▼          ▼
 getCurrent     getPredict   getCoordinate   addCoordinate
 Weather        Weather      ByName(查库)    (存库)
 (现在实测)     (未来预测)
   │              │
   │  getCurrentConditions   │  getPredictConditions
   ▼  (lat,lng,{name,note})  ▼  (lat,lng,{name,note,date})
 ┌────────┬────────┬────────┬───────────┬────────┬────────────┐
 │ coops  │ ndbc   │ nws    │ astronomy │ usgs   │ bathymetry │
 │ 潮汐   │ 浪/海温 │ 天气/风 │ 日月       │ 河流   │ 水深        │
 └────────┴────────┴────────┴───────────┴────────┴────────────┘
      │  "挑选 + 重组"（curation，非原样堆叠）
      ▼
                  AgentCore → { text, files }
                        │  各传输层各自渲染:
                        │   企业微信:uploadMedia+replyMedia 发 .txt + replyStream 文字
                        │   Telegram:sendDocument 发 .txt + sendMessage 文字
                        ▼
             回到对应入口(企业微信 / Telegram)
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

3b. **多传输层,单一大脑。** 传输与业务解耦:`wecom/bot.js`(企业微信长连接)和
   `telegram/bot.js`(Telegram long polling)都调同一个 `onMessage → runAgent`,
   返回 `{ text, files }` 后各自渲染。两者都是"只出不进",都不需要公网 URL/域名/备案。
   - **Telegram**:`TELEGRAM_BOT_TOKEN` 配了才启用;`TELEGRAM_ALLOWED` 做用户名/ID 白名单(留空=开放)。
     解决"不想用企业微信 App"的诉求;个人微信因无官方 API + 需备案,不走(见下)。
   - **两层权限**:`TELEGRAM_ALLOWED`=谁能用 bot;`ADMINS`=谁能用 adminOnly 工具(如 `addCoordinate` 加钓点)。
     传输层算出 `isAdmin` → 透传到 `runAgent(text,{isAdmin})` → `toolSchemasFor(isAdmin)` 对非管理员**隐藏** adminOnly 工具,
     `executeTool` 再**拦一道**(双保险)。朋友能查、不能加。
   - **身份稳定性**:Telegram **数字 id 永不变**(首选),**用户名可改**(次选);企业微信 userid 企业内稳定。
     → `ADMINS`/`TELEGRAM_ALLOWED` 建议**同时写 id + 用户名**,改名也不丢权限。
   - **为何不用个人微信**:微信客服需公网 HTTPS 回调 + 大概率 ICP 备案(美国用户无法满足);
     个人微信无官方 bot API,逆向方案有封号风险。Telegram 是合规且零基建的替代。

3c. **部署通知**:app 启动上线后主动推一条"已更新+commit"。当前**只发 Telegram**(`DEPLOY_NOTIFY_TG_CHATID`,
   Telegram sendMessage 支持纯文本);`DEPLOY_NOTIFY_CHATID`(企业微信)留空即停用。企业微信主动发只支持 markdown。

3d. **质量门禁:ESLint + CI lint。** `eslint.config.js`(flat config)开 `no-undef`(error)专抓
   "改名漏改/未定义变量"(如曾出现的 `userId is not defined`),`no-unused-vars`(warn)。
   GitHub Actions 在**构建镜像前先 `npm ci && npm run lint`**,lint 不过则不部署 —— 这类低级错拦在上线前。

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

8. **两个天气 tool（AI 按问题自动路由)+ 挑选式聚合。**
   - `getCurrentWeather` → `getCurrentConditions`:回答"现在这里怎么样"(实测快照)。
   - `getPredictWeather` → `getPredictConditions`:回答"未来某天/等下怎样、涨还是退"(逐小时时间线 + 高低潮)。
   编排层不是把 6 源原样堆在一起,而是**挑选 + 重组**(curation):按字段取最优源、
   缺则兜底,合成给 agent 直接可用的对象。某源失败只让相关字段为 `null`,不影响整体
   (`settle()` 容错 → `errors[]`)。**站点先统一解析一次再复用**。

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
    │   └── bot.js            # 企业微信传输:@wecom/aibot-node-sdk WSClient;含部署通知
    ├── telegram/
    │   └── bot.js            # Telegram 传输:long polling + 白名单;sendDocument 发附件
    ├── agent/
    │   ├── agentCore.js      # OpenAI function-calling 主循环
    │   └── tools/
    │       ├── registerTools.js        # 工具注册表 (schema + execute 映射)
    │       ├── getCurrentWeather.js    # 调 getCurrentConditions(lat,lng,{name,note})
    │       ├── getPredictWeather.js    # 调 getPredictConditions(lat,lng,{name,note,date})
    │       ├── getCoordinateByName.js
    │       └── addCoordinate.js
    └── services/
        ├── spotConditions.js            # getCurrentConditions / getPredictConditions（挑选+重组）
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
- `coordinates.js`:`listCoordinates()` / `findCoordinateByName(name)`(精确) /
  `searchCoordinates(term)`(name 或 note 部分匹配,ILIKE) /
  `addCoordinate({name, latitude, longitude, note})`
  > `getCoordinateByName` 工具:先精确、查不到再模糊(名字/备注部分匹配),多个命中返回候选列表。
  > 所以用户只说钓点名一部分(如"ProvinceTown")或备注叫法(如"军校""基佬村")也能查到。

### agent 层
- `agentCore.js`:`runAgent(userText) -> string`
  - system prompt 设定角色(钓鱼助手)+ 注入当前美东日期(解析"今天/明天"等相对日期)
  - 循环:OpenAI(带 tools)→ 需要调工具则执行并回填 → 再问 →
    直到给出最终文本(最大轮数上限防死循环)
  - **回复格式**:`runAgent` 返回 `{ text, files }`。
    - 天气结果(**current 和 predict 一律**)→ 完整 spotConditions JSON 做成 **`.txt` 附件**(files),
      避免企业微信长文本流式接收缓慢、且格式稳定(不随模型 current/predict 路由波动)。
    - text = 判断类问题用 `analyzeFishing.summary`(短路);其余为 agent 基于 result 的回复(数值逐字取自工具),不再内联 JSON。
      回复语言跟随用户(中文→中文、英文→英文),见 §10。("叫我大哥"的要求已移除。)
    - bot 层:`files` 用 `uploadMedia`(type=file)→ `replyMedia` 发出;text 走 `replyStream`。
- `tools/`:每个工具导出 `{ name, description, parameters, execute(args) }`(**name === 文件名**);
  `registerTools.js` 汇总为 `tools` / `toolSchemas` / `executeTool(name,args)`。
  - `getCoordinateByName`:查数据库坐标(传 name 按名查、否则列全部)
  - `addCoordinate`:新增/更新坐标到数据库(按名 upsert;**adminOnly**)
  - `getCurrentWeather`:调 `getCurrentConditions(lat,lng,{name,note,unitSystem})` —— "现在"(仅要原始数据)
  - `getPredictWeather`:调 `getPredictConditions(lat,lng,{name,note,date,unitSystem})` —— "未来/等下"(仅要原始数据)
  - **`analyzeFishing`:钓鱼判断的"大脑"**(见 §10)。任何"好不好钓/什么时候去/现在还是等下/
    今天明天怎样/涨还是退"的判断类问题都走它;内部自取海况(current/prediction)→ 再调一次 LLM
    产出结构化报告,返回 `{summary(发聊天), full(拼进 .txt 附件), conditions}`。
  > **agentCore 只是路由/转发层**:判断逻辑全在 `analyzeFishing`。命中 analyzeFishing 时直接用其
  > `summary` 作聊天正文(短路,不再让模型转述),`full` 拼进附件。
  > 典型链路:用户问"xxx 今天怎样" → agent 先 `getCoordinateByName('xxx')` 拿到
  > `{name,latitude,longitude,note}` → 再把 name/note/坐标传给天气 tool,输出顶部即带 name/note。
  > **tool 层不解析站点**:只收 lat/lng/name/note 转调 spotConditions。

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
| `spotConditions.js` | `getCurrentConditions()` / `getPredictConditions()` | 挑选+重组结果 |

- `spotConditions.js`:**两个入口 + 挑选式重组**(不是把 6 源原样堆叠,而是按字段挑最优源、缺则兜底)。
  两个入口都先 `resolveStations()` 统一解析三站(潮汐/潮流/浮标)再复用;`settle()` 容错 → `errors[]`;
  时间一律用 `toLocal()` 转钓点本地时(见「时间统一规则」)。

  **站点解析的分层(重要)**:`getCurrentConditions` 和 `getPredictConditions` **都在开头先调
  `resolveStations(lat,lng)`**(并发跑 `nearestCoopsTideStation` / `nearestCoopsCurrentStation` /
  `nearestNdbcStation`),拿到 `{tideStation,currentStation,buoyStation}` 后再传给需要站号的数据源
  (coops 用潮汐/潮流站、ndbc 用浮标站)。→ **站点只在编排层解析一次并复用**;tool 层和 dataSource 层都不找站
  (dataSource 只负责"用给定站号拉数据 + 映射")。

  **入口 A `getCurrentConditions(lat,lng,{name,note,unitSystem})` → tool `getCurrentWeather`**
  ```js
  {
    name, note,                    // 来自数据库(裸坐标查询时为 null)
    latitude, longitude, currentTime,
    currentTideAndWeather: {       // 现在实测快照(拍平合并)
      observedAt, waterLevel,      // coops 实测(waterLevel=含气象余差的实测水位)
      airTemp, waterTemp, airPressure,
      wind:{ speed, direction, cardinal, gust },
      shortForecast, precipitationProbability, thunderstormProbability,
      waveHeight, wavePeriod, waveDirection, alerts, units
      // 取值:风/温/阵风 coops→nws 兜底;水温 coops→ndbc 兜底;浪 nws→ndbc 兜底;
      //       风速统一 knots/(m·s)(nws 的 mph/kmh 兜底时换算)
    },
    common: {...},                 // 常驻块(见下)
    errors: []
  }
  ```

  **入口 B `getPredictConditions(lat,lng,{name,note,date,unitSystem})` → tool `getPredictWeather`**
  ```js
  {
    name, note, latitude, longitude, date, currentTime,
    predictTideAndWeather: {
      tideExtremes: [ { type:'High'|'Low', time, height }, ... ],  // 按时间排序的高低潮事件清单(见 §10)
      hourly: [                    // coops 潮 + nws 天气 按同一时刻合并(时间取两源交集,严格对齐)
        { time, waterLevel, temperature, windSpeed, windDirection,
          tidalCurrentSpeed, tidalCurrentDirection, windGust,
          precipitationProbability, thunderstormProbability, waveHeight, wavePeriod, shortForecast }
      ],
      alerts, units
    },
    common: {...},
    errors: []
  }
  ```

  **common(常驻块,两入口共用,扁平):** astronomy → sunrise/sunset/moonrise/moonset/moonIllumination;
  bathymetry → locationDepth;usgs → riverDischarge/gaugeHeight/riverTemperature。

  > 顶层不再输出 `timezone`/`unitSystem`:时间已带本地偏移(如 `-04:00`),各块自带 `units`。
  >
  > **窗口对齐**:coops 预测的 `begin_date` 从"当前整点"起、range=hours,与 NWS forecastHourly
  > "从现在往后"对齐;`hourly` 取两源时间交集,保证每行时间一致。
  >
  > **NDBC 只在 current 兜底,predict 不用**:NDBC 是纯观测源(无预报),`getPredictConditions`
  > 不调它;`getCurrentConditions` 也仅在 coops 缺水温 / nws 缺浪时才用它的观测值。
- `noaaCoops.js`:`getNoaaCoops(lat,lng,{tideStation,currentStation,date,mode,unitSystem})`
  **双模式(互斥)**:
  - `mode:'prediction'`(默认):`prediction` = { firstHighTide/firstLowTide/secondHighTide/
    secondLowTide + hourly[{time,waterLevel,speed,direction}] },`current`=null。
    **预测窗口从"当前整点"起、range=hours(与 NWS 对齐)**,不再从当天午夜起。
  - ⚠️ `num()` 已修:`Number(null)`/`Number('')` 会得 `0`,现先挡 null/空串 → 无传感器站返回 `null` 而非假 `0`。
  - `mode:'current'`:`current` = { time, waterLevel, waterTemp, airTemp, wind{speed,direction,
    cardinal,gust}, airPressure }(站点实测),`prediction`=null
  - `station: { tide, tidalCurrent }`;`unitSystem` 默认 **english**(可 metric),`units` 字段说明单位
  - 逐子请求 try/catch,失败记入 `errors[]`(不整体崩)。潮流逐小时仅谐波站(PCT)有,否则 speed/direction=null
- `noaaNdbc.js`:`getNoaaNdbc(lat,lng,{buoyStation,mode,unitSystem})` —— 浮标**实时观测**
  (浪高/周期/浪向/海温/能见度)。纯观测源:`mode:'current'` 返回观测,`mode:'prediction'` 无预报。
  **定位:兜底源**。CO-OPS current 已提供水温/气温/风/气压,NDBC 唯一独有的是"观测的浪"。
  → 由 `spotConditions` **仅在 CO-OPS current 缺数据时才调用**(平时不发请求,省额度)。
- `nationalWeatherService.js`:`getNationalWeatherService(lat,lng,{mode,unitSystem,hours})`(点查,不用站)
  - `mode:'prediction'`(默认):`prediction.hourly[]` = 逐小时 {time,temperature,windSpeed,windDirection,
    windGust,precipitationProbability,thunderstormProbability,**waveHeight,wavePeriod**,shortForecast}
  - `mode:'current'`:`current` = 此刻那一小时的同款快照
  - **浪从 NWS 来**:gridData 的 waveHeight/wavePeriod(时间区间制→按小时展开)合并进逐小时(未来的浪)
    - ⚠️ **已知 NWS 特性**:近岸/湾内网格格子(如 Cape Cod Bay)NWS 不做浪预报时,会返回
      **单个 `value:0` 覆盖整个 7 天**(`P7DT1H`)。这是"无浪预报"占位,非"真的 0 尺浪"。
      现阶段**忠实透传 NWS 原值(0)**,不做启发式改写;agent 侧解读即可。
  - 阵风/雷暴也来自 gridData;`alerts` 活跃警报放顶层;`marineZone` = forecastZone id
  - `unitSystem` 默认 english(forecastHourly units=us/si;gridData 恒 SI,英制时换算);逐请求 errors[]
- `astronomy.js`:`getAstronomy(lat,lng,{date})` —— `suncalc` 本地算(无网络、不用站、任意时间)。
  纯计算源:无 mode、无单位制之分。字段:sunrise/sunset/moonrise/moonset(UTC)、
  moonPhase{value,name,nameZh}、moonIllumination(%,扁平)。三次调用各自 try/catch→errors[]
- `usgsWaterData.js`:`getUsgsWaterData(lat,lng,{mode,unitSystem})` —— bbox 查附近站的 iv,
  用 haversine 挑最近站。纯观测源:`mode:'current'` 返回流量/水位/水温,`mode:'prediction'` 无预报。
  单位默认 english(流量/水位换算,水温 degC→degF),扁平值+units;逐段 try/catch→errors[]
- `noaaBathymetry.js`:`getNoaaBathymetry(lat,lng,{unitSystem})` —— NCEI DEM identify 按坐标直查点水深。
  静态源(无 mode/无时间);高程负值取绝对值=水深,正值=陆地(depth 0 + elevation + note)。
  单位默认 english(m→ft);fetch/解析各自 try/catch→errors[](不用站)
- `stations.js`:haversine + 站点列表(带缓存);由 `spotConditions.js` 在编排层调用

### 字段映射规则(真实请求验证得出)
- NWS `windSpeed:"7 mph"` → `{ value:7, unit:'mph' }`;`windDirection:"S"` → `{ cardinal:'S' }`
- NDBC 缺测 `MM` → `null`;USGS 缺测 `-999999` → `null`
- Bathymetry `value:"-7.17"`(负高程)→ 取绝对值 `depth:7.17 m`
- 数值字段统一 `{ value, unit }`;站点类子 object 带 `station:{id,name,distanceKm}`

### 时间统一规则(方案 A:数据层全 UTC,展示时本地化)
所有源的时间字段**统一为 UTC ISO8601("...Z")**,消除跨源歧义:
- **CO-OPS**:请求用 `time_zone=gmt` → 直接得 UTC → `"...Z"`
- **NDBC**:realtime2 本就是 GMT → 直接 `"...Z"`
- **NWS**:返回带本地偏移(如 `-04:00`)→ `new Date(t).toISOString()` 转 UTC(去毫秒)
- **本地化在编排层**:`spotConditions` 用 `toLocal(utcIso, tz)`(Intl + IANA 时区,自动处理夏令时)
  把所有出口时间转成钓点本地时 ISO8601(带偏移,如 `2026-07-24T14:00:00-04:00`)。
  时区取自 NWS 的 `timeZone`(如 `America/New_York`)。顶层不再单列 `timezone`(偏移已在时间串里)。
- 原则:**dataSource 层一律 UTC(`...Z`);spotConditions 出口一律本地时**。agent 拿到就是本地时,直接用。

### dataSource 通用约定(精修基线,以 noaaCoops 为模板)
- **双模式** `mode`(适用于有实测+预测之分的源):`'prediction'`(未来预测)/ `'current'`(现在实测),
  两者互斥(一个有值另一个 null)。纯观测源(NDBC/USGS)或纯静态(bathymetry)可只有一种。
- **单位** `unitSystem`:默认 **`english`**(美东用户),可传 `metric`;返回对象带 `units` 说明各字段单位。
- **容错/调试**:每个子请求单独 try/catch,失败记入 `errors[]`(`{step, product, message}`),不整体崩溃。
- **时间** 一律 UTC(`...Z`)。数值**扁平**(不套 {value,unit}),单位集中在 `units`。
- **站点** 由编排层解析后传入;站点类字段带 `{id,name,distanceKm}`,无则 `{available:false,reason}`。

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
- 「Narragansett 现在怎么样?」
  → agent 调 `queryCoords('Narragansett')` 拿 `{name,lat,lng,note}`
  → agent 调 `queryCurrentWeather(lat,lng,{name,note})`(getCurrentConditions,实测快照)
  → 流式回复「现在潮位 2.5ft、水温 70°F、南风 7 节、天晴…(还带上你的备注)」
- 「Narragansett 今天好钓吗?什么时候涨潮?/ 明天呢?」
  → agent 调 `queryCoords` 拿坐标 → 调 `predictWeather(lat,lng,{name,note,date})`
    (getPredictConditions:逐小时时间线 + tideExtremes)
  → agent 综合潮汐窗口 + 日月 + 风 + 水温推理
  → 流式回复「高潮 17:11(3.4ft)、日落 20:10,傍晚涨潮配日落是好窗口;该点水深约 10.8ft」

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

## 10. 钓鱼判断层 `analyzeFishing` 与近期迭代

判断"这个钓点适不适合钓鱼"的逻辑,从 agentCore 抽出来独立成一个 tool——`analyzeFishing`
(`src/agent/tools/analyzeFishing.js`)。agentCore 退化为纯路由:判断类问题交给它,它内部
自取海况 → 再调一次 LLM(资深海钓向导提示词)产出结构化报告。

### 10.1 两段输出:聊天摘要 + .txt 附件
LLM 用 `===FULL===` 把输出切两段:
- **PART 1 = summary(发聊天)**:精简摘要,固定行序 —— Current Time / Sunrise·Sunset /
  **Tides** / Water Temperature / Wind / Air Temperature / Weather / 降水·雷暴概率 /
  **Alerts** / 每个目标鱼种的星级 / Best Fishing Window。
- **PART 2 = full(拼进附件)**:完整报告(全部 OUTPUT FORMAT 字段 + 逐项 ANALYSIS +
  逐鱼种评级理由 + FINAL VERDICT + Today's Best Targets)。
- 附件 = 原始 spotConditions JSON + `\n\n===== Fishing Analysis =====\n` + full。
- 返回 `{summary, full, conditions}`;agentCore 命中即用 summary 短路作正文,不再让模型转述。

### 10.2 目标鱼种打分
固定鱼种(美东)通过 JSON payload 的 `targetSpecies` 字段传给模型(不写死在提示词里),
逐种给 5 星评级(★ 实心 + ☆ 空心,固定 5 个字符),各配一句理由。当前列表:
Striped Bass / Bluefish / Scup / Black Sea Bass / Tautog / Fluke / Weakfish / Squid。

### 10.3 潮汐三档(current / 今天 / 未来某天)
`tideExtremes` 已从 `{firstHighTide, secondHighTide, ...}` 命名(易被模型误读为"没有第二次高潮")
改为**按时间排序的事件清单** `[{type:'High'|'Low', time, height}]`。coops 的 `buildPrediction`
现在返回**全部**高低潮事件(`extremes` 数组,不再只留前两个),`localizeExtremes` 优先用它并支持按本地日期过滤。

展示按"问法"分三档(agentCore 的 SYSTEM_PROMPT 路由 + getPredictConditions 内部按日期分窗口):
| 问法 | mode / date | 潮汐窗口 | 摘要显示 |
|---|---|---|---|
| **现在** | current(无 date) | —— | 下一次高潮 + 下一次低潮 + 随后 |
| **今天** | prediction,date=今天 | 从现在起 +24h(滚动) | 窗口内潮汐按时间列出 |
| **明天/某天** | prediction,date=那天 | 那天本地 00:00–24:00 | 当天潮汐按时间列出 |

- coops 未来某天窗口:从目标日 UTC 0 点起拉 30h(足够覆盖本地整天,含晚潮),再按**本地日期过滤**到 0–24 点。
- "今天/现在"判定用美东日期(`America/New_York`)。

### 10.4 未来某天天气(修复旧限制)
旧限制"问 >2 天未来时逐小时只覆盖现在起 24h"**已修复**:NWS `forecastHourly` 本有 ~7 天数据,
之前被 `slice(0,24)` 从现在切了。现在把目标日期传给 NWS,**按本地日期过滤**逐小时到目标那天整天;
"今天/现在"仍走"从现在起滚动 24h"。

### 10.5 风/气温/天气按固定 3 小时时段块
预测模式下,`analyzeFishing` 在**代码里**(`computeHourlyBlocks`)把逐小时归入固定钟点时段块
(00:00–02:59, 03:00–05:59, …, 21:00–23:59),每块算好风(速度范围+方位)、气温(范围)、天气(主要状况),
以 `hourlyBlocks` 注入 payload,摘要照着逐行渲染。→ 避免让模型自己"每隔 3 小时挑一个点"导致的不稳定。

### 10.6 Alerts 进摘要
NWS 活跃预警(`currentTideAndWeather.alerts` / `predictTideAndWeather.alerts`,含 `isMarine`)
在摘要里单列 **Alerts** 行,逐条显示(海洋类优先);无预警显示 "No active alerts"。

### 10.7 多语言(全英文提示词,输出跟随用户语言)
所有提示词用英文(模型表现更好、更省 token);**不做"翻译问题→英文"这一步**
(会破坏中文钓点名如"基佬村"的查库)。agentCore 顶部检测语言(含中文字符→zh,否则 en),
透传给各处:SYSTEM_PROMPT、`finalizeText()` 兜底文案、`analyzeFishing` 的 `[Language]` 指令。
中文提问→整段中文(含所有字段标题),英文提问→整段英文。

> 备注:早期"每条回复叫用户'大哥'"的要求**已移除**(用户撤回),提示词与兜底文案均不再强制。
```
