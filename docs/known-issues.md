# Known Issues

## 已修复

### 1. 按钮点击后语言检测丢失上下文 ✅

**场景：** 用中文问"钓点"→ 弹按钮 → 点击后回复变英文；或反之。纯坐标、Telegram Location 消息本身没有自然语言文字，无法判断用户想要什么语言。

**原因：** 按钮回调构造的内部查询语言写死，`detectLang` 按那段文本判断，与用户原始消息语言脱节。

**解决（方案 A + B 组合）：**
- 传输层用 `userLang` Map 记住每个用户**最近一条文字消息**的语言（带 `ts`，进 sweep 清理，写入排在白名单校验之后）
- 按钮回调用 `buildQuery(spotLabel, timeKey, lang)` 按该语言构造查询，并把 `lang` 直接透传给 `runAgent`（不再让它从措辞里反推）
- 无记录时（进程刚重启、从未发过文字）用 `.env` 的 `DEFAULT_LANG` 兜底

**遗留：** 进程重启后 `userLang` 清空，此时点旧按钮会用 `DEFAULT_LANG`。可接受——发一条消息后就恢复正常。

---

### 2. 附件文件名 C/T/P 前缀在美东傍晚后判断错误 ✅

**场景：** 美东 20:00 之后问"今天怎么样"，附件名是 `P-钓点-<明天>.txt`，内容却是从现在起 24 小时。`T` 前缀在这条路径上不可达。另外 astronomy 数据源失败时，预测数据会被标成 `C`（现在）。

**原因：** 前缀从 `conditions.date` 反推，而该字段来自 astronomy 的 `fmtDay()`（用 `getUTC*`），与 `etNow()` 的美东日期不同基准；astronomy 走 `settle()` 容错，失败时该字段为 `null`。

**解决：** `spotFileName(c, { mode, date })` 改由**调用方已知的 mode/date** 决定前缀，不再从数据字段反推。三个调用点（两个天气工具、analyzeFishing、快捷管道）都显式传入。

---

## 未修复 / 已知限制

### 3. 多钓点对比时导航按钮只指向最后一个

**场景：** 问"A 和 B 今天哪个好"，模型会调两次天气工具。附件是两份（每个钓点一份），但导航按钮只有一个，指向最后被查的那个钓点，且按钮文案不含钓点名，用户无法判断它指哪儿。

**原因：** `agentCore` 的 `runToolLoop` 里 `coordinates` 是单个可变槽位，后一次调用覆盖前一次。

**可能的解决方案：** 收集成数组，每个钓点渲染一个带名字的按钮；或只在单点结果时挂按钮。

**状态：** 低优先级——对比查询不是主要用法。

---

### 4. 无自动化测试

项目没有测试框架。以下纯函数值得优先覆盖（不接 DB 不接网络）：
`spotFileName` 的 C/T/P 三分支、`buildQuery` 的 2 语言 × 3 时间键、`parseRawCoords` 的接受/拒绝边界、`stateToAbbr`、`formatSpotList(spots, lang)`、`parseSpotNameNote`、`validateSpotName`。
