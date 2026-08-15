# Known Issues

## Design Bugs

### 1. 按钮点击后语言检测丢失上下文

**场景：** 用户用中文问"fishing point"（模糊匹配弹出多候选按钮），点击按钮后回复变成英文；或者发纯坐标弹菜单后点击查询，回复语言无法跟随用户之前的语言。

**原因：** 按钮回调构造的内部查询是固定英文（`"spot.name how is it today?"`），`detectLang` 检测不到中文字符 → 走英文路径。纯坐标/Location 消息本身没有自然语言文字，无法判断用户想要什么语言。

**影响：** 用中文问 → 弹按钮 → 点按钮 → 回复变英文（语言不一致）。

**可能的解决方案：**
- 方案 A：记住每个用户上一次消息的语言（内存 Map: userId → lastLang），无文字场景用 lastLang
- 方案 B：在 `.env` 里加 `DEFAULT_LANG`，无法 detect 时用默认值
- 方案 C：按钮 callback_data 里编码语言信息（增加复杂度，且 Telegram callback_data 有 64 字节限制）

**状态：** 暂不修复，等后续决策。

---
