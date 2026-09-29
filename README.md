# xmu-course

厦门大学课程中心（[lnt.xmu.edu.cn](https://lnt.xmu.edu.cn)）的 agent skill：用接口而不是点 UI 来查课件、下作业、看点名、查成绩、复盘测试、读公告。

平台的会话是 httpOnly cookie，所以这套东西有两条路：

- **有内置浏览器**（Qoder / Claude 一类带 browser MCP 的 agent）→ 注入 `scripts/xmu.js`，直接复用已登录会话。
- **只有网络请求**（headless agent、CI、脚本）→ `scripts/xmu-http.mjs` 或 `scripts/xmu-curl-login.sh` 自己走完 CAS 登录握手拿 cookie。

两条路暴露的方法名一一对应，`references/http-login.md` 是后者接入时唯一需要读的文档（它自包含：握手细节 + 密码加密算法 + 可复制的实现）。

## 能做什么

| 领域 | 方法 |
|---|---|
| 身份 / 学期 / 课程 / 待办 | `me` `semesters` `courses` `todos` |
| 章节与课件 | `modules` `coursewares` `urls`（签名直链） |
| 点名与成绩 | `rollcalls` `rollcallScore` `homeworks` `homeworkScore` `submissions` |
| 测试复盘 | `exams` `myExamSubmissions` `examPaper` `examReviewMd` |
| 公告与通知 | `bulletins` `announcements` `notifications` |
| 作业提交 | `upload` `saveDraft` `submit`（**带强制人工确认闸门**） |
| 未封装端点 | `raw(path, opts)` |

## 安装

clone 到 Qoder 的 skills 目录（其他 agent 直接把整个目录当知识包喂进去也行）：

```bash
git clone https://github.com/CDX0721/xmu-course.git "$HOME/.qoder-cn/skills/xmu-course"
```

Windows 下路径形如 `C:\Users\<你>\.qoder-cn\skills\xmu-course`。

## 快速上手（无浏览器）

```bash
cd ~/.qoder-cn/skills/xmu-course/scripts

# 凭据只走环境变量或仓库外的本地文件，不要写进命令行参数历史记录
export XMU_USER='<你的学号>'
export XMU_PASS='<你的密码>'
node xmu-http.mjs login

export XMU_JAR="$HOME/.qoder-cn/xmu-local/xmu-cookies.json"   # 把会话放到仓库外
node xmu-http.mjs courses
node xmu-http.mjs coursewares 120001
node xmu-http.mjs fetch-urls 120001 --dir ./courseware
node xmu-http.mjs bulletins 120008
node xmu-http.mjs notifications
```

文档与示例里出现的 `120001` / `30001` / `9000001` / `{uid}` 都是**占位符**，不是真实 id。运行时用 `GET /api/profile` 现取自己的 uid，用 `courses()` 现取课程 id。

## 边界（重要）

这个项目只是把"我本来就能在网页上做的事"做成可批量调用的接口。它刻意不做以下事情：

- **不绕过测试答案的服务端权限。** `/api/exams/{eid}/subjects` 对学生一律 403，答案未公布时就是拿不到，别试。复盘只限本人答过、且教师已公布答案的测试 —— 这是考核诚信。
- **不擅自提交作业。** `submit()` 前必须人工确认课程、作业、截止时间与文件路径；误交不可逆。
- **不抓取或转存答案、评分标准类文件。**
- **不外传同班数据。** 部分接口返回全班状态，只取自己那一项。
- 课件的"禁止下载"是前端开关、服务端不校验，因此能拿到 —— 这是平台侧的实现问题。请只用在自己已选修、本来就能在线预览的材料上做离线复习，尊重任课教师的分发意愿，不要二次传播。

## 免责声明

非官方项目，与厦门大学、任课教师或平台服务商无关。接口随时可能变，账号行为责任自负；请遵守学校与平台的网络使用规定，不要把本工具用于爬取他人数据或干扰平台。

## License

MIT — 见 [LICENSE](LICENSE)。
