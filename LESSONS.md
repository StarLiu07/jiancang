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
