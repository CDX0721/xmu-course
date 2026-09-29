---
name: xmu-course
description: 操作厦门大学课程中心 lnt.xmu.edu.cn 的接口，用于查看和下载课件、浏览和提交作业、查询点名记录、作业得分与成绩构成、复盘已参加的测试（题目与答案）、读取课程公告与站内通知。当用户提到 LNT、课程中心、厦大课程平台、某门课的作业/课件/点名/成绩/测试/公告/通知，或要求下载课件、提交实验报告、查历史作业分数、回顾测试答卷、看老师发了什么时使用。优先用已登录的内置浏览器会话；没有浏览器时也能靠纯 HTTP 自己完成 CAS 登录握手。
argument-hint: '[课程名或 courseId] [操作]'
version: 1.0.0
---

# 厦门大学课程中心（lnt.xmu.edu.cn）自动化

## Overview

用内置浏览器已登录的会话直接调 LMS 的 JSON 接口，完成课件下载、作业查看与提交、点名和成绩查询。
比点 UI 快且可批量；写操作有强制确认闸门。

## 铁律（先读这条）

1. **绝不擅自提交作业。** 默认只做只读探索。真正 `submit()` 前必须向用户复述：课程名、作业标题、截止时间、要上传的文件绝对路径、正文，并得到明确"确认提交"。误交不可逆。
2. **凭据只用于登录。** 学号和密码不得出现在 skill 文件、示例、命令行参数、日志、下载清单、作业正文或任何会外发/落盘的内容里。要自动登录就从环境变量（`XMU_USER` / `XMU_PASS`）或仓库外的本地文件（`xmu-http.mjs --creds <本地文件>`）读；读到的值只喂给登录表单，不回显、不复制。
3. **不要外传同班数据。** `homework-student-status` 等接口返回全班同学状态，只取自己那一项，不要整表打印。
4. **只读操作可放手做**：列课程、列课件、取直链、查点名、查成绩、读作业要求、存草稿。
5. **测试的答案不绕权限。** 与课件"禁止下载"不同，题目的服务端是真的鉴权：`/api/exams/{eid}/subjects` 对学生一律 403。只复盘**本人答过、且教师已公布答案**的测试（先查 `exam-list` 的 `answerAnnounced`）；答案未公布时直接说拿不到，不要试探接口去绕过 —— 那是考核诚信。
6. **不要把隐私写进 skill。** 本 skill 公开分发：skill 文件、导出的 md、示例输出里不得出现真实学号 / 姓名 / uid / 有效会话 / 凭据 —— 一律用 `{uid}`、`<你的学号>` 这类占位符。`xmu-cookies.json` 和凭据文件放在仓库外（用 `XMU_JAR` 指过去）。公告、通知、答卷的原文含他人姓名和群号，只留本地，不要提交或外发。

## 前置：拿到已登录的浏览器上下文

平台会话是 **httpOnly cookie**，浏览器里读不到，但**不是只能靠浏览器**：
- 有内置浏览器时（推荐，最省事）：在页面里注入 `scripts/xmu.js` 调接口。
- 没有浏览器 / 要后台跑：自己走 CAS 登录握手拿 cookie，见 `references/http-login.md`（纯 curl 与 Node 两份实测实现）。

```
1. mcp__browser-use__navigate_page → https://lnt.xmu.edu.cn/user/index
2. mcp__browser-use__take_snapshot
   - 出现"我的课程 / 待办"等内容 = 已登录，继续
   - 跳到 ids.xmu.edu.cn 统一身份认证 = 未登录 → 告诉用户在浏览器窗口里完成登录
     （账号登录 tab，或企业微信扫码），等他说好了再继续
3. 记住当前页必须在 lnt.xmu.edu.cn 域下，否则 fetch 同源受限
```

## 注入 helper 库

`scripts/xmu.js` 是一个自包含的 `async () => {...}` 函数，读取后原样作为 `evaluate_script` 的 `function` 参数注入，会在页面上挂 `window.XMU`。注入一次后，同一页面的后续调用可直接用 `window.XMU.*`（页面刷新/跳转后要重注入）。

```
Read  scripts/xmu.js
mcp__browser-use__evaluate_script({ function: <文件内容> })   →  "XMU ready @ lnt.xmu.edu.cn"
```

调用统一形如（返回值必须自己 `JSON.stringify`，`evaluate_script` 只回传字符串）：

```js
async () => JSON.stringify(await window.XMU.homeworks(120001), null, 1)
```

### XMU 方法一览

| 方法 | 作用 |
|---|---|
| `me()` | 当前用户 `{id, user_no, name}` |
| `semesters()` / `courses(semesterId?)` | 学期列表 / 我的课程 |
| `todos()` | 未交作业等待办 |
| `modules(cid)` | 章节树 |
| `coursewares(cid)` | 课件列表（含 `uploadId`） |
| `urls([uploadId])` | 换签名下载直链 |
| `rollcalls(cid)` / `rollcallScore(cid)` | 点名历史 / 点名得分 |
| `homeworks(cid)` | 历史作业：标题、截止、得分、是否已交 |
| `activity(aid)` | 单次作业详情（含要求正文） |
| `submissions(aid)` / `homeworkScore(aid)` | 我的提交记录 / 该次得分 |
| `exams(cid)` | 课程下的测试：我的分、题量、`answerAnnounced`（能否看答案） |
| `myExamSubmissions(eid)` | 我在某测试的提交（`id` 用于回顾） |
| `examPaper(eid, sid)` | 本人答卷：题干/选项/我的作答/参考答案/逐题对错与得分 |
| `examReviewMd(eid, sid)` | 把上面那份渲染成 markdown 复盘稿 |
| `bulletins(cid, {keyword})` / `bulletin(cid, bid)` | 课程公告：正文纯文本 + 附件 `uploadId` + 正文内嵌图片 id |
| `notifications(limit)` | 站内通知（新课件、作业开交、批改回来、临期），带未读数 |
| `announcements()` | 平台级公告（平时为空） |
| `upload(name, base64, mime)` | 本地文件 → 平台附件，返回 `uploadId` |
| `uploadFromLocal(url, name, mime)` | 大附件走本机 http 服务取 blob 再上传，避开 base64 膨胀 |
| `saveDraft(aid, {comment, uploads})` | 存草稿（安全，可逆） |
| `submit(aid, {comment, uploads})` | **正式提交，需确认** |
| `raw(path, opts)` | 未封装端点的逃生口 |

## 常用流程

### 1. "我有哪些作业要交"

```js
async () => JSON.stringify(await window.XMU.todos(), null, 1)
```

要看该门课全部作业（含已交）：`XMU.courses()` 拿 `cid`，再 `XMU.homeworks(cid)`。
`myStatus`：`un_submitted`=未交，`un_marked`=已交待批改，`marked`=已批改。

### 2. 下载课件

浏览器取直链 → 交给 Node 落盘（直链不需要 cookie，可脱离浏览器）。

```js
// ① 列课件，挑 uploadId
async () => JSON.stringify(await window.XMU.coursewares(120002), null, 1)
// ② 换直链
async () => JSON.stringify(await window.XMU.urls([9000001, 9000002]))
```

把 ② 的 JSON 存成 `manifest.json`，然后：

```bash
node "$HOME/.qoder-cn/skills/xmu-course/scripts/download.mjs" --manifest manifest.json --dir ./courseware
```

**教师勾了"禁止下载"也能拿到**：`uploads[].downloadable === false` 只是网页上没下载按钮，预览走的就是 `/api/uploads/{id}/url`，服务端不按该标志校验，`urls()` 照样返回可用直链（2026-09-29 实测）。所以不要看到 `false` 就说"下不了"。
反过来说，这是绕过任课教师"只许在线看"的意愿 —— 只用在自己已选修、本来就能预览的材料上做离线复习；答案/评分标准类文件不碰；不要外传，也不要无差别把整门课几百个文件拖下来。用户没点名要哪些时，先列出来让他挑。

按条件批量下（例：某章全部、排除超大文件）—— 在浏览器里过滤后再生成清单，避免拉下几百 MB 源码包：

```js
async () => {
  const cw = await window.XMU.coursewares(120002);
  const ids = cw.flatMap(a => a.uploads.filter(u => u.size < 20e6).map(u => u.uploadId));
  return JSON.stringify(await window.XMU.urls(ids));
}
```

直链按天签名，取完尽快下；过期重新调 `urls()`。

### 3. 查看点名记录

```js
async () => JSON.stringify({
  history: await window.XMU.rollcalls(120001),
  summary: await window.XMU.rollcallScore(120001),
}, null, 1)
```

`status` 里 `on_call_fine` = 正常应答。`rollcallScore.score` 为 `0` 通常表示该课未把点名计入总评，不是缺勤。

### 4. 查看作业得分与成绩构成

```js
async () => JSON.stringify({
  homeworks: await window.XMU.homeworks(120001),
  scoreGroups: await window.XMU.raw('/api/courses/120001/student/score-item-groups'),
  performance: await window.XMU.raw('/api/course/120001/performance-score?isOriginalScore=true'),
}, null, 1)
```

某一次作业的分数和教师评语：`XMU.homeworkScore(aid)`、`XMU.submissions(aid)`。

### 5. 提交作业（默认停在确认前）

```
① 读要求，向用户复述
   await XMU.activity(aid)         → title / due / desc / form
   确认 form === 'file_upload'（其他形式如在线作答，别硬套本流程）

② 本地文件转 base64（注意 Windows 换行不要破坏二进制）
   base64 -w0 "报告.pdf"

③ 上传附件（只读性质，不产生提交）
   await XMU.upload('报告.pdf', '<b64>', 'application/pdf')   → {uploadId}

④ 先存草稿占位，安全
   await XMU.saveDraft(aid, {comment:'<p>已完成，见附件。</p>', uploads:[uploadId]})

⑤ 闸门：向用户复述 课程名 / 作业标题 / 截止时间 / 文件绝对路径 / uploadId
   等用户明确说"确认提交"再执行 ⑥

⑥ 正式提交
   await XMU.submit(aid, {comment:'<p>已完成，见附件。</p>', uploads:[uploadId]})

⑦ 校验：XMU.submissions(aid) 的 list[0] 应满足 isDraft === false 且 uploads 非空
```

`uploads` 必须是**字符串 id 数组**（传数字会被静默丢弃、传对象直接 500）。
`comment` 是 HTML，富文本正文可留空只交附件。

### 6. 复盘测试（题目 + 我的答案 + 参考答案）

先确认答案公布了没有，再取题：

```js
async () => JSON.stringify(await window.XMU.exams(120005), null, 1)   // 看 answerAnnounced
async () => JSON.stringify(await window.XMU.myExamSubmissions(30001), null, 1)
```

`answerAnnounced: false` 就到此为止，直接告诉用户"教师没公布答案，拿不到"，别去试接口。
公布了就导出（`sid` 省略时取最近一次提交）：

```js
// 只看错题
async () => { const p = await window.XMU.examPaper(30001, 40002);
  return JSON.stringify({score: p.score, wrong: p.subjects.filter(q => q.correct === false)}, null, 1) }
```

```js
// 整份复盘稿，写文件时用 Node 更方便
// node scripts/xmu-http.mjs exam-review 30001 40002 --out 复盘.md
async () => await window.XMU.examReviewMd(30001, 40002)
```

一次返回整卷（见过 175 题不分页），题干和选项是 HTML，helper 里已经 `strip()` 过。
`/api/exams/{eid}/subjects` 是学生 403 的那条（服务端鉴权），别照着课件那招去试。

### 7. 看公告 / 最近有什么新东西

```js
async () => JSON.stringify(await window.XMU.notifications(30), null, 1)   // 最省事：新课件/作业开交/批改/临期
async () => JSON.stringify(await window.XMU.bulletins(120008), null, 1)    // 某门课的公告（可传 {keyword:'组队'}）
```

公告里的 `attachments[].uploadId` 和 `inlineUploads[]`（正文内嵌的二维码、截图）可以直接喂 `urls()` / `download()` —— **教师经常只把作业模板、格式说明挂在公告里，不在作业活动中**，找模板时先看公告。
`conditions` 里的 `start_date/end_date` 不生效，只有 `keyword`（按标题）有用。
通知的 `timestamp` 是**毫秒**，与其他接口的 ISO 字符串不同。

⚠️ 公告/通知正文里会有同学姓名、群号、教师邮箱。只给你自己看，别把原文塞进仓库、日志或任何要发布的东西里（见铁律 6）。

### 8. 探索还没封装的模块

讨论 / 问卷 / 直播 / 分组 / 笔记 / 学习分析 等接口在 `references/api.md` 里有一部分。要补全时：

```js
async () => JSON.stringify(await window.XMU.raw('/api/courses/120005/exam-list?page=1&page_size=50'), null, 1)
```

新端点用 `navigate_page` + `list_network_requests` 反查，方法记在 `references/api.md` 的"探测未使用端点的方法"。
发现稳定的坑或新端点，**回头更新 `references/api.md` 和本文件的方法表**。

## Resources

- `scripts/xmu.js` — 注入浏览器的接口封装库（`window.XMU`），覆盖身份/课程/课件/点名/成绩/上传/提交
- `scripts/download.mjs` — Node 批量下载器，吃 `XMU.urls()` 的 JSON 清单，保留中文文件名
- `references/api.md` — 完整端点目录、鉴权机制细节、载荷格式、状态码语义、已知坑
- `references/http-login.md` — **无浏览器**接入手册：CAS 登录握手细节 + 密码加密算法 + 纯 curl / Node 两份实测实现
- `scripts/xmu-curl-login.sh` — 只用 curl + openssl 完成登录，产出 Netscape cookie jar
- `scripts/xmu-http.mjs` — Node ≥18 零依赖客户端（`login`/`api`/`XMU` 三个导出 + CLI），接口与 `xmu.js` 一一对应
