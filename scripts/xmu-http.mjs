// xmu-http.mjs —— lnt.xmu.edu.cn 纯 HTTP 客户端（无需浏览器）
// 登录 + 课件/作业/点名/成绩查询 + 文件下载。零依赖，Node >= 18。
//
//   node xmu-http.mjs login  --creds ./creds.md
//   node xmu-http.mjs courses
//   node xmu-http.mjs coursewares <courseId>
//   node xmu-http.mjs fetch-urls  <uploadId> [...]      # 换签名直链
//   node xmu-http.mjs download   <outDir> <uploadId> [...]
//   node xmu-http.mjs homeworks  <courseId>
//   node xmu-http.mjs rollcalls  <courseId>
//   node xmu-http.mjs raw        <METHOD> <path> [jsonBody]

import { createCipheriv, randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const LNT = 'https://lnt.xmu.edu.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const JAR = process.env.XMU_JAR || 'xmu-cookies.json';

// ================= cookie jar =================
const jars = new Map();

function storeCookies(host, list) {
  for (const raw of list) {
    const [pair, ...attrs] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    let path = '/', domain = host, expired = false;
    for (const a of attrs) {
      const [k, ...v] = a.split('=');
      const key = k.trim().toLowerCase(), val = v.join('=').trim();
      if (key === 'path' && val) path = val;
      else if (key === 'domain' && val) domain = val.replace(/^\./, '');
      else if (key === 'max-age' && parseInt(val, 10) <= 0) expired = true;
      else if (key === 'expires' && Date.parse(val) < Date.now()) expired = true;
    }
    const id = `${domain}|${path}|${name}`;
    if (expired) jars.delete(id);
    else jars.set(id, { name, value, domain, path });
  }
}

function cookieHeader(host, path) {
  const out = [];
  for (const c of jars.values()) {
    const hostOk = host === c.domain || host.endsWith('.' + c.domain);
    const base = c.path.endsWith('/') ? c.path : c.path + '/';
    const pathOk = path === c.path || path.startsWith(base);
    if (hostOk && pathOk) out.push(`${c.name}=${c.value}`);
  }
  return out.join('; ');
}

function saveJar(file) {
  writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), cookies: [...jars.values()] }, null, 2));
}

function loadJar(file) {
  if (!existsSync(file)) return false;
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    for (const c of d.cookies || []) jars.set(`${c.domain}|${c.path}|${c.name}`, c);
    return !!([...jars.values()].find((c) => c.name === 'session' && /lnt\.xmu/.test(c.domain)));
  } catch {
    return false;
  }
}

// ================= 底层请求 =================
async function hop(url, opts = {}) {
  const u = new URL(url);
  const headers = { 'User-Agent': UA, Accept: '*/*', ...(opts.headers || {}) };
  const ck = cookieHeader(u.hostname, u.pathname);
  if (ck) headers.cookie = ck;
  const r = await fetch(url, { method: opts.method || 'GET', headers, body: opts.body, redirect: 'manual' });
  storeCookies(u.hostname, typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []);
  return r;
}

async function walk(url, maxHops = 12) {
  for (let i = 0; i < maxHops; i++) {
    const r = await hop(url);
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) {
      url = new URL(loc, url).href;
      continue;
    }
    return { r, url };
  }
  throw new Error('重定向次数过多');
}

// GET/POST 到 LNT 的 JSON 接口；未登录时自动重新登录一次
export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const url = path.startsWith('http') ? path : LNT + path;
  let r = await hop(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401 || (r.status >= 300 && r.status < 400 && /c-identity/.test(r.headers.get('location') || ''))) {
    if (!process.env.XMU_USER) throw new Error('会话过期，请先跑 login 子命令（或设置 XMU_USER/XMU_PASS）');
    await login({ user: process.env.XMU_USER, pass: process.env.XMU_PASS });
    saveJar(JAR);
    r = await hop(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const txt = await r.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = txt; }
  if (r.status >= 400) throw new Error(`${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return raw ? { status: r.status, data } : data;
}

// ================= CAS 登录 =================
const ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

function randomStr(n) {
  const b = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

// AES-128-CBC/Pkcs7，key=pwdEncryptSalt(16字符UTF-8)，iv=随机16字符UTF-8，
// 明文=随机64字符+密码，结果标准 base64。IV 不上传没关系：CBC 只污染第一个分组，
// 而前 64 字节本就是服务端要丢掉的随机前缀。
function encryptPassword(password, salt) {
  const key = Buffer.from(salt.trim(), 'utf8');
  const iv = Buffer.from(randomStr(16), 'utf8');
  const cipher = createCipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  return Buffer.concat([cipher.update(randomStr(64) + password, 'utf8'), cipher.final()]).toString('base64');
}

export async function login({ user, pass, debug = false }) {
  // 1) 未登录打 API -> 302 经 Keycloak(c-identity) 的 CAS 协议端点 -> broker 到 ids.xmu.edu.cn
  const entry = await walk(`${LNT}/api/profile`, 6);
  if (!/ids\.xmu\.edu\.cn/.test(entry.url)) return { alreadyLoggedIn: true, me: await api('/api/profile') };

  const casUrl = new URL(entry.url);
  const svc = casUrl.searchParams.get('service');
  if (!svc) throw new Error('登录页 URL 缺 service 参数: ' + entry.url);

  // 2) 取登录页，解析加密盐与流程令牌
  const html = await (await hop(casUrl.href)).text();
  const salt = (html.match(/id="pwdEncryptSalt"\s+value="([^"]+)"/i) || [])[1];
  if (!salt) throw new Error('没找到 pwdEncryptSalt，登录页结构可能变了');
  const execution = (html.match(/name="execution"[^>]*value="([^"]*)"/i) || [])[1] || 'e1s1';
  const lt = (html.match(/name="lt"[^>]*value="([^"]*)"/i) || [])[1] || '';

  // 3) 表单 action 必须由 JS 补上 ?service=，HTML 里没有；漏了就换不到 ticket
  const formAction = `${casUrl.origin}/authserver/login?service=${encodeURIComponent(svc)}`;
  const body = new URLSearchParams({
    username: user, password: encryptPassword(pass, salt),
    lt, execution, _eventId: 'submit', dllt: 'generalLogin', cllt: 'userNameLogin', rmShown: '1',
  });
  const post = await hop(formAction, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: casUrl.href, Origin: casUrl.origin },
    body,
  });
  const ticketLoc = post.headers.get('location');
  if (debug) console.error('[debug] CAS POST', post.status, ticketLoc);
  if (!ticketLoc) {
    const b = await post.text();
    const msg = (b.match(/id="msg"[^>]*>\s*([^<]+)|class="tips"[^>]*>\s*([^<]+)|<p class="blackTheme">([^<]+)/i) || []).slice(1).find(Boolean);
    throw new Error('CAS 未发 ticket。' + (msg ? '服务端提示: ' + msg.trim() : b.replace(/\s+/g, ' ').slice(0, 300)));
  }

  // 4) 沿 ticket 回跳：broker endpoint -> Keycloak -> LNT（LNT 校验后写自己的 session cookie）
  const done = await walk(new URL(ticketLoc, formAction).href, 12);
  return { ok: true, landedOn: done.url, me: await api('/api/profile') };
}

// ================= 业务方法 =================
// 作为库引入时自动复用磁盘上的会话
loadJar(JAR);

const strip = (html) => String(html || '')  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ').trim();

export const XMU = {
  me: () => api('/api/profile').then((u) => ({ id: u.id, user_no: u.user_no, name: u.name })),

  semesters: () => api('/api/my-semesters').then((r) => r.semesters.map((s) => ({ id: s.id, name: s.name, active: s.is_active }))),

  courses: (semesterId) => api('/api/my-courses', { method: 'POST', body: semesterId ? { conditions: { semester_ids: [semesterId] } } : {} })
    .then((r) => r.courses.map((c) => ({
      id: c.id, name: c.name, code: c.course_code,
      teacher: c.instructors && c.instructors[0] && c.instructors[0].name,
      semester: c.semester && c.semester.id,
    }))),

  todos: () => api('/api/todos').then((r) => (r.todo_list || []).map((t) => ({
    activityId: t.id, course_id: t.course_id, course: t.course_name, title: t.title, type: t.type, due: t.end_time, locked: t.is_locked,
  }))),

  modules: (cid) => api(`/api/courses/${cid}/modules`).then((r) => r.modules.map((m) => ({
    id: m.id, name: m.name, syllabuses: (m.syllabuses || []).map((s) => ({ id: s.id, summary: s.summary })),
  }))),

  coursewares: (cid) => api(`/api/course/${cid}/coursewares?page=1&page_size=200`).then((r) => (r.activities || []).map((a) => ({
    id: a.id, title: a.title, type: a.type,
    uploads: (a.uploads || []).map((u) => ({
      uploadId: u.id, name: u.name, size: u.size,
      // 只是前端有没有下载按钮；服务端不认这个标志，false 时 urls() 照样给出可用直链。
      // 别据此判定"下不了"，也别无差别批量抓整门课（用法约束见 references/api.md）。
      downloadable: u.allow_download !== false && u.origin_allow_download !== false,
    })),
  }))),

  // 签名直链：走 c-media.xmu.edu.cn，不需要任何 cookie，可直接 GET 落盘
  urls: async (uploadIds) => {
    const out = [];
    for (const id of uploadIds) {
      const d = await api(`/api/uploads/${id}/url`);
      const raw = (d.url.match(/[?&]name=([^&]*)/) || [])[1];
      out.push({ uploadId: id, name: raw ? decodeURIComponent(raw) : String(id), url: d.url });
    }
    return out;
  },

  download: async (dir, entries) => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const results = [];
    for (const e of entries) {
      const safe = e.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
      const dest = join(dir, safe);
      try {
        const r = await fetch(e.url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
        const n = r.headers.get('content-length');
        results.push({ ok: true, name: safe, path: dest, bytes: (await import('node:fs')).statSync(dest).size, declared: n });
      } catch (err) {
        results.push({ ok: false, name: safe, error: String(err.message || err) });
      }
    }
    return results;
  },

  rollcalls: async (cid, uid) => {
    const u = uid || (await XMU.me()).id;
    const r = await api(`/api/course/${cid}/student/${u}/rollcalls?page=1&page_size=200`);
    return (r.rollcalls || []).map((x) => ({ time: x.rollcall_time, title: x.title, status: x.status, studentStatus: x.student_status, scored: x.scored }));
  },

  rollcallScore: (cid) => api(`/api/course/${cid}/rollcall-score`),
  rollcallSetting: (cid) => api(`/api/course/${cid}/rollcall/setting`),

  homeworks: async (cid) => {
    const fields = 'id,title,data,end_time,start_time,score_percentage,is_in_progress,module_id';
    const [hw, st] = await Promise.all([
      api(`/api/course/${cid}/homework-scores?fields=${fields}`),
      api(`/api/course/${cid}/homework-student-status`),
    ]);
    const u = String((await XMU.me()).id);
    return (hw.homework_activities || []).map((a) => {
      const perActivity = st[String(a.id)] || {};          // 两层嵌套 {活动id:{用户id:状态}}
      return {
        activityId: a.id, title: a.title, due: a.end_time, scorePct: a.score_percentage,
        open: a.is_in_progress, form: a.data && a.data.homework_type,
        myStatus: perActivity[u] || 'unknown',              // 只取自己那项，别整表打印
        desc: strip(a.data && a.data.description),
      };
    });
  },

  activity: (aid) => api(`/api/activities/${aid}?sub_course_id=0`).then((a) => ({
    id: a.id, course_id: a.course_id, title: a.title, due: a.end_time, published: a.published,
    type: a.type, form: a.data && a.data.homework_type, desc: strip(a.data && a.data.description),
    allowRetract: a.data && a.data.allow_retract, scoreRule: a.data && a.data.score_rule,
  })),

  submissions: async (aid) => {
    const u = (await XMU.me()).id;
    const r = await api(`/api/activities/${aid}/students/${u}/submission_list`);
    return (r.list || []).map((s) => ({
      id: s.id, isDraft: s.is_draft, submittedAt: s.submitted_at,
      score: s.final_score || s.score, comment: strip(s.comment).slice(0, 200),
      uploads: (s.uploads || []).map((x) => x.id + ':' + x.name),
    }));
  },

  homeworkScore: async (aid) => {
    const u = (await XMU.me()).id;
    return api(`/api/activities/${aid}/students/${u}/homework-score`);
  },

  scoreComposition: (cid) => api(`/api/course/${cid}/score`),

  // ---------------- 测试（exam）----------------
  // 学生能列到的只有「自己上过的测试」：题目正文与参考答案只在教师公布答案时随答卷下发。
  // 整卷题库 /api/exams/{eid}/subjects 对学生恒为 403（服务端鉴权，不是前端开关）—— 不要绕。
  exams: (cid) => api(`/api/courses/${cid}/exam-list?page=1&page_size=50`).then((r) => (r.exams || []).map((e) => ({
    id: e.id, title: e.title, start: e.start_time, end: e.end_time,
    myScore: e.score, finalScore: e.final_score, submitted: e.submit_times,
    subjectsCount: e.subjects_count, closed: e.is_closed,
    answerAnnounced: e.announce_answer_status === 'immediate_announce' || e.is_announce_answer_time_passed === true,
    answerType: e.announce_answer_type,
  }))),

  exam: (eid) => api(`/api/exams/${eid}`).then((e) => ({
    id: e.id, title: e.title, subjectsCount: e.subjects_count, submitTimes: e.submit_times,
    scoreRule: e.score_rule, scoreType: e.score_type, scorePercentage: e.score_percentage,
    announceAnswerStatus: e.announce_answer_status, announceAnswerType: e.announce_answer_type,
    announceScoreStatus: e.announce_score_status,
  })),

  myExamSubmissions: (eid) => api(`/api/exams/${eid}/submissions`)
    .then((r) => (r.submissions || []).map((s) => ({ id: s.id, submittedAt: s.submitted_at, score: s.score, method: s.submit_method_text }))),

  // = 页面上「查看」按钮打的那条请求，只含本人答卷
  examPaper: async (eid, sid) => {
    const r = await api(`/api/exams/${eid}/submissions/${sid}`);
    const mine = Object.fromEntries((r.submission_data && r.submission_data.subjects || []).map((s) => [String(s.subject_id), s]));
    const ref = Object.fromEntries((r.correct_answers_data && r.correct_answers_data.correct_answers || []).map((c) => [String(c.subject_id), c]));
    const subjects = ((r.subjects_data && r.subjects_data.subjects) || []).map((q) => {
      const key = String(q.id);
      const text = (ids) => (ids || []).map((id) => strip((q.options || []).find((o) => o.id === id) && (q.options || []).find((o) => o.id === id).content))
        .filter(Boolean).join('、');
      const my = mine[key] || {};
      const cr = ref[key];
      return {
        sort: q.sort, type: q.type, point: q.point,
        earned: r.submission_score_data ? r.submission_score_data[key] : undefined,
        correct: r.correct_data ? r.correct_data[key] : undefined,
        question: strip(q.description),
        options: (q.options || []).map((o) => ({ id: o.id, text: strip(o.content), answer: o.is_answer === true })),
        myAnswer: my.answer ? strip(my.answer) : text(my.answer_option_ids),
        refAnswer: cr ? (cr.content ? strip(cr.content) : text(cr.answer_option_ids)) : (q.options || []).filter((o) => o.is_answer).map((o) => strip(o.content)).join('、'),
        explanation: strip(q.answer_explanation) || strip(q.wrong_explanation) || '',
      };
    });
    return { examId: Number(eid), submissionId: Number(sid), score: r.score, submittedAt: r.submitted_at, method: r.submit_method_text, autoMark: r.auto_mark, subjects };
  },

  examReviewMd: async (eid, sid) => {
    const p = await XMU.examPaper(eid, sid);
    const lines = [`# 测试回顾：exam ${p.examId} / 提交 ${p.submissionId}`,
      `- 得分 ${p.score}｜交卷 ${p.submittedAt}｜${p.method}`, ''];
    p.subjects.forEach((q, i) => {
      lines.push(`## ${i + 1}. ${q.question}`,
        ...q.options.map((o) => `- [${o.answer ? 'x' : ' '}] ${o.text}`),
        `- 我的作答：${q.myAnswer || '(未作答)'}`,
        `- 参考答案：${q.refAnswer}`,
        `- 判定：${q.correct === true ? '正确' : q.correct === false ? '错误' : '未判'}｜得分 ${q.earned ?? '-'}/${q.point}`);
      if (q.explanation) lines.push(`- 解析：${q.explanation}`);
      lines.push('');
    });
    return lines.join('\n');
  },

  // ---------------- 公告 / 通知 ----------------
  // keyword 按标题过滤有效；conditions 里的 start_date/end_date 实测不起作用，别依赖。
  bulletins: (cid, opts = {}) => {
    const c = { start_date: '', end_date: '', keyword: (opts && opts.keyword) || '' };
    return api(`/api/courses/${cid}/bulletins?conditions=${encodeURIComponent(JSON.stringify(c))}`)
      .then((r) => (r.bulletins || []).map((b) => XMU._bulletin(b)));
  },

  bulletin: (cid, bid) => api(`/api/courses/${cid}/bulletins/${bid}`).then((b) => XMU._bulletin(b)),

  _bulletin: (b) => ({
    id: b.id, title: b.title, time: b.created_at, by: b.created_by && b.created_by.name,
    targets: (b.targets_name || []).join('、'), sendType: b.send_type,
    body: strip(b.content),
    // uploads 里就是标准附件对象，id 可直接喂 urls()/download()
    attachments: (b.uploads || []).map((u) => ({
      uploadId: u.id, name: u.name, size: u.size,
      downloadable: u.allow_download !== false && u.origin_allow_download !== false,
    })),
    // 正文里内嵌的图片/文件（二维码之类）走 in-rich-content，同样的 uploadId 能换直链
    inlineUploads: [...String(b.content || '').matchAll(/\/api\/uploads\/(\d+)\/in-rich-content/g)].map((m) => Number(m[1])),
  }),

  // 平台级公告，通常为空
  announcements: () => api('/api/announcement').then((r) => r.announcements || []),

  // 通知中心（前缀是 /ntf，不是 /api）。type 见过 activity_opened / homework_opened_for_submission /
  // homework_score_updated / homework_expiring(_today) / activity_expiring
  notifications: async (limit = 30) => {
    const u = (await XMU.me()).id;
    const r = await api(`/ntf/users/${u}/notifications?limit=${limit}&additionalFields=unread_count`);
    return {
      unread: r.unread_count,
      list: (r.notifications || []).map((n) => ({
        type: n.type, unread: n.unread, top: n.top,
        time: new Date(n.timestamp).toISOString(),
        course: n.payload && n.payload.course_name,
        title: (n.payload && (n.payload.activity_title || n.payload.title || n.payload.homework_title)) || '',
        activityId: n.payload && n.payload.activity_id,
        uploads: ((n.payload && n.payload.uploads) || []).map((x) => `${x.id}:${x.file_name}`),
      })),
    };
  },

  // 本地文件 -> 平台附件：preUpload -> PUT 到签名直链 -> 通知完成
  upload: async (name, buffer, mime = 'application/octet-stream') => {
    const pre = await api('/api/uploads', { method: 'POST', body: { name, size: buffer.length, type: mime } });
    const fd = new FormData();
    fd.append('file', new Blob([buffer], { type: mime }), name);
    const put = await fetch(pre.upload_url, { method: 'PUT', body: fd });
    const putTxt = await put.text();
    if (!put.ok) throw new Error('media PUT ' + put.status + ' ' + putTxt.slice(0, 200));
    await api(`/api/uploads/${pre.id}/uploaded`, { method: 'PUT' });
    return { uploadId: pre.id, name, size: buffer.length };
  },

  // uploads 必须是【字符串 id 数组】：传数字会被静默丢弃，传对象直接 500
  _save: (aid, o, isDraft) => api(`/api/course/activities/${aid}/submissions`, {
    method: 'POST',
    body: {
      comment: o.comment || '', uploads: (o.uploads || []).map(String), slides: [],
      is_draft: isDraft, mode: 'normal', other_resources: [], uploads_in_rich_text: [],
    },
  }),

  saveDraft: (aid, o) => XMU._save(aid, o, true),
  submit: (aid, o) => XMU._save(aid, o, false),   // 调用前必须拿到用户明确"确认提交"
};

// ================= CLI =================
const isMain = process.argv[1] && import.meta.url === new URL('file:///' + process.argv[1].replace(/\\/g, '/')).href;
if (isMain) {
  const [, , cmd, ...rest] = process.argv;
  const flag = (name, dflt) => {
    const i = rest.indexOf('--' + name);
    return i >= 0 ? rest[i + 1] : dflt;
  };
  function fromFile(file) {
    if (!file || !existsSync(file)) return {};
    const t = readFileSync(file, 'utf8');
    const g = (label) => (t.match(new RegExp(label + '[^\n]*?`([^`]+)`')) || [])[1];
    return { user: g('用户名'), pass: g('密码') };
  }

  const print = (x) => console.log(JSON.stringify(x, null, 2));
  loadJar(JAR);

  if (cmd === 'login') {
    const f = fromFile(flag('creds', ''));
    const user = process.env.XMU_USER || f.user;
    const pass = process.env.XMU_PASS || f.pass;
    if (!user || !pass) throw new Error('缺少凭据：--creds 文件或 XMU_USER/XMU_PASS');
    const res = await login({ user, pass, debug: rest.includes('--debug') });
    if (res.alreadyLoggedIn) { console.log('已有有效会话:', JSON.stringify(res.me)); process.exit(0); }
    saveJar(JAR);
    console.log('LOGIN OK', res.me.name, res.me.user_no);
  } else if (cmd === 'courses') {
    print(await XMU.courses(rest[0] ? Number(rest[0]) : undefined));
  } else if (cmd === 'semesters') {
    print(await XMU.semesters());
  } else if (cmd === 'todos') {
    print(await XMU.todos());
  } else if (cmd === 'coursewares') {
    print(await XMU.coursewares(Number(rest[0])));
  } else if (cmd === 'fetch-urls') {
    print(await XMU.urls(rest.filter((x) => /^\d+$/.test(x)).map(Number)));
  } else if (cmd === 'download') {
    const dir = rest[0];
    const ids = rest.slice(1).filter((x) => /^\d+$/.test(x)).map(Number);
    print(await XMU.download(dir, await XMU.urls(ids)));
  } else if (cmd === 'homeworks') {
    print(await XMU.homeworks(Number(rest[0])));
  } else if (cmd === 'rollcalls') {
    print(await XMU.rollcalls(Number(rest[0])));
  } else if (cmd === 'submissions') {
    print(await XMU.submissions(Number(rest[0])));
  } else if (cmd === 'exams') {
    print(await XMU.exams(Number(rest[0])));
  } else if (cmd === 'exam-subs') {
    print(await XMU.myExamSubmissions(Number(rest[0])));
  } else if (cmd === 'exam-review') {
    const eid = Number(rest[0]);
    const subs = await XMU.myExamSubmissions(eid);
    const sid = rest[1] ? Number(rest[1]) : (subs[subs.length - 1] || {}).id;
    if (!sid) throw new Error('没有本人提交记录，测试 ' + eid + ' 无法回顾');
    const out = flag('out', '');
    if (out) { writeFileSync(out, await XMU.examReviewMd(eid, sid)); console.log('已写入', out); }
    else {
      const p = await XMU.examPaper(eid, sid);
      print({ score: p.score, submittedAt: p.submittedAt, total: p.subjects.length, answered: p.subjects.filter((q) => q.myAnswer).length, wrong: p.subjects.filter((q) => q.correct === false).length, details: rest.includes('--full') ? p.subjects : undefined });
    }
  } else if (cmd === 'bulletins') {
    print(await XMU.bulletins(Number(rest[0]), { keyword: rest[1] || '' }));
  } else if (cmd === 'bulletin') {
    print(await XMU.bulletin(Number(rest[0]), Number(rest[1])));
  } else if (cmd === 'notifications') {
    print(await XMU.notifications(Number(rest[0]) || 30));
  } else if (cmd === 'raw') {
    print(await api(rest[1], { method: rest[0] || 'GET', body: rest[2] ? JSON.parse(rest[2]) : undefined }));
  } else {
    console.log('子命令: login | semesters | courses | todos | coursewares | fetch-urls | download | homeworks | rollcalls | submissions | exams | exam-subs | exam-review | bulletins | bulletin | notifications | raw');
  }
}
