# lnt.xmu.edu.cn 纯 HTTP 接入手册（无需浏览器）

把厦大课程中心（内部是 Tronclass LMS）的全部常用操作做成**只用网络请求**就能跑的形态，给没有内置浏览器的 agent 用。
本文自包含：鉴权链路、接口清单、两份可直接抄的实现（bash/curl 与 Node）、踩坑清单。

- 适用：只有 shell / 只有 Node / 只有 Python 的 agent，或需要后台定时跑的场景。
- 不适用：需要渲染前端才能拿到的数据（本文所有接口都是纯 JSON，已覆盖课件、作业、点名、成绩）。
- 与内置浏览器版（`xmu-course` skill）的关系：接口完全一致，只是把"在页面里 fetch"换成"自己完成登录握手 + 带 cookie"。

> ⚠️ 两条硬规矩，任何实现都要遵守：
> 1. **绝不擅自提交作业。** 真正调 `submit()` 前必须向用户复述课程名、作业标题、截止时间、要上传文件的绝对路径、正文，并拿到明确的"确认提交"。提交后不可撤回的风险由你承担。
> 2. **不要把同学的数据往外带。** `homework-student-status` 这类接口返回的是全班状态表，只取自己那一项。

---

## 1. 三分钟上手（只要 curl）

```bash
# 凭据走环境变量，不要写进命令行参数（会留在 shell 历史和进程列表里）
export XMU_USER='2292xxxxxxxxxx'      # 学号
export XMU_PASS='<你的密码>'
bash xmu-curl-login.sh jar.txt        # 产出 Netscape 格式 cookie jar

# 之后所有接口都这么调
curl -s -b jar.txt https://lnt.xmu.edu.cn/api/profile
curl -s -b jar.txt -H 'Content-Type: application/json' -d '{}' https://lnt.xmu.edu.cn/api/my-courses
```

---

## 2. 鉴权：为什么不能"带上 token 就行"

平台会话是 **httpOnly cookie**（`session` + `role_token`，都在 `lnt.xmu.edu.cn`），JS 读不到，命令行也抄不出来。只拿 `role_token` 去 curl 会被 302 打回登录页。所以必须自己走一遍完整的 CAS 单点登录握手。

链路（实测 2026-09）：

```
GET https://lnt.xmu.edu.cn/api/profile            （无 cookie）
 302 → https://c-identity.xmu.edu.cn/auth/realms/xmu/protocol/cas/login
          ?service=https://lnt.xmu.edu.cn/api/profile&kc_idp_hint=cas-client&ts=...
 303 → https://c-identity.xmu.edu.cn/auth/realms/xmu/broker/cas-client/login
          ?session_code=...&client_id=Tronclass&tab_id=...
 303 → https://ids.xmu.edu.cn/authserver/login?service=<URLenc 上面那个 broker endpoint>
          ← 这一步的 HTML 里有登录表单和 pwdEncryptSalt
 POST https://ids.xmu.edu.cn/authserver/login?service=<同一个 service>
          ← 带上加密后的密码；成功则 302 回来并附 ticket=ST-...
 302 → .../broker/cas-client/endpoint?state=...&ticket=ST-...   （Keycloak 校验 CAS ticket）
 302 → https://lnt.xmu.edu.cn/api/profile?ticket=ST-...          （LNT 校验，写自己的 session cookie）
```

要点与坑：

1. **OAuth client 是 `Tronclass`**，`kc_idp_hint=cas-client` 决定了走校内 CAS 而不是 Keycloak 自己的登录页。
2. **`service` 必须出现在 POST 的目标 URL 上。** CAS 登录页 HTML 里 `<form action="/authserver/login">` 是**不带** service 的——是页面 JS（`login.js` 的 `utils.setUrlParam("pwdFromId","?service",...)`）运行时补上去的。少了它，登录成功但换不到 ticket，你会拿到一张重新显示的登录页。最省事的做法：POST 回登录页自己的 URL（它上面本来就带 `service`）。
3. **密码是客户端加密的**，明文提交会被拒。算法见下一节。
4. `lt` 在这台 CAS 上是空字符串，`execution` 一般是 `e1s1`；仍然从页面里解析，别硬编码。
5. **验证码**：先问 `POST https://ids.xmu.edu.cn/authserver/checkNeedCaptcha.htl`（form: `username=...`）→ `{"isNeed":false}`。`isNeed` 为 true 时说明该账号已被要求图形验证码，纯 HTTP 就别硬扛了，让用户在浏览器里登录一次。
6. **别连续试错密码**：统一认证连续失败会锁号。实现里"POST 后没有 Location"就应当停下报错，而不是重试。
7. 会话时效：`session` 与 `role_token` 的 `Expires` 约等于**登录后 24 小时**（实测 `role_token` 解码出的 `exp` 与此一致）。cookie jar 可以跨进程复用，过期后重跑登录即可。

### 2.1 密码加密算法（照抄即可）

来自 `ids.xmu.edu.cn/authserver/qrcodeTheme/static/common/encrypt.js`：

```js
encryptPassword(pwd, salt) = base64( AES-CBC-PKCS7( randomString(64) + pwd ) )
  key = salt（即页面里的 pwdEncryptSalt，16 个 ASCII 字符，UTF-8 当密钥 → AES-128）
  iv  = 另取的随机 16 个 ASCII 字符，UTF-8
  输出：标准 base64，不含 "Salted__" 前缀
```

`iv` 随机且**不上传**看着别扭，但服务端解得开：CBC 模式下 IV 只污染第一个分组，而明文前 64 字节本来就是随机填充、服务端解密后直接丢掉。所以你用任意 IV 都能登录成功——这也是"密文不可预测、无法重放"的设计意图。

`randomString` 原始实现用的字母表是 `ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678`（剔除了易混淆字符），但对正确性无影响，`openssl rand -hex` 产生的字符同样可用。

### 2.2 curl 版一次登录的骨架

```bash
FINAL=$(curl -sSL -c jar -b jar -o page.html -w '%{url_effective}' https://lnt.xmu.edu.cn/api/profile)
SALT=$(grep -oE 'id="pwdEncryptSalt"[^>]*value="[^"]+"' page.html | sed -E 's/.*value="([^"]+)".*/\1/')
KEYHEX=$(printf '%s' "$SALT" | od -An -v -tx1 | tr -d ' \n')
IVHEX=$(printf '%s' "$(openssl rand -hex 8)" | od -An -v -tx1 | tr -d ' \n')
ENC=$(printf '%s%s' "$(openssl rand -hex 32)" "$XMU_PASS" \
     | openssl enc -aes-128-cbc -K "$KEYHEX" -iv "$IVHEX" -nosalt | openssl base64 -A)
curl -sSL -c jar -b jar -e "$FINAL" -o after.html \
  --data-urlencode "username=$XMU_USER" --data-urlencode "password=$ENC" \
  --data-urlencode "lt=" --data-urlencode "execution=e1s1" \
  --data-urlencode "_eventId=submit" --data-urlencode "dllt=generalLogin" \
  --data-urlencode "cllt=userNameLogin" --data-urlencode "rmShown=1" \
  "$FINAL"
curl -s -b jar https://lnt.xmu.edu.cn/api/profile   # 200 且以 { 开头即成功
```

完整可用版本见同目录 `xmu-curl-login.sh`（已实测跑通）。

---

## 3. 接口清单（全部实测）

约定：
- 基址 `https://lnt.xmu.edu.cn`
- 除 `/api/uploads/{id}/url` 返回的直链外，都需要带会话 cookie
- **所有时间字段是 UTC（结尾 `Z`）**，北京时间 +8。例：截止 `2026-09-27T15:59:00Z` = 9-27 23:59 北京
- `uid` = 自己的用户 id，从 `/api/profile` 的 `id` 拿（不要写死）

### 3.1 身份 / 学期 / 课程 / 待办

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/profile` | 自己的 `id`/`user_no`/`name`/院系/组织 |
| GET | `/api/my-semesters` | `semesters[].{id,name,is_active}` |
| POST | `/api/my-courses` | body `{}` 全部；`{"conditions":{"semester_ids":[35]}}` 按学期。返回 `courses[].{id,name,course_code,instructors,semester}` |
| GET | `/api/todos` | 待办/未交作业：`todo_list[].{id,title,type,end_time,course_id,course_name,is_locked}` |
| GET | `/api/courses/{cid}/modules` | 章节：`modules[].{id,name,syllabuses[]}` |

### 3.2 课件：列表 → 换直链 → 下载

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/course/{cid}/coursewares?page=1&page_size=200` | `activities[].{id,title,type,uploads[].{id,name,size,allow_download,origin_allow_download}}` |
| GET | `/api/uploads/{id}/url` | 返回 `{url}`，指向 `c-media.xmu.edu.cn` 的签名直链 |
| GET | `/api/uploads/{id}/url?preview=true` | 预览用的链 —— 与不带参数的**返回同一条直链**，这就是"禁止下载也能拿到"的入口 |
| GET | `/api/uploads/{id}/text?preview=true` | 文本类附件正文 |
| GET | `/api/uploads/{id}/pdf-info?preview=true` | PDF 页数（并非所有文件都支持，见过 400） |

```
GET /api/uploads/9000001/url
 → {"url":"https://c-media.xmu.edu.cn/download/file/<40位hash>?timestamp=...&token=...&name=<URLenc文件名>"}
```
直链**不需要任何 cookie**，`curl -sL -o file "<url>"` 即可，实测字节数与 `uploads[].size` 一致；支持 `Range`（返回 206），mp4 也能分段取。
签名参数是 `token` + `timestamp`（不是 `sign`），`name` 就是真实文件名。`timestamp` 按天滚动 —— **先换链再立刻下**，别缓存 URL。

**教师"禁止下载"（`allow_download: false`）拦不住这个**：该开关只把网页上的下载按钮藏掉，而预览用的就是同一个 `/api/uploads/{id}/url`（`?preview=true` 返回的是**同一条链**），服务端不会因为这个标志拒绝发直链。标志来自活动层配置，`/api/uploads/{id}` 的元数据里压根没有这道闸门。

2026-09-29 实测：当前学期 6 门课的课件里 235 个可下载 / 122 个被禁；抽样被禁文件（跨三门课）都能拿到完整字节 —— `%PDF-1.7` 头、`%%EOF` 尾、长度与 `uploads[].size` 一致，`Range` 返回 206。

⚠️ **用法约束（别跳过）**：这等于绕过任课教师"只许在线看"的意愿，用之前想清楚：
- 只用在自己**已选修、本来就能在线预览**的课程材料上，目的是离线复习。
- 别碰答案类文件（命名里带 `Submission`/`答案`/`score` 的、或教师明说"不下发"的）—— 教师故意不给的东西通常有理由。
- 不要外传（群、网盘、公开站点）。批量拉取按需、限量，不要把整门课几百个文件一次拖下来。

### 3.3 点名

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/course/{cid}/student/{uid}/rollcalls?page=1&page_size=200` | 历史点名：`rollcalls[].{rollcall_time,title,status,student_status,scored}` |
| GET | `/api/course/{cid}/rollcall-score` | 该课点名得分 |
| GET | `/api/course/{cid}/rollcall/setting` | 点名规则/占比配置 |

`student_status` 常见值 `on_call`（到）；`status` 是教师侧标记，如 `on_call_fine`。

### 3.4 作业：列表、要求、我的提交、得分

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/course/{cid}/homework-scores?fields=id,title,data,end_time,start_time,score_percentage,is_in_progress,module_id` | `homework_activities[]`，含 `data.homework_type`、`data.description`（HTML） |
| GET | `/api/course/{cid}/homework-student-status` | ⚠️ **全班**数据，结构 `{活动id:{用户id:状态}}` 两层嵌套，只取自己的 |
| GET | `/api/activities/{aid}?sub_course_id=0` | 单个作业完整定义：`data.description`、`data.allow_retract`、`data.score_rule` |
| GET | `/api/activities/{aid}/students/{uid}/submission_list` | 我的历次提交。⚠️ **服务端按新→旧返回，`list[0]` 是最新一条** |
| GET | `/api/activities/{aid}/students/{uid}/homework-score` | 该次作业得分与评语 |
| GET | `/api/course/{cid}/score` | 成绩构成（键含 `total_score`、`roles`、`bonus`、`published`） |

`submission_list[].{id,is_draft,submitted_at,final_score,score,comment,uploads[].{id,name}}`。
状态值见过：`un_submitted`、`un_marked`（已交未批）、以及已批改标记。

### 3.5 写操作：上传附件 → 保存草稿 → 提交

**上传（三步）**

| 步 | 方法 | 说明 |
|---|---|---|
| 1 | `POST /api/uploads` | body `{"name":"报告.docx","size":<字节数>,"type":"application/vnd.openxmlformats-offwordprocessingml.document"}` → 返回 `{id, upload_url}` |
| 2 | `PUT <upload_url>` | `multipart/form-data`，字段名固定 `file`。**不需要会话 cookie** |
| 3 | `PUT /api/uploads/{id}/uploaded` | 通知平台落库，之后 `id` 才能出现在提交里 |

**提交**

`POST /api/course/activities/{aid}/submissions`

```json
{
  "comment": "正文（纯文本即可）",
  "uploads": ["9000004"],
  "slides": [],
  "is_draft": false,
  "mode": "normal",
  "other_resources": [],
  "uploads_in_rich_text": []
}
```

`is_draft: true` 存草稿（可随时覆盖，安全）；`false` 即正式提交（**先拿用户确认**）。

⚠️ `uploads` 必须是**字符串 id 数组**：传数字 `[9000004]` 会被服务端**静默丢弃**（返回 200 但附件没进去），传对象直接 500。这是最容易踩的坑。

### 3.6 测试（exam）：列表、我的提交、答卷回顾

Web 路由：详情 `/course/{cid}/learning-activity#/exam/{eid}`，回顾 `/exam/{eid}/subjects#/submission/{sid}`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/courses/{cid}/exam-list?page=1&page_size=50` | `exams[].{id,title,start_time,end_time,score,final_score,submit_times,subjects_count,is_closed,announce_answer_status,announce_answer_type,is_announce_answer_time_passed}` |
| GET | `/api/courses/{cid}/exam-submissions` | 我的提交 `{"{eid}":[{id,score}]}`，没交过是 `[]` |
| GET | `/api/exams/{eid}` | 测试元数据（学生可读） |
| GET | `/api/exam/{eid}/check-exam-qualification?no-intercept=true` | 防作弊配置（`enable_anti_cheat`、`disable_copy_paste`、`is_fullscreen_mode`…）；注意前缀单数 `/api/exam/` |
| GET | `/api/exam/{eid}/subject-groups` | 试卷分组 `data[].{id,name,sort,subject_type}` |
| GET | `/api/exams/{eid}/submissions` | 我在该测试的提交：`{exam_score, exam_score_rule, submissions[].{id,score,submitted_at,submit_method_text}}` |
| GET | `/api/exams/{eid}/submissions/{sid}` | **答卷回顾**（页面「查看」就是它），只含本人作答 |
| GET | `/api/exams/{eid}/subjects-summary?for_submissions=true&submission_ids={sid}` | 逐题 `{id,type,point,has_audio}`，整卷一次返回 |
| GET | `/api/submissions/{sid}/submission_marked_attachments` | 答卷附件 |
| GET | `/api/exams/{eid}/subjects` | 整卷题目/题库 —— 学生一律 **403「您没有权限完成此操作」**，答案公布与否都一样 |

回顾返回的关键容器（都是 snake_case，别猜）：

```
subjects_data.subjects[]        {id,sort,type,description(题干 HTML),options[]{id,content,is_answer},point,answer_explanation,wrong_explanation,sub_subjects}
submission_data.subjects[]      {subject_id, answer, answer_option_ids[]}
correct_answers_data.correct_answers[] {subject_id,content,answer_option_ids[],point,type}
correct_data{subject_id: true|false}   submission_score_data{subject_id: "0.5"}
score, auto_mark, submit_method_text, submitted_at
```

题干/选项是 HTML，落文本前去掉标签。`options[].is_answer` 与 `correct_answers_data` 仅在教师设置公布答案时出现。

⚠️ 与课件的"禁止下载"**不一样**：测试的题目与答案是**服务端鉴权**。`/api/exams/{eid}/subjects` 学生拿不到；答卷里的参考答案也只在答案已公布时才下发。用法限定成一条：**导出本人答过、且答案已公布的测试做复盘**（导出前先看 `exam-list` 的 `announce_answer_status` / `is_announce_answer_time_passed`）。答案未公布的测试不要拿这条链去试探能否绕过 —— 那是考核诚信，不是平台漏洞；导出的答卷也不要外传。

### 3.7 公告 / 通知

课程 Web 路由 `/course/{cid}/bulletin`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/courses/{cid}/bulletins?conditions={"start_date":"","end_date":"","keyword":""}` | **课程公告**，`conditions` 需 URL 编码 → `{bulletins:[...]}` |
| GET | `/api/courses/{cid}/bulletins/{bid}` | 单条公告 |
| GET | `/api/announcement` | 平台公告（平时为空） |
| GET | `/ntf/users/{uid}/notifications?limit=N&additionalFields=unread_count` | 站内通知，**前缀 `/ntf`**；`timestamp` 是毫秒 |

公告条目：`{id, title, content(HTML), created_at, created_by{id,name}, targets, targets_name, send_type, uploads[], start_time, end_time}`。
`uploads[]` 是标准附件对象（同 3.2），`id` 可直接换签名直链下载；正文里内嵌图片写成 `/api/uploads/{id}/in-rich-content?...`，那个 `id` 同样能换链（教师常把作业模板、二维码只放在公告里）。
`conditions` 中只有 `keyword`（按标题）实测生效，`start_date/end_date` 不起作用；`/api/bulletins/latest?latest_only=true` 存在但返回空，别用。

通知 `payload` 依 `type` 而变：`activity_opened`（新课件/活动，含 `activity_id/course_id/course_name/uploads[].{id,file_name,file_size}`）、`homework_opened_for_submission`、`homework_score_updated`（批改结果）、`homework_expiring`、`homework_expiring_today`、`activity_expiring`。要"最近有什么新东西"，这条比遍历所有课程快。

⚠️ 公告/通知正文里可能带同学姓名、群号、教师邮箱。不要把原文丢进仓库、日志或任何会对外发布的东西里。

---

## 4. 参考实现

同目录两个文件都已对真实账号跑通（读操作 + 下载 + 登录）；凭据一律从环境变量或文件读取，**不出现在命令行参数里**，也不写进代码：

- `xmu-curl-login.sh` — 纯 bash + curl + openssl 的登录，产出 Netscape jar。
- `xmu-http.mjs` — Node ≥18 零依赖客户端，`login/api/XMU` 三个导出 + CLI。
  ```bash
  node xmu-http.mjs login --creds ./creds.md     # creds.md 里有「用户名：`...`」「密码：`...`」两行
  node xmu-http.mjs coursewares 120002
  node xmu-http.mjs download ./out 9000001 9000003
  node xmu-http.mjs homeworks 120002
  node xmu-http.mjs rollcalls 120002
  node xmu-http.mjs exams 120005                      # 课程下的测试 + 我的分
  node xmu-http.mjs exam-subs 30001                  # 我在该测试的提交
  node xmu-http.mjs exam-review 30001 --out 复盘.md   # 导出本人答卷（答案已公布才有参考答案）
  node xmu-http.mjs bulletins 120008 组队              # 课程公告（第二个参数是标题关键词）
  node xmu-http.mjs bulletin 120008 50001               # 单条公告
  node xmu-http.mjs notifications 30                  # 站内通知 + 未读数
  node xmu-http.mjs raw GET /api/todos
  ```
  当库用：
  ```js
  import { XMU, login, api } from './xmu-http.mjs';   // 自动复用 ./xmu-cookies.json
  const cs = await XMU.courses();
  const dl = await XMU.download('./out', await XMU.urls([9000001]));
  ```

用其他语言重写时，只需要实现四件事：跨域 cookie jar、手动跟随重定向、AES-128-CBC 密码加密、JSON POST。

**这份 md 本身是自包含的**：照 §1/§2 用 curl 就能落地，两个脚本只是参考实现，可以不带。
要发布/开源时，`xmu-cookies.json`（有效会话）和任何写明凭据的文件都别留在仓库里 —— 放到家目录（例如 `~/.qoder-cn/xmu-local/`），用 `XMU_JAR` 指过去：

```bash
export XMU_JAR="$HOME/.qoder-cn/xmu-local/xmu-cookies.json"
export XMU_USER=... XMU_PASS=...    # 或直接 --creds 指向仓库外的文件；别把凭据写进命令行历史
```

---

## 5. 已知坑汇总

| 现象 | 原因 / 处置 |
|---|---|
| POST 登录后拿回一张登录页 | `service` 没带在 POST URL 上（见 2.2 第 2 条） |
| 登录 200 但接口全 302 | 302 到 `c-identity` 就是没登录；确认 cookie jar 里 `lnt.xmu.edu.cn` 的 `session` 在 |
| 提交后附件消失 | `uploads` 传了数字而非字符串 |
| 读到的"最新提交"是很旧的一条 | `submission_list` 新→旧，取 `[0]` |
| 测试列表有分但看不到题目 | `/api/exams/{eid}/subjects` 对学生 403 是**服务端鉴权**（不是前端开关，别照着课件那招去试）；能读的只有本人答卷 `/api/exams/{eid}/submissions/{sid}`，且参考答案要教师公布 |
| `raw GET /api/xxx` 报 `getaddrinfo ENOTFOUND` 或域名尾巴多个 c | Git Bash（MSYS）把 `/api/...` 这类裸斜杠参数换成了 `C:/Program Files/Git/api/...`。加前缀 `MSYS_NO_PATHCONV=1` 即可，或改用已封装的子命令 |
| 接口全 302 但你确定登录过 | cookie jar 格式不对：`curl -c` 用的是 Netscape 格式，`xmu-http.mjs` 用的是自己的 JSON；两者不通用，用 `XMU_JAR` 各指各的路径 |
| 描述里出现 `&nbsp;` | `data.description` 是 HTML，需去标签 + 解实体 |
| 时间差 8 小时 | 全部 UTC，展示时 +8 |
| 看到 `downloadable:false` 就跳过某个附件 | 那只是网页上没有下载按钮，`urls()` 照样给出可用直链（见 3.2）。要不要拿是另一回事，但别误判成"拿不到" |
| 下载 403 | 直链过期（`token`/`timestamp` 按天滚动），重新换链即可。注意：**不是**因为教师关了下载 |
| 路径 404 | 前缀单复数不统一：课程级是 `/api/course/{cid}/...`，模块级是 `/api/courses/{cid}/...` |
| 接口探查 | 404=路径不存在；403=权限不足；500=路径对但参数/body 形状错，可以据此判断字段名 |
| 图形验证码 | `checkNeedCaptcha.htl` 返回 `isNeed:true`，交给用户在浏览器登录 |

**未覆盖**：测试/讨论/问卷/直播/分组/笔记/学习分析这几个模块只摸清了入口，用到时再补进本文档。
草稿没有删除接口（试过 4 种 DELETE 路径 × 多个 id，全部 404），存错的草稿只能覆盖或留着。
