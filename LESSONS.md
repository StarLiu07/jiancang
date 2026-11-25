# LESSONS.md（教训本）

> 吃一堑，长一智。前提是，这一堑被记下来了，且最终被机制堵死。

## 使用规则

1. **何时记录**：Agent 踩到明显坑、或**同类错误犯第 2 次**时记录一条。
2. **禁止直接堆规则**：先写在这里定位根因，优先按 `代码结构/类型 > Hook/Lint/脚本 > 回归测试 > AGENTS.md` 固化。
3. **唯一关单标准**：问一句——**“从机制上看，这个坑现在还踩得到吗？”** 踩不到了才把状态改为 `CLOSED`（不是“这次修好了”就关）。

---

## 记录模板

```markdown
### [OPEN] YYYY-MM-DD 简短标题
- **现象**：发生了什么，浪费了多少轮次/上下文
- **根因**：为什么会发生（上下文缺失 / 缺少验证 / 工具输出误导 / 角色边界不清）
- **固化方式**：[ ] 代码结构  [ ] Hook/脚本  [ ] 回归测试  [ ] AGENTS.md
- **红灯验证**：已用已知错误输入确认新机制会报红？（是/否）
- **落地位置**：关联的 commit / 文件路径
```

---

## 教训列表

### [CLOSED] 2026-11-25 链接抓取五大结构性缺陷（小红书短链、WAF 指纹、壳页误判与本地图片白框）
- **现象**：实测 Android 端分享 `xhslink.cn/o/...` 时，被识别为 `网页`、标题变成 `小红书 - 你的生活兴趣社区`、状态为 `部分成功`、正文缺失，且 `1 张 · 已本地化` 的图片显示为空白占位框。
- **根因**：
  1. **静态域名白名单缺失且无重定向后二次路由**：前后端均漏掉 `xhslink.cn`（与 `t.co`），且 `GenericWebExtractor` 跟随 302 跳转到真实域名后丢弃 `final_url`，未重新路由给专用提取器。
  2. **小红书 WAF `Accept-Encoding` 指纹 + OkHttp 解压陷阱**：小红书 WAF 对 Android OkHttp 默认的 `Accept-Encoding: gzip` 与 Node Undici 默认的 `br, gzip, deflate` 直接 302 到 `/login?redirectPath=...`；在 OkHttp 手动设 `gzip, deflate` 又会关闭其透明解压。实测仅对小红书发送 `Accept-Encoding: gzip;q=0, deflate;q=0, identity` 可同时通过 WAF 并返回纯 UTF-8 未压缩 HTML。
  3. **壳页误判与提取质量缺陷**：小红书登录壳页未过滤、后端 MCP 排在 OG 之后、小红书 `imageList` 与 `infoList` 重复抓图且正文换行被压平；微信验证页（`环境异常`）落入 `body` 被误标为 `ready`。
  4. **系统分享丢失原口令文案**：`buildSharePayload` 提取 URL 后丢弃了原始分享标题/文案。
  5. **相对 `local_path` 未拼接 `documentDirectory`**：`media.ts` 存入相对路径 `clips/...`，而 `db.ts` 只识别 `file://` 前缀，导致所有本地已下载图片错误回退到不可达的局域网 `/api/media/{id}`。
- **固化方式**：[x] 代码结构（重定向二次路由 + `XHS_HEADERS` + `unwrapXhsRedirect` + `resolveMediaFileUri`）  [ ] Hook/脚本  [x] 回归测试（后端 +25 条 pytest，移动端 +20 条 node:test）  [ ] AGENTS.md
- **红灯验证**：是（实测复现 `/login` 302、补测 `/login?redirectPath=...` 自定义 `og:title` 壳页红灯转绿灯，并实测真链 `http://xhslink.cn/o/AbuixShqJX6` 前后端均完整抓出标题/作者/5 段正文/12 张去重 HTTPS 图）
- **落地位置**：`backend/app/services/url_utils.py`、`backend/app/services/extractors/{__init__,generic,xhs,wechat,x}.py`、`mobile/src/local/{urlUtils,media,db}.ts`、`mobile/src/local/extractors/{index,generic,xhs,wechat,x}.ts`、`mobile/src/utils/url.ts`

### [CLOSED] 2026-11-25 小红书解析“开始能成功、后面被登录拦截”的四层根因
- **现象**：同版本 APK（v0.6.0）刚装上时可正常抓取小红书，过一段时间后（尤其是 5G + VPN 场景或连续抓取后）开始报错 `触发小红书登录拦截，无法直接读取笔记`，且点击「重新抓取」无法恢复；实测同一条短链 `https://xhslink.cn/o/6yY8iOgqvC4` 在国内住宅 IP 下 7 小时后仍可完整抓出标题与 9 张图。
- **根因**：
  1. **出口 IP / VPN / 5G 共享 IP 触发小红书边缘 WAF 状态风控**：未登录游客抓取依赖小红书 SSR 豁免通道，海外/机房 VPN 或高频共享 5G IP 会直接被 OpenResty 302 到 `/login?redirectPath=...`，且原架构在手机本地被拦截时完全没有回退到家用 NUC（住宅 IP + 可选 MediaCrawler MCP）兜底。
  2. **React Native `fetch` 默认 `withCredentials = true` 导致 Android `CookieManager` 持久化污染**：`fetchHtml` 未传 `credentials: 'omit'`，OkHttp `ForwardingCookieHandler` 会把 `acw_tc` 和 1 年期 `abRequestId` 写入 WebView 持久化 Cookie 并在后续请求及跨 Wi-Fi/5G/VPN 切换时持续回放。
  3. **失败降级覆写原短链 + `http://` 降级与 `/404` 未解包**：`/login?redirectPath=http://...&exSource=null` 解包后未升回 `https://`、未清噪声参数、未处理 `/404?source=/404/sec_...?redirectPath=...`，且降级时用解包链接覆盖了 `clip.url` 里的 `xhslink.cn` 短链，导致重试无法回退原短链。
  4. **同步推送无服务端补抓**：移动端离线被拦截后推送 `partial`/`failed` 剪藏到 NUC 时，服务端仅排队补 AI 摘要，未触发 `process_clip` 自动补抓正文与图片。
- **固化方式**：[x] 代码结构（`credentials: 'omit'` 切换 `CookieJar.NO_COOKIES` + `unwrapXhsRedirect` 升级 HTTPS/解包 `/404`/清 `exSource=null` + 多策略与 `raw_input` 短链自愈 + `POST /api/extract` 实时 NUC 兜底 + `sync/push` 后台自动补抓）  [ ] Hook/脚本  [x] 回归测试（后端 195 条 pytest + ruff，移动端全量 node:test + tsc）  [ ] AGENTS.md
- **红灯验证**：是（先写红灯单测覆盖 `credentials: 'omit'`、`/404` & `http://` & `exSource=null` 解包、受损 URL 从 `raw_input` 恢复短链、`POST /api/extract` 与同步补抓，并实测真链 `https://xhslink.cn/o/6yY8iOgqvC4` 正常抓取及受损 URL 重试自愈均返回完整标题与 9 张图）
- **落地位置**：`backend/app/models.py`、`backend/app/services/extractors/xhs.py`、`backend/app/services/sync.py`、`backend/app/routers/{clips,sync}.py`、`backend/app/main.py`、`mobile/src/types.ts`、`mobile/src/api/client.ts`、`mobile/src/local/extractors/{generic,xhs}.ts`、`mobile/src/local/{ingest,repository}.ts`、`mobile/app/{clip/[id],(tabs)/index,(tabs)/library}.tsx`、`mobile/src/hooks/useShareCapture.ts`
