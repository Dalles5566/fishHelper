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
**站点解析在编排层:`spotConditions.js` 先并行调三个 `nearestXxxStation`,把站点传给 coops/ndbc(它们不再自己找站,便于复用)。**

- [x] `src/services/stations.js`(haversine + 站点列表缓存,就近找站;coops/ndbc/usgs 共用)—— 已实测:tide/current/ndbc 站均可查,7 项测试通过
- [x] `src/services/dataSource/nationalWeatherService.js`：`getNationalWeatherService()` → **`NationalWeatherServiceObject`** —— 已实测通过(grid/风/阵风/逐小时/警报)
- [x] `src/services/dataSource/noaaCoops.js`：`getNoaaCoops(lat,lng,{tideStation,currentStation})` → **`NoaaCoopsObject`** —— 已实测通过(高低潮/实时水位/潮流,站点由编排层传入)
- [x] `src/services/dataSource/noaaNdbc.js`：`getNoaaNdbc(lat,lng,{buoyStation})` → **`NoaaNdbcObject`** —— 已实测通过(解析 realtime2 文本;每字段取最近有效值 MM→null)
- [x] `src/services/dataSource/astronomy.js`：`getAstronomy()` → **`AstronomyObject`**(suncalc,日月全套)—— 已实测通过(日出与 NWS 差 1.3 分钟,含月相/月照率)
- [x] `src/services/dataSource/usgsWaterData.js`：`getUsgsWaterData()` → **`UsgsWaterDataObject`** —— 已实测通过(bbox 查+就近挑站;流量/水位/水温;-999999→null;时间 UTC)
- [x] `src/services/dataSource/noaaBathymetry.js`：`getNoaaBathymetry()` → **`NoaaBathymetryObject`** —— 已实测通过(NCEI DEM 点水深;负高程取绝对值;陆地点识别)
- [x] `src/services/spotConditions.js`：**两个入口(挑选+重组,非原样堆叠)** —— 已实测通过
      - `getCurrentConditions(lat,lng,{name,note,unitSystem})` → tool `getCurrentWeather`:
        `currentTideAndWeather`(实测快照,拍平合并:风/温 coops→nws 兜底、水温 coops→ndbc 兜底、
        浪 nws→ndbc 兜底、风速统一 knots)+ `common` + name/note/currentTime
      - `getPredictConditions(lat,lng,{name,note,date,unitSystem})` → tool `getPredictWeather`:
        `predictTideAndWeather`{ tideExtremes + hourly(coops 潮 + nws 天气按**时间交集**对齐)+ alerts }
        + `common`
      - 公共:`resolveStations()` 站点解析一次复用;`toLocal()` 全部时间转钓点本地时;
        顶层不输出 timezone/unitSystem(偏移在时间串、units 在各块);settle() 容错→errors[]
      - coops 预测窗口改为"从当前整点起 range=hours"(与 NWS 对齐);修复 coops `num(null)→0` bug
- [x] `package.json` 加 `suncalc` 依赖(已 npm i)

**数据源已定稿:6 个全免费(NOAA/NWS/USGS + suncalc)。评估过 Stormglass(付费,10次/天太贵)
和 Open-Meteo(免费但近岸精度有限),均不接入,保持现有写法。**

---

## 🔧 任务 4.5:精修 dataSource(以 noaaCoops 为模板)
**精修基线(见 design.md「dataSource 通用约定」)**:双模式 mode(current/prediction 互斥)、
单位 unitSystem(默认 english)、逐请求 try/catch + errors[]、UTC 时间、扁平值 + units 说明、
站点由编排层传入。

- [x] **noaaCoops** 精修定稿:双模式 + 单位(默认英制)+ errors + station.{tide,tidalCurrent}
      + prediction{firstHigh/Low/secondHigh/Low + hourly[{time,waterLevel,speed,direction}]}
      / current{waterLevel,waterTemp,airTemp,wind,airPressure} + 满注释
- [x] **nationalWeatherService** 精修定稿(双模式 current/prediction;英制默认可切公制;errors;
      逐小时含温度/风/阵风/降雨/雷暴/**浪高/浪周期**(gridData 展开合并);alerts 顶层;marineZone)
- [x] **noaaNdbc** 精修定稿(纯观测:current 返回观测/prediction→无预报;英制默认可切公制;errors;扁平值+units)
      **定位=兜底源**:唯一独有"观测的浪";水温/风/气温 CO-OPS current 已有。
      由 spotConditions **仅在 CO-OPS current 缺数据时才调**(平时不请求)。
- [x] **astronomy** 精修定稿(纯计算源,任意时间;三次 suncalc 各自 try/catch→errors;moonIllumination 扁平;date/units;满注释)
- [x] **usgsWaterData** 精修定稿(纯观测:current 观测/prediction→无预报;bbox 找最近站;英制默认可切公制;errors;注释)
- [x] **noaaBathymetry** 精修定稿(静态源,无 mode/无时间;英制默认可切公制 m→ft;陆地点识别;errors;注释)
- [ ] (可选)抽公共 fetch/超时工具,减少重复

---

## ✅ 任务 5:工具层
每个 tool = `{ name, description(中文,帮 AI 判断何时调), parameters(JSON schema), execute }`。
**约定:tool 的 name === 文件名。**
- [x] `src/agent/tools/getCoordinateByName.js`(传 name 按名查、否则列全部;返回 {name,lat,lng,note})
- [x] `src/agent/tools/addCoordinate.js`(upsert 钓点,按名唯一)
- [x] `src/agent/tools/getCurrentWeather.js`(调 `getCurrentConditions(lat,lng,{name,note,unitSystem})` —— "现在")
- [x] `src/agent/tools/getPredictWeather.js`(调 `getPredictConditions(lat,lng,{name,note,date,unitSystem})` —— "未来/等下")
- [x] `src/agent/tools/registerTools.js`(注册表:`tools` / `toolSchemas` / `executeTool(name,args)`)
> AI 按问题自动选 current / predict;查点名时先 getCoordinateByName 拿坐标+name+note 再传给天气 tool。
> 已验证:注册表加载、schema 结构、天气 tool 端到端执行(name/note 透传)、未知 tool 报错。
> DB 两 tool 为 DB 层薄封装,连真库执行留到任务 8。

**状态:已完成(待 review)**

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
- 架构:**挑选+重组(curation)**,两个天气 tool 按问题路由:
  `getCurrentWeather`→`getCurrentConditions`(现在)、`getPredictWeather`→`getPredictConditions`(未来)
- 时间:dataSource 层全 UTC,spotConditions 出口全部转钓点本地时(toLocal);顶层不单列 timezone/unitSystem
- name/note:天气对象顶部带钓点名与备注(来自 DB,上层查库后传入)
- 回复方式:**流式 replyStream**

## 确认记录
1. ✅ 已创建「智能机器人」fishHelper(API 模式 / 长连接),拿到 botId + secret,已授权消息权限。

## 仍待确认(不影响先把骨架搭起来)
2. 是否要代码层 userid 白名单?(可见范围已设本人)
3. 群聊 + 私聊都支持,还是只私聊?
4. 精修 dataSource 的单位标准(公制/英制/两者都留)?
```
