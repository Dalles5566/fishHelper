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

## ✅ 任务 6:Agent 核心
- [x] `src/agent/agentCore.js`
  - `runAgent(userText,{history})`:OpenAI function-calling 循环(懒加载 client)
  - system prompt(钓鱼助手角色 + 选工具规则 + 综合潮汐/日月/风/水温判断鱼口 + 时间已本地化 + 缺数据如实说)
  - MAX_ROUNDS=6 防死循环;轮数用尽再做一次不带工具的总结
  - 工具异常 catch 成 `{error,message}` 回填模型;兜底文案按语言(中/英)输出("大哥"要求已移除,见任务 12/13)
  - 已结构验证(模块加载 + toolSchemas 装配)。**真跑一轮需 OPENAI_API_KEY → 留到任务 8**

**状态:已完成(待 review;实调等 key)**

---

## ✅ 任务 7:入口装配
- [x] `src/index.js`
  - `assertConfig()` 缺配置早失败(已验证:清晰报错 + 退出码 1)
  - `startBot({ onMessage })` 把 bot 文本消息接到 `runAgent`
  - 优雅退出(SIGINT/SIGTERM → 断连 + `pool.end()`,一次性守卫)
  - `unhandledRejection` 兜底不静默崩;不监听入站端口(常驻 WS 客户端)
  - 已验证:整个模块图干净加载 + 配置自检

**状态:已完成(待 review)**

---

## 🔨 任务 8:验证
- [x] 依赖已装(node_modules 就绪)
- [x] 启动自检:缺配置清晰报错 + 退出码 1
- [x] 本地 Postgres(Docker `fishhelper-pg`,postgres:16)+ `npm run db:init` 建表灌 5 个种子钓点
- [x] DB 两 tool 实测:`getCoordinateByName` 按名查、`addCoordinate` upsert 均通过
- [x] 全链路实测:`runAgent("坐标现在海况")` → getCurrentWeather;`runAgent("Fort Adams 明天几点涨潮")`
      → getCoordinateByName → getPredictWeather,数值与工具数据逐字一致
- [x] **修复关键 bug**:模型不知"今天",相对日期(明天/后天)靠猜 → 注入美东当前日期到 system prompt
- [ ] 连企业微信真机:`npm start` 认证上线 + 手机企业微信里收发消息(待用户实机)
- ~~已知限制:问 >~2 天的未来时 nws 逐小时只覆盖"现在起24h"~~ → **已在任务 13 修复**(按目标日期过滤 nws 逐小时)

**状态:核心链路已实测通过;仅剩企业微信真机联调**

---

## ✅ 任务 9:部署 + CI/CD(已上线)
- [x] Docker 独立部署:`Dockerfile` + `docker-compose.yml`(app + 专属 postgres,独立网络/数据卷)
- [x] 已部署到服务器 67.205.150.67(root),与现有 feishuhelper 栈隔离:
      - app 无宿主机端口;db 绑 `127.0.0.1:5433`(避开被占用的 5432,不暴露公网)
      - 独立数据卷 `fishhelper_fishhelper_pgdata`;种子 5 钓点已入库;机器人认证上线
- [x] GitHub Actions 自动部署 `.github/workflows/deploy.yml`(**GHCR 镜像方案**,与 feishuHelper 一致):
      push main → Actions 构建镜像 + 推 `ghcr.io/dalles5566/fishhelper`(latest + commit SHA)
      → 服务器 `docker login ghcr.io`(用临时 GITHUB_TOKEN)+ `docker compose pull` + `up -d` → 健康检查
      - compose 用 `image:`(非 `build:`);服务器不本地构建、只拉镜像
      - secrets:DEPLOY_SSH_KEY / DEPLOY_HOST / DEPLOY_USER / DEPLOY_KNOWN_HOSTS(专用 CI→服务器密钥)
      - Dockerfile 保持单阶段(纯 JS,无需像 feishu 那样编译 TS)
      - 服务器不存长期 GitHub 凭据;`paths-ignore` 让纯文档改动不触发部署
- [x] 镜像内嵌 git commit(`GIT_SHA`),启动打印 `commit=...`,可核对线上版本
- [x] 部署通知:启动认证成功后主动推一条"已更新 + commit + 时间"到 `DEPLOY_NOTIFY_CHATID`(单聊=userid)
      —— 收到即证明最新代码已上线,不用 SSH 看日志。
      ⚠️ 企业微信**主动发送**(`sendMessage`)只支持 markdown/模板卡片/媒体,**无纯 text**(text 会报 40008);
         被动回复才有 text/stream。部署通知用 markdown。
- [x] 真机被动回复已验证("Hello" 收发正常);userid=liudallasbinglin

**状态:全链路上线 + CI/CD + 版本可验证 + 部署通知均已实测通过**

---

## ✅ 任务 10:第二传输层 Telegram(已上线)
- [x] `src/telegram/bot.js`:long polling(getUpdates,无需公网 URL/域名/备案),原生 fetch 无新依赖
      - 收文本 → 共用 `onMessage → runAgent` → `sendDocument` 发 .txt 附件 + `sendMessage` 发建议
      - 与企业微信并存(index.js 同时起两个传输,共用一个大脑);token 未配则自动跳过
- [x] 白名单 `TELEGRAM_ALLOWED`(用户名或数字 id,不区分大小写;留空=开放);非白名单礼貌拒绝并回显其 id
- [x] 已部署:bot @DragonBaSkyFishHelp_bot 上线,真机收发 + 附件已验证;白名单当前=dragonbasky
- [x] 模型升级:`OPENAI_MODEL=gpt-5.4`(纯 env,gpt-4o-mini→gpt-5.4,已实测更稳)
- 决策:个人微信不做(微信客服需公网HTTPS+ICP备案,美国用户无法满足;逆向方案封号风险)→ 用 Telegram 替代

**状态:企业微信 + Telegram 双入口均上线**

---

## ✅ 任务 11:权限、身份、质量门禁(已上线)
- [x] **管理员权限**:`ADMINS`(tg 用户名/id 或企微 userid)。`addCoordinate` 标 `adminOnly`:
      非管理员时从工具列表隐藏(`toolSchemasFor(isAdmin)`)+ `executeTool` 拦截(双保险)。
      传输层算 `isAdmin` → `runAgent(text,{isAdmin})` → executeTool。朋友能查、不能加钓点。
- [x] **身份稳定性**:tg 数字 id 永不变(首选)、用户名可改(次选)、企微 userid 稳定。
      `ADMINS` / `TELEGRAM_ALLOWED` 同时写 id+用户名,改名不丢权限。
      (当前 ADMINS=dragonbasky,5115952326,liudallasbinglin;TELEGRAM_ALLOWED=dragonbasky,5115952326)
- [x] **部署通知改只发 Telegram**(`DEPLOY_NOTIFY_TG_CHATID`),企业微信通知停用。
- [x] **ESLint + CI 门禁**:`eslint.config.js`(no-undef=error / no-unused-vars=warn);
      CI 构建前 `npm ci && npm run lint`,lint 不过不部署。修了 Telegram `userId` 未定义 bug 的根因防线。

**状态:双入口 + 白名单 + 管理员权限 + 质量门禁 全部上线**
可选下一步:每日定时主动推送海况。

---

## ✅ 任务 12:钓鱼判断层 analyzeFishing + 摘要/附件 + 多语言(已上线)
把"好不好钓"的判断从 agentCore 抽成独立 tool `analyzeFishing`(LLM-based,用户选 B 方案:
"我不知道权重" → 不做规则加权,交给模型)。详见 design.md §10。
- [x] `src/agent/tools/analyzeFishing.js`:资深海钓向导英文提示词;内部自取海况(current/prediction)
      → 再调一次 LLM 产结构化报告;返回 `{summary, full, conditions}`
- [x] **两段输出**(`===FULL===`):PART 1 摘要发聊天;PART 2 完整报告拼进 .txt 附件
      (附件 = 原始 JSON + `===== Fishing Analysis =====` + full)。agentCore 命中即用 summary 短路作正文
- [x] **agentCore 退化为纯路由**:SYSTEM_PROMPT 只管选工具 + 转发;判断逻辑全在 analyzeFishing
- [x] **目标鱼种打分**:TARGET_SPECIES 经 JSON payload 的 `targetSpecies` 注入,逐种 5 星(★+☆ 固定 5 字符)+ 理由
- [x] **多语言**:全部提示词英文(省 token/模型更稳),**不翻译问题**(保住中文钓点名查库);
      agentCore 顶部检测语言透传 → 中文提问整段中文、英文整段英文(含字段标题);兜底文案也按语言
- [x] **"叫我大哥"要求移除**(用户撤回):提示词与所有兜底文案不再强制
- [x] 模型 `OPENAI_MODEL=gpt-5.4`(纯 env)

**状态:已上线并实测**

---

## ✅ 任务 13:潮汐三档 + 全 extremes + 未来天气修复 + 3 小时块 + Alerts(已上线)
详见 design.md §10.3–10.6。
- [x] **tideExtremes 改为按时间排序的事件清单** `[{type,time,height}]`(弃 firstHigh/secondHigh 命名,
      该命名曾让模型误判"没有第二次高潮"→ 假"无数据")
- [x] **coops 返回全部高低潮事件**(`extremes` 数组,不再只留前两个);`localizeExtremes` 优先用它 + 支持本地日期过滤
- [x] **潮汐三档**:现在=current(下一次高/低潮);今天=prediction 从现在起滚动 +24h;
      明天/某天=prediction 该本地日 00:00–24:00。agentCore SYSTEM_PROMPT 点明"今天≠现在"(今天=一整天→prediction)
- [x] **coops 未来窗口** 从目标日 UTC 0 点拉 30h 覆盖本地整天(含晚潮),再按本地日期过滤
- [x] **修复未来某天天气**:NWS 逐小时原被 `slice(0,24)` 从现在切 → 现按目标本地日期过滤(NWS 本有 ~7 天)
- [x] **风/气温/天气按固定 3 小时时段块**(`computeHourlyBlocks` 代码里算,00:00–02:59…21:00–23:59;
      风=速度范围+方位、气温=范围、天气=主要状况),注入 `hourlyBlocks`,摘要照渲染 → 稳定一致
- [x] **Alerts 进摘要**:活跃预警单列一行(海洋类优先),无则 "No active alerts"
- [x] moonPhase / moonIllumination 纳入 common(满月潮大、鱼口活跃)
- 决策:slack/转流时刻(currentExtremes)评估后**暂不做**(多数钓点潮流站无预测数据)

**状态:已上线并实测(现在/今天/明天 三档潮汐 + 3 小时块 + Alerts 均验证)**

---

## ✅ 任务 14:两步式架构重构 + 双模型 + 单次输出(已上线)
详见 design.md §11。
- [x] **agentCore 重构为两步式**:extractIntent(轻量)→ type=analyze 走代码固定管道(查坐标→analyzeFishing)→ 其它走 function-calling 兜底
- [x] **双模型**:`OPENAI_MODEL`(gpt-5.6-terra,analyzeFishing 报告)+ `OPENAI_MODEL_FAST`(gpt-5.6-luna,意图提取+兜底)
- [x] **reasoning_effort:'none'**:5.6 系列 + tools 的 API 兼容性修复
- [x] **单次输出**:LLM 只生成一段完整报告(删 splitLine);聊天摘要由 `extractSummary()` 代码提取
      (→ 后续任务 17 进一步改为 `buildSummary()` 直接从数据渲染,`extractSummary` 已移除)
- [x] **ANALYSIS 精简**:No data 不强行分析;FINAL VERDICT 只留 Best Fishing Window
- [x] **潮汐格式修正**:current=逐行 Next High/Low;predict=逐行逐事件(不用箭头)
- [x] **浪高/浪周期 3h 块**:加入 computeHourlyBlocks + FISHING_PROMPT 指令
- [x] **mode 规则单一判定**:只在 intentPrompt 定,兜底通过 intentNote 复用(不重判)
- [x] **语言注入修复**:兜底路径明确注入 `[Language]` 系统消息(修复英文问→中文回的 bug)
- token 省约 **43%**(从 ~$0.037/次 → ~$0.021/次)

**状态:已上线(gpt-5.6-terra + gpt-5.6-luna)**

---

## ✅ 任务 15:Discord 传输层(已上线)
详见 design.md §12。
- [x] `src/discord/bot.js`:discord.js gateway 连接,响应群消息 + DM
- [x] 白名单 `DISCORD_ALLOWED`(留空=开放)
- [x] 附件(AttachmentBuilder)+ 2000 字符分段
- [x] 优雅退出 `discord.destroy()`
- [x] `config.js` 加 `discord.token` + `discord.allowed`

**状态:已上线(fishHelperBot#4652)**

---

## ✅ 任务 16:管理员前缀安全 + 交互按钮(已上线)
详见 design.md §11.6 + §13。
- [x] **ADMINS 平台前缀**:防跨平台用户名碰撞(`TG_`/`WECOM_`/`DISCORD_`)
- [x] **Discord 按钮**:listSpots 返回 spots 时渲染 ActionRow 按钮,点击触发今天 prediction
- [x] **Telegram InlineKeyboard**:同上,callback_query 触发分析
- [x] **企业微信降级**:纯文本列表(无按钮)
- [x] `findCoordinateById` 加入 DB 层(按钮回调用)

**状态:已上线**

---

## ✅ 任务 17:代码渲染摘要 + 全面代码审查修复(已上线)
详见 design.md §10.1 / §11.3。

**架构调整:代码渲染数据,AI 只做分析**
- [x] `buildSummary(conditions, hourlyBlocks, lang)`:代码渲染所有确定性字段(时间/潮汐/气温/
      天气/风速/水温/浪高/浪周期/警报),100% 稳定格式,不依赖模型输出
- [x] `FISHING_PROMPT` 精简为只出鱼种星级 + Best Fishing Window(采用 ChatGPT 撰写的
      详细物种评判提示词:CORE PRINCIPLE / DATA DISCIPLINE / TIME-OF-DAY / TIDE / WIND-WAVE /
      SPECIES RATINGS / BEST WINDOW / REASONING PRIORITY)
- [x] 删除 `extractSummary()` 正则提取 + `CHAT_FIELDS` + `SECTION_HEADER_RE`
- [x] .txt 附件只留原始 JSON(不再拼分析文字)
- [x] 显示细节:双单位(kt+mph、°F+°C)、`时段 | 数值` 管道分隔、字段顺序
      (潮汐→气温→天气→风速→水温→浪高→浪周期→警报)、降水雷暴合进天气行
- [x] 移除 Squid(7 个鱼种);鱼名永远用英文原名不翻译

**代码审查修复(bug)**
- [x] `computeHourlyBlocks` 分组键改为**本地日期 + 时段**:修复"今天"滚动窗口跨午夜时
      今天/明天数据混进同一 3h 块(风速气温范围错乱、块顺序错乱)
- [x] 降水/雷暴概率改在 `computeHourlyBlocks` 内按同批 entries 计算,不再二次按小时扫描
      (原实现会把明天的降水概率串到今天的块里)
- [x] `runAnalyzeFast` 用 try/catch 包住 `analyzeFishing.execute`:抛错(数据源/OpenAI 故障)
      现在能正确落回 function-calling 兜底,而非直接冲出 runAgent
- [x] 多个同名候选时也透传 `result.matches` 成 spots → 最需要按钮的澄清场景现在有按钮了
- [x] Telegram 长回复改为 `sendLongMessage` 按行分段(原 `.slice(0,4096)` 会静默截断尾部)
- [x] prediction 但逐小时为空(NWS 失败/交集为空)时,补 else 分支明确打印"无数据"
- [x] 移除 `unitSystem: 'metric'`(格式化函数只支持英制,传 metric 会数字/单位全错)
- [x] Telegram 按钮回调加 NaN 守卫;`offset` 改为 handle 之后推进并单条 try/catch
- [x] Discord 按钮过滤无效钓点(空名字会让 Discord API 抛错)

**死代码清理**
- [x] `result.full`(与 summary 完全相同,无人读取)
- [x] `L.zh.precip` / `L.en.precip`(降水已合进天气行)
- [x] `computeHourlyBlocks` 的 `_unitSystem` 参数
- [x] `registerTools.js` 的 `export const toolSchemas`(无人 import,且泄漏 adminOnly schema)
- [x] Discord `chunks.length === 0` 不可达分支
- [x] `payload.hourlyBlocks`(提示词已不引用,与原始 hourly 重复,纯浪费 token)

**状态:已上线**

---

## 决策记录
- 传输:**企业微信智能机器人 + WebSocket 长连接**(`@wecom/aibot-node-sdk`)
- 凭据:**botId + secret**(智能机器人),非自建应用 agentId/corpId
- LLM:**OpenAI**(function calling),双模型策略:
  - `OPENAI_MODEL`=**gpt-5.6-terra**(analyzeFishing 报告,需深度推理)
  - `OPENAI_MODEL_FAST`=**gpt-5.6-luna**(意图提取+兜底调度,reasoning_effort='none')
  - 历史:gpt-4o-mini → gpt-5.4 → gpt-5.4+5.4-mini → gpt-5.6-terra+luna
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
