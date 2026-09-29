# Changelog

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

## 1.0.0 — 2026-09-29

首个公开版本。

### Added

- `scripts/xmu.js`：注入内置浏览器的接口封装（`window.XMU`），覆盖身份 / 学期 / 课程 / 待办 / 章节 / 课件 / 直链 / 点名 / 作业 / 上传 / 草稿 / 提交。
- `scripts/xmu-http.mjs`：Node ≥18 零依赖客户端，自己完成 CAS 登录握手，方法与 `xmu.js` 一一对应；附 CLI（`login` / `semesters` / `courses` / `todos` / `coursewares` / `fetch-urls` / `download` / `homeworks` / `rollcalls` / `submissions` / `exams` / `exam-subs` / `exam-review` / `bulletins` / `bulletin` / `notifications` / `raw`）。
- `scripts/xmu-curl-login.sh`：只用 curl + openssl 完成登录，产出 Netscape cookie jar。
- `scripts/download.mjs`：批量下载签名直链，保留中文文件名。
- `references/api.md`：端点目录、鉴权细节、载荷格式、状态码语义、已知坑。
- `references/http-login.md`：无浏览器接入手册 —— CAS 握手逐步拆解、密码加密算法、curl 与 Node 两份实测实现、CLI 用法。
- 测试（exam）模块：`exams` / `exam` / `myExamSubmissions` / `examPaper` / `examReviewMd`，只读本人答卷，且以"教师已公布答案"为前提。
- 公告与通知：`bulletins` / `bulletin` / `announcements` / `notifications`（通知中心在 `/ntf` 前缀下，时间戳为毫秒）。
- `SKILL.md` frontmatter 新增 `version`。

### Known limits

- 平台会话是 httpOnly cookie，约 24h 过期，过期后需重新登录。
- 课件签名直链按天轮换，取到后尽快下载，过期重新换取。
- 部分模块（讨论 / 问卷 / 直播 / 分组 / 学习分析）尚未封装，用 `raw()` 逃生口自行探测。
