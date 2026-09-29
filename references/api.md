# lnt.xmu.edu.cn 接口参考

平台内部代号"课程中心 / LNT"，前端为 Angular + React 混合 SPA（版本形如 `1.79.xxxxx-release`）。
以下端点均在真实已登录会话上验证过（2026-09）。

## 鉴权（最关键，决定架构）

- 登录走厦门大学统一身份认证 CAS：`lnt.xmu.edu.cn` → 302 → `c-identity.xmu.edu.cn`（Keycloak）→ `ids.xmu.edu.cn/authserver/login`（支持扫码 / 账号密码）→ ticket 回跳。
- 会话凭据是 **httpOnly cookie**，JS 读不到。实测：只带可读的 `role_token` 用 curl 请求 `/api/*` 会被 302 到 `c-identity.xmu.edu.cn`。
  - `document.cookie` 里只有 `role_token`，形如 `base64url({"exp","org_id","roles":["Student"],"uid"}) + 签名`，有效期约 24h。它是辅助 token，**不能**单独用于 API。
- 结论：**所有 `/api/*` 调用必须在已登录的浏览器页面上下文里发起**（`mcp__browser-use__evaluate_script` + `credentials:'include'`）。纯 CLI/Node 拿不到会话。
- 例外：**`c-media.xmu.edu.cn` 的签名直链不需要任何 cookie**，可以在浏览器之外用 curl / Node 下载。这就是"浏览器取 URL、Node 落盘"混合架构的依据。

## 用户 / 学期 / 课程

| 端点 | 说明 |
|---|---|
| `GET /api/profile` | **当前登录用户**。`{id, user_no, name, roles}`。uid 从这里取，没有 `/api/me` |
| `GET /api/current-semester-info` | 当前学年学期 `{academic_year:{id,start_date}, semester:{id,code,name}}` |
| `GET /api/my-academic-years` | 学年列表 |
| `GET /api/my-semesters` | 学期列表，用于筛选 |
| `POST /api/my-courses` | 我的课程。按学期筛选传 `{"conditions":{"semester_ids":[35]}}` |
| `GET /api/todos` | 待办（未交作业/测试）。`todo_list[]: {id, course_id, course_name, title, type, end_time, is_locked}` |
| `GET /api/announcement` | 平台级公告（平时多为空），见下方「公告 / 通知」 |
| `GET /ntf/users/{uid}/notifications?limit=N&additionalFields=unread_count` | 站内通知（**注意前缀是 `/ntf` 不是 `/api`**）。作业评分返回会以 `homework_score_updated` 推到这里 |
| `GET /api/user/{uid}/common-entries` | 常用入口 |
| `PUT /api/user/recently-visited-courses` | 记录最近访问 |

`uid` 在多个端点里出现（点名、提交列表、通知）。用 `GET /api/profile` 现取 `{id, user_no, name}`，不要把它写进任何文档、示例或提交历史。

## 课程与章节

课程 Web 路由：`/course/{cid}/{module}`，模块有 `index content knowledge-graph bulletin live-activities lesson courseware homework exam forum questionnaire classroom group-set note notebook`。
侧栏另有 `rollcall inclass-report score my-stat enrollments outline teaching-schedule-and-others extensions`。

| 端点 | 说明 |
|---|---|
| `GET /api/courses/{cid}?fields=...` | 课程详情，支持稀疏字段集 |
| `GET /api/courses/{cid}/modules` | 章节树 + 大纲 `syllabuses[]`（课件按 `module_id`/`syllabus_id` 归类） |
| `GET /api/courses/{cid}/activities?sub_course_id=0` | 章节页全部学习活动 |
| `GET /api/courses/{cid}/nav-setting` | 侧栏开关 |
| `GET /api/course/{cid}/activity-publish-setting` | 发布设置 |
| `GET /api/course/{cid}/activity-reads-for-user` | 我的已读/学习进度，`data.actions` 含 `submit` 等 |
| `GET /api/courses/{cid}/exam-list?page=1&page_size=50` | 测试列表（实测；`exams[]` 含 `score`/`final_score`/`submit_times`/`subjects_count`/`announce_answer_status`/`is_announce_answer_time_passed`） |
| `GET /api/courses/{cid}/exam-submissions` | 我这学期在这些测试里的提交：`{"{examId}": [{id, score}]}`，未提交则是空数组 |
| `GET /api/courses/{cid}/live-record` | 直播回放 |
| `GET /api/courses/{cid}/interactions` | 课堂互动 |
| `GET /api/courses/{cid}/group-sets?preload_id=0` | 分组 |
| `GET /api/courses/{cid}/enrollments/users/{uid}` | 我的选课身份（院系 / 角色） |
| `GET /api/activities/{aid}?sub_course_id=0` | **单个活动详情**。作业要求正文在 `data.description`（HTML），形式在 `data.homework_type` |

## 课件

| 端点 | 说明 |
|---|---|
| `GET /api/course/{cid}/coursewares?page=1&page_size=200` | 课件列表。`activities[]` → 每项含 `uploads[]` |
| `GET /api/uploads/{uploadId}` | 附件元数据（`key` 为文件哈希、`size`、`type`、`status`） |
| `GET /api/uploads/{uploadId}/url` | **换签名下载直链** |
| `GET /api/uploads/{uploadId}/url?preview=true` | 预览用的链，与不带参数的**返回同一条直链**（这就是"禁止下载也能拿到"的入口） |
| `GET /api/uploads/{uploadId}/text?preview=true` | 文本类内容正文 |
| `GET /api/uploads/{uploadId}/pdf-info?preview=true` | PDF 页数（不是所有文件都支持，见过 400） |

签名直链格式：
`https://c-media.xmu.edu.cn/download/file/{key}?timestamp={ts}&token={tok}&name={filename}`
`timestamp` 按天滚动，所以直链会过期 —— **每次下载前现取**。

**"禁止下载"只是前端开关**：课件列表里 `uploads[].allow_download === false`（任课教师勾掉下载）时，`GET /api/uploads/{id}/url` **仍然返回可用直链**，能拿到完整字节。2026-09-29 在三门往期课程的 122 个"禁止下载"文件上抽样验证：返回 `%PDF-1.7` 魔数、`Range` 支持 206、总长度与 `size` 一致。原因很直白 —— 预览用的就是这同一个端点，服务端没有按该标志做二次校验；`/api/uploads/{id}` 的元数据里也压根没有这道闸门（标志来自活动层配置）。

⚠️ 这只说明"技术上拿得到"，不代表可以随意拿。仅用于自己已选修、本来就能在线预览的材料做离线复习；答案类文件不碰；不要外传、不要无节制批量拖取。提交作业等写操作仍走 SKILL.md 的确认闸门。

## 点名 / 考勤

| 端点 | 说明 |
|---|---|
| `GET /api/course/{cid}/student/{uid}/rollcalls?page=1&page_size=200` | **我的点名历史**。`status`=`on_call_fine`/… ，`student_status`=`on_call`，含 `scored` |
| `GET /api/course/{cid}/rollcall-score` | 点名得分汇总 `{rollcall_count, rollcall_times, score, score_percentage}` |
| `GET /api/course/{cid}/rollcall/setting` | 计分方式（`score_method`、`auto_scoring` 等） |
| `GET /api/courses/{cid}/modules/rollcalls` | 全部点名场次（含 `end_time`） |

教师端 `GET /api/course/{cid}/rollcalls` 对学生返回 **403**。
注意 `score` 可能为 `"0"` 而 `status` 全为 `on_call_fine` —— 该课未把点名计入总成绩，不是异常。

## 成绩

`GET /api/course/{cid}/...` 与 `GET /api/courses/{cid}/...`（单复数）两套前缀都存在，照抄别混。

| 端点 | 说明 |
|---|---|
| `GET /api/course/{cid}/homework-scores?fields=id,title,data,end_time,score_percentage,is_in_progress,module_id` | **历史作业得分**。`data.description` 是作业要求正文 |
| `GET /api/course/{cid}/homework-student-status` | 状态表，形如 `{"{aid}": {"{uid}": "un_submitted\|un_marked\|..."}}`，**两层嵌套**且含全班同学 |
| `GET /api/course/{cid}/rollcall-score` | 点名得分 |
| `GET /api/course/{cid}/performance-score?isOriginalScore=true` | 平时成绩 |
| `GET /api/course/{cid}/interaction-scores` | 互动得分 |
| `GET /api/course/{cid}/forum-scores` | 讨论得分 |
| `GET /api/course/{cid}/questionnaire-scores` | 问卷得分 |
| `GET /api/course/{cid}/classroom-exam-scores` | 随堂测验得分 |
| `GET /api/course/{cid}/student-self-score` | 自评 |
| `GET /api/courses/{cid}/exam-scores?no-intercept=true` | 测试得分 |
| `GET /api/courses/{cid}/custom-score-items` | 自定义成绩项 |
| `GET /api/courses/{cid}/student/score-item-groups` | 成绩构成权重（平时/实验/期中/期末/考勤/上机/其他） |
| `GET /api/courses/{cid}/announce-score-settings` | 成绩公布设置 |

教师端 `GET /api/course/{cid}/scores`、`GET /api/scores?course_id=` 对学生 403。

## 测试（exam）

2026-09-29 实测（当期课程没有测试，用三门往期课程验证；文中所有 id 都是占位值）。
Web 路由：测试详情 `/course/{cid}/learning-activity#/exam/{eid}`，答卷回顾 `/exam/{eid}/subjects#/submission/{sid}`。

| 端点 | 说明 |
|---|---|
| `GET /api/courses/{cid}/exam-list?page=1&page_size=50` | 课程下全部测试；`exams[]` 自带 `score`（我的分）、`final_score`、`submit_times`、`subjects_count`、`is_closed`、`announce_answer_status`、`is_announce_answer_time_passed` |
| `GET /api/courses/{cid}/exam-submissions` | 我的提交，形如 `{"{eid}": [{id, score}]}`；没交过就是空数组 |
| `GET /api/exams/{eid}` | 测试元数据，学生可读：`subjects_count`、`submit_times`、`score_rule`、`announce_answer_status/-type/-time`、`subjects_rule` |
| `GET /api/exam/{eid}/check-exam-qualification?no-intercept=true` | 防作弊配置：`enable_anti_cheat`、`disable_copy_paste`、`is_fullscreen_mode`、`leaving_window_limit`、`limit_time` 等（注意前缀是单数 `/api/exam/`） |
| `GET /api/exam/{eid}/subject-groups` | 试卷分组（按题型），`data[].{id,name,sort,subject_type}` |
| `GET /api/exams/{eid}/submissions` | 我在该测试的提交列表：`{exam_score, exam_score_rule, submissions[].{id,score,submitted_at,submit_method,submit_method_text,exam_type_text}}` |
| `GET /api/exams/{eid}/submissions/{sid}` | **答卷回顾**，即页面上「查看」按钮打的那条请求，只含本人作答 |
| `GET /api/exams/{eid}/subjects-summary?for_submissions=true&submission_ids={sid}` | 逐题清单 `subjects[].{id,type,point,has_audio}`，一次返回整卷（见过 175 题不分页） |
| `GET /api/submissions/{sid}/submission_marked_attachments` | 答卷里的附件（主观题截图之类） |
| `GET /api/exams/{eid}/subjects` | 整卷题目/题库 —— **对学生 403「您没有权限完成此操作」**，无论答案是否公布（已公布与未公布的测试都验过） |

`/api/exams/{eid}/submissions/{sid}` 的返回（字段名别记错，都是 snake_case）：

```
score, auto_mark, submit_method_text, submitted_at,
subjects_data.subjects[]      {id, sort, type, description(题干HTML), options[]{id,content,is_answer,sort,type},
                               point, difficulty_level, answer_explanation, wrong_explanation, sub_subjects, parent_id}
submission_data.subjects[]    {subject_id, answer, answer_option_ids[]}     # 我选的
correct_answers_data.correct_answers[] {subject_id, content, answer_option_ids[], point, type}
correct_data        {"{subject_id}": true|false}      # 逐题对错
submission_score_data{"{subject_id}": "0.5"}          # 逐题得分
```

⚠️ 与课件那个"禁止下载"不同，**测试的题目与答案是服务端鉴权**：`/api/exams/{eid}/subjects` 学生拿不到，`subjects_data` 里的 `is_answer` / `correct_answers_data` 只有在教师设置了公布答案（`announce_answer_status=immediate_announce` 或已过 `announce_answer_time`）时才随答卷下发。
所以本 skill 只做一件事：**把本人答过、且答案已公布的测试导出成 markdown 复盘**（`XMU.examReviewMd` / CLI `exam-review`）。
导出前先读 `exam-list` 确认 `answerAnnounced`；未公布答案的测试**不要去试这条链能不能绕过** —— 那是考核诚信，不是平台漏洞。导出的答卷属于个人成绩资料，不要外传。

## 公告 / 通知

2026-09-29 实测。课程 Web 路由 `/course/{cid}/bulletin`（前端哈希 `#/`）。

| 端点 | 说明 |
|---|---|
| `GET /api/courses/{cid}/bulletins?conditions={"start_date":"","end_date":"","keyword":""}` | **课程公告列表**（`conditions` 必须 URL 编码）。返回 `{bulletins:[...]}`，无分页 |
| `GET /api/courses/{cid}/bulletins/{bid}` | 单条公告，字段同上 |
| `GET /api/announcement` | 平台级公告 `{announcements:[]}`，平时是空的 |
| `GET /ntf/users/{uid}/notifications?limit=N&additionalFields=unread_count` | **站内通知中心**，前缀是 `/ntf` 不是 `/api`。`{notifications[].{id,type,top,timestamp(ms),unread,payload}, unread_count}` |
| `GET /api/bulletins/latest?latest_only=true` | 端点存在，但带 `latest_only=true` 实测返回空数组，别拿它当入口 |

公告条目字段：`{id, title, content(HTML), created_at, updated_at, start_time, end_time, created_by{id,name}, targets, targets_name, send_type, send_email, uploads[]}`。
- `targets` 一般是 `["a0"]`，`targets_name` 为 `["所有人"]`。
- `uploads[]` 就是**标准附件对象**（`id/name/size/allow_download/origin_allow_download/key`），直接丢给 `urls()` / `download()` 即可下载 —— 教师传的作业模板、格式说明常挂在公告里而不在作业活动里。
- 正文里内嵌的图片（二维码、截图）写成 `https://lnt.xmu.edu.cn/api/uploads/{id}/in-rich-content?created_at=...`，把那个 `id` 也交给 `urls()` 就能换直链。
- `conditions` 里只有 `keyword`（按标题匹配）实测生效，`start_date/end_date` 不起作用。

通知 `payload` 随 `type` 变：`activity_opened`（新课件/活动，含 `activity_id, activity_title, activity_type, course_id, course_name, uploads[].{id,file_name,file_size}`）、`homework_opened_for_submission`、`homework_score_updated`（批改回来的通知）、`homework_expiring` / `homework_expiring_today` / `activity_expiring`。
`timestamp` 是**毫秒**，和 `/api` 那边的 ISO 字符串不同。这条链是"最近有什么新东西"最省事的入口，比遍历所有课程快得多。

⚠️ 公告与通知里可能出现同学姓名、群号、教师私人邮箱等个人信息；导出的 md 或日志不要把它带上仓库，更别对外发布。

## 作业：查看 / 提交 / 附件

| 端点 | 说明 |
|---|---|
| `POST /api/course/activities/{aid}/submissions` | **创建提交或草稿**（见下） |
| `GET /api/activities/{aid}/students/{uid}/submission_list` | 我的提交记录。**服务端按 新→旧 返回**，`list[0]` 才是最新 |
| `GET /api/activities/{aid}/students/{uid}/homework-score` | 该次作业我的得分 |
| `GET /api/homework/{aid}/students/{uid}/make-up-record` | 补交记录 |
| `GET /api/homework/{aid}/students/{uid}/resubmit-record` | 重交记录 |
| `GET /api/activities/{aid}/recommend-submissions` | 优秀作业 |
| `POST /api/course/activities/{aid}` | 标记活动已读（返回 201） |
| `GET /api/submissions/{sid}/marked_attachments` | 教师批注附件 |

提交载荷（全部字段都要给，缺字段会 400/500）：

```json
{
  "comment": "<p>正文 HTML</p>",
  "uploads": ["9000005"],
  "slides": [],
  "is_draft": false,
  "mode": "normal",
  "other_resources": [],
  "uploads_in_rich_text": []
}
```

- `is_draft: true` → 存草稿（响应 `{"message":"作业草稿已经保存"}`）；`false` → 正式提交。
- **`uploads` 必须是字符串 id 数组**。传 `[123]`（数字）被静默丢弃；传 `[{id:123}]` 直接 500；传 `["123"]` 才正确持久化。
- 草稿**没有删除接口**（实测 `/api/submissions/{id}`、`/api/course/activities/{aid}/submissions/{id}` 等 DELETE 全 404）。多条草稿会共存，正式提交时以最新为准，所以草稿不会误算成交货。
- 计分规则在活动的 `data.score_rule`（如 `highest` = 多次提交取最高），`data.allow_retract` 决定可否撤回。

### 上传文件（三步）

```
1. POST /api/uploads            body {name, size, type}   # 只有 name 是必填
   -> 201 {id, key, storage_type, upload_url}
2. PUT {upload_url}             FormData: file=<二进制>
   -> 200 {"file_key":"<sha-ish hash>"}
3. PUT /api/uploads/{id}/uploaded                            # 通知完成
```

- XMU 的 `storage_type` 是 **`MEDIA`**（签名直链指向 `c-media.xmu.edu.cn`），走上面这条最简路径。
- 其他分支（前端 bundle 里）：`QINIU` 需 `GET /api/uptoken?id={id}` 再 `{upload_url}/mkblk/{size}` + `/mkfile/{size}`；`S3` + `transcoder=WRPC` 用裸 PUT 再 `POST /internal-api/upload/callback/{id}` body `{file_key:id}`。
- `upload_url` 也是按 `timestamp` 签名的，过期后要重新 `POST /api/uploads`。

### 大附件（>几 MB）不要走 base64

`evaluate_script` 的函数体是整串传过去的，30 MB 文件 base64 后约 40 MB，塞不进工具调用。可行做法：本机起一个带 CORS 的 HTTP 服务（`Access-Control-Allow-Origin: *` + `Access-Control-Allow-Private-Network: true`，文件名用 ASCII 短名），页面里 `fetch('http://127.0.0.1:PORT/x.docx').blob()` 再走上面三步上传。https 页面访问 `http://127.0.0.1` 属于 potentially trustworthy origin，不会被混合内容拦。`XMU.uploadFromLocal(localUrl, name, mime)` 已封装；上传时 `name` 传真实中文文件名即可。

单个大文件上传可能超过 `evaluate_script` 的等待时间：把 promise 挂到 `window.__up` 上立即 return `'started'`，之后轮询 `JSON.stringify(window.__up)`。29.9 MB 实测约 40 s。

提交后平台会把富文本正文自动转成一个附件（`Text content(时间戳).pdf`）挂在提交记录里，属正常现象，不是重复上传。

## 探测未使用端点的方法

1. `mcp__browser-use__navigate_page` 打开目标页面，再 `list_network_requests({resourceTypes:["xhr","fetch"]})` —— 最可靠，直接得到真实调用。
2. 读状态码区分端点是否存在：`404`=路径不对，`403`=存在但学生无权限（通常是教师端），`500`=路径对但参数缺失。
3. 挖 bundle 里的路径常量：遍历 `document.querySelectorAll('script[src]')`，`fetch` 下来正则搜 `["'`]/api/...["'`]`。提交/上传等低频功能的代码在**懒加载 chunk** 里，需要先触发对应 UI 才会出现在 `script[src]` 列表中。
4. 抓请求体：在 `evaluate_script` 里包一层 `window.fetch` 与 `XMLHttpRequest.prototype.open/send`，把 method/url/body 记到 `window.__probe.log`，然后**操作真实 UI**。注意 Angular 富文本编辑器对 `innerHTML` 赋值不生效，得用 `fill` 工具或真实输入事件。

## 已知坑

- 单复数前缀混用：`/api/course/...`（点名、成绩、课件）与 `/api/courses/...`（模块、活动、选课）都有，猜错就 404。
- `submission_list` 新→旧排序，取 `[0]` 而不是 `[-1]`。
- `homework-student-status` 两层嵌套 `{aid:{uid:status}}`，且泄露全班同学状态 —— **不要把整表打印给用户或外传**。
- 时间字段是 UTC（`...Z`），页面上显示北京时间，差 8 小时。
- `evaluate_script` 只能返回字符串，且工具会给结果套一层引号 —— 自己 `JSON.stringify` 后直接返回即可，不要期待二次解析。
