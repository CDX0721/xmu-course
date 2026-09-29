async () => {
  const BASE = 'https://lnt.xmu.edu.cn';

  const call = async (path, opts = {}) => {
    const url = path.startsWith('http') ? path : BASE + path;
    const r = await fetch(url, Object.assign({ credentials: 'include' }, opts));
    const txt = await r.text();
    let data;
    try { data = JSON.parse(txt); } catch (e) { data = txt; }
    if (r.status >= 400) throw new Error(r.status + ' ' + JSON.stringify(data).slice(0, 300));
    return data;
  };
  const json = (path, body, method) => call(path, {
    method: method || 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const strip = (html) => {
    const txt = String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const el = document.createElement('textarea');
    el.innerHTML = txt;
    return el.value.trim();
  };
  const myUid = () => call('/api/profile').then((u) => u.id);
  const b64toBlob = (b64, mime) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime || 'application/octet-stream' });
  };

  const XMU = {

    // ---------- 身份 / 学期 / 课程 / 待办 ----------

    me: () => call('/api/profile').then((u) => ({ id: u.id, user_no: u.user_no, name: u.name })),

    semesters: () => call('/api/my-semesters').then((r) => {
      return r.semesters.map((s) => ({ id: s.id, name: s.name, active: s.is_active }));
    }),

    courses: (semesterId) => {
      const body = semesterId ? { conditions: { semester_ids: [semesterId] } } : {};
      return json('/api/my-courses', body).then((r) => r.courses.map((c) => ({
        id: c.id,
        name: c.name,
        code: c.course_code,
        teacher: c.instructors && c.instructors[0] && c.instructors[0].name,
        semester: c.semester && c.semester.id,
      })));
    },

    todos: () => call('/api/todos').then((r) => {
      return (r.todo_list || []).map((t) => ({
        activityId: t.id,
        course_id: t.course_id,
        course: t.course_name,
        title: t.title,
        type: t.type,
        due: t.end_time,
        locked: t.is_locked,
      }));
    }),

    modules: (cid) => call('/api/courses/' + cid + '/modules').then((r) => {
      return r.modules.map((m) => ({
        id: m.id,
        name: m.name,
        syllabuses: (m.syllabuses || []).map((s) => ({ id: s.id, summary: s.summary })),
      }));
    }),

    // ---------- 课件：查看 + 下载 ----------

    coursewares: (cid) => {
      return call('/api/course/' + cid + '/coursewares?page=1&page_size=200').then((r) => {
        return (r.activities || []).map((a) => {
          const ups = (a.uploads || []).map((u) => ({
            uploadId: u.id,
            name: u.name,
            size: u.size,
            // 仅前端"有没有下载按钮"，服务端不认：allow_download=false 时 urls() 照样拿得到直链。
            // 别拿它当"下不了"的证据而跳过，也别据此无差别批量抓课（见 references/api.md 的用法约束）。
            downloadable: u.allow_download !== false && u.origin_allow_download !== false,
          }));
          return { id: a.id, title: a.title, type: a.type, uploads: ups };
        });
      });
    },

    // 换签名直链；返回项可直接交给 scripts/download.mjs 落盘
    urls: (uploadIds) => {
      return Promise.all((uploadIds || []).map((id) => {
        return call('/api/uploads/' + id + '/url').then((d) => {
          const raw = (d.url.match(/[?&]name=([^&]*)/) || [])[1];
          return { uploadId: id, name: raw ? decodeURIComponent(raw) : String(id), url: d.url };
        });
      }));
    },

    // ---------- 点名 ----------

    rollcalls: (cid, uid) => {
      const p = uid ? Promise.resolve(uid) : myUid();
      return p.then((u) => {
        return call('/api/course/' + cid + '/student/' + u + '/rollcalls?page=1&page_size=200');
      }).then((r) => (r.rollcalls || []).map((x) => ({
        time: x.rollcall_time,
        title: x.title,
        status: x.status,
        studentStatus: x.student_status,
        scored: x.scored,
      })));
    },

    rollcallScore: (cid) => call('/api/course/' + cid + '/rollcall-score'),

    rollcallSetting: (cid) => call('/api/course/' + cid + '/rollcall/setting'),

    // ---------- 作业：得分历史 + 明细 ----------

    homeworks: (cid) => {
      const fields = 'id,title,data,end_time,start_time,score_percentage,is_in_progress,module_id';
      return Promise.all([
        call('/api/course/' + cid + '/homework-scores?fields=' + fields),
        myUid().then((u) => call('/api/course/' + cid + '/homework-student-status').then((st) => ({ st: st, u: String(u) }))),
      ]).then((res) => {
        const hw = res[0], mine = res[1];
        return (hw.homework_activities || []).map((a) => {
          // 状态表是 {activityId: {userId: status}} 两层嵌套
          const perActivity = mine.st[String(a.id)] || {};
          return {
            activityId: a.id,
            title: a.title,
            due: a.end_time,
            scorePct: a.score_percentage,
            open: a.is_in_progress,
            form: a.data && a.data.homework_type,
            myStatus: perActivity[mine.u] || 'unknown',
            desc: strip(a.data && a.data.description),
          };
        });
      });
    },

    activity: (aid) => {
      return call('/api/activities/' + aid + '?sub_course_id=0').then((a) => ({
        id: a.id,
        course_id: a.course_id,
        title: a.title,
        due: a.end_time,
        published: a.published,
        type: a.type,
        form: a.data && a.data.homework_type,
        desc: strip(a.data && a.data.description),
        allowRetract: a.data && a.data.allow_retract,
        scoreRule: a.data && a.data.score_rule,
      }));
    },

    // 我的提交记录。服务端按 新->旧 返回，[0] 是最新一条
    submissions: (aid) => myUid().then((u) => {
      return call('/api/activities/' + aid + '/students/' + u + '/submission_list');
    }).then((r) => (r.list || []).map((s) => ({
      id: s.id,
      isDraft: s.is_draft,
      submittedAt: s.submitted_at,
      score: s.final_score || s.score,
      comment: strip(s.comment).slice(0, 200),
      uploads: (s.uploads || []).map((x) => x.id + ':' + x.name),
    }))),

    homeworkScore: (aid) => myUid().then((u) => {
      return call('/api/activities/' + aid + '/students/' + u + '/homework-score');
    }),

    // ---------- 测试（exam）----------
    // 学生只读得到"我自己答过、且教师已公布答案"的测试；整卷 /api/exams/{eid}/subjects 对学生 403，不要绕。
    exams: (cid) => call('/api/courses/' + cid + '/exam-list?page=1&page_size=50').then((r) => (r.exams || []).map((e) => ({
      id: e.id, title: e.title, start: e.start_time, end: e.end_time,
      myScore: e.score, finalScore: e.final_score, submitted: e.submit_times,
      subjectsCount: e.subjects_count, closed: e.is_closed,
      answerAnnounced: e.announce_answer_status === 'immediate_announce' || e.is_announce_answer_time_passed === true,
      answerType: e.announce_answer_type,
    }))),

    exam: (eid) => call('/api/exams/' + eid).then((e) => ({
      id: e.id, title: e.title, subjectsCount: e.subjects_count, submitTimes: e.submit_times,
      announceAnswerStatus: e.announce_answer_status, announceAnswerType: e.announce_answer_type,
      announceScoreStatus: e.announce_score_status, scoreRule: e.score_rule, scorePercentage: e.score_percentage,
    })),

    myExamSubmissions: (eid) => call('/api/exams/' + eid + '/submissions').then((r) => (r.submissions || []).map((s) => ({
      id: s.id, submittedAt: s.submitted_at, score: s.score, method: s.submit_method_text,
    }))),

    examPaper: (eid, sid) => call('/api/exams/' + eid + '/submissions/' + sid).then((r) => {
      const mine = {}, ref = {};
      ((r.submission_data && r.submission_data.subjects) || []).forEach((s) => { mine[String(s.subject_id)] = s; });
      ((r.correct_answers_data && r.correct_answers_data.correct_answers) || []).forEach((c) => { ref[String(c.subject_id)] = c; });
      const optText = (q, ids) => (ids || []).map((id) => {
        const o = (q.options || []).filter((x) => x.id === id)[0];
        return o ? strip(o.content) : '';
      }).filter(Boolean).join('、');
      return {
        examId: eid, submissionId: sid, score: r.score, submittedAt: r.submitted_at,
        method: r.submit_method_text, autoMark: r.auto_mark,
        subjects: ((r.subjects_data && r.subjects_data.subjects) || []).map((q) => {
          const k = String(q.id), my = mine[k] || {}, cr = ref[k];
          const ans = (q.options || []).filter((o) => o.is_answer).map((o) => strip(o.content)).join('、');
          return {
            sort: q.sort, type: q.type, point: q.point,
            earned: r.submission_score_data ? r.submission_score_data[k] : undefined,
            correct: r.correct_data ? r.correct_data[k] : undefined,
            question: strip(q.description),
            options: (q.options || []).map((o) => ({ id: o.id, text: strip(o.content), answer: o.is_answer === true })),
            myAnswer: my.answer ? strip(my.answer) : optText(q, my.answer_option_ids),
            refAnswer: cr && cr.content ? strip(cr.content) : (cr ? optText(q, cr.answer_option_ids) : ans),
            explanation: strip(q.answer_explanation) || strip(q.wrong_explanation) || '',
          };
        }),
      };
    }),

    examReviewMd: (eid, sid) => XMU.examPaper(eid, sid).then((p) => {
      const L = ['# 测试回顾：exam ' + p.examId + ' / 提交 ' + p.submissionId,
        '- 得分 ' + p.score + '｜交卷 ' + p.submittedAt + '｜' + p.method, ''];
      p.subjects.forEach((q, i) => {
        L.push('## ' + (i + 1) + '. ' + q.question);
        q.options.forEach((o) => L.push('- [' + (o.answer ? 'x' : ' ') + '] ' + o.text));
        L.push('- 我的作答：' + (q.myAnswer || '(未作答)'));
        L.push('- 参考答案：' + q.refAnswer);
        L.push('- 判定：' + (q.correct === true ? '正确' : q.correct === false ? '错误' : '未判') + '｜得分 ' + (q.earned === undefined ? '-' : q.earned) + '/' + q.point);
        if (q.explanation) L.push('- 解析：' + q.explanation);
        L.push('');
      });
      return L.join('\n');
    }),

    // ---------- 公告 / 通知 ----------
    // conditions 里的 start_date/end_date 实测不生效；keyword 按标题过滤有效。
    _bulletin: (b) => ({
      id: b.id, title: b.title, time: b.created_at, by: b.created_by && b.created_by.name,
      targets: (b.targets_name || []).join('、'), sendType: b.send_type,
      body: strip(b.content),
      attachments: (b.uploads || []).map((u) => ({
        uploadId: u.id, name: u.name, size: u.size,
        downloadable: u.allow_download !== false && u.origin_allow_download !== false,
      })),
      inlineUploads: (String(b.content || '').match(/\/api\/uploads\/(\d+)\/in-rich-content/g) || [])
        .map((s) => Number(s.match(/\/api\/uploads\/(\d+)\//)[1])),
    }),

    bulletins: (cid, opts) => {
      const c = { start_date: '', end_date: '', keyword: (opts && opts.keyword) || '' };
      return call('/api/courses/' + cid + '/bulletins?conditions=' + encodeURIComponent(JSON.stringify(c)))
        .then((r) => (r.bulletins || []).map(XMU._bulletin));
    },

    bulletin: (cid, bid) => call('/api/courses/' + cid + '/bulletins/' + bid).then(XMU._bulletin),

    announcements: () => call('/api/announcement').then((r) => r.announcements || []),

    // 通知中心前缀是 /ntf，不是 /api
    notifications: (limit) => myUid().then((u) => call('/ntf/users/' + u + '/notifications?limit=' + (limit || 30) + '&additionalFields=unread_count'))
      .then((r) => ({
        unread: r.unread_count,
        list: (r.notifications || []).map((n) => ({
          type: n.type, unread: n.unread, top: n.top,
          time: new Date(n.timestamp).toISOString(),
          course: n.payload && n.payload.course_name,
          title: (n.payload && (n.payload.activity_title || n.payload.title || n.payload.homework_title)) || '',
          activityId: n.payload && n.payload.activity_id,
          uploads: ((n.payload && n.payload.uploads) || []).map((x) => x.id + ':' + x.file_name),
        })),
      })),

    // ---------- 写操作 ----------

    // 本地文件 -> 平台附件：preUpload -> PUT 签名直链 -> 通知完成
    upload: async (name, base64, mime) => {
      const type = mime || 'application/octet-stream';
      const blob = b64toBlob(base64, type);
      const pre = await json('/api/uploads', { name: name, size: blob.size, type: type });
      const fd = new FormData();
      fd.append('file', new File([blob], name, { type: type }));
      const put = await fetch(pre.upload_url, { method: 'PUT', body: fd });
      const putTxt = await put.text();
      if (!put.ok) throw new Error('media PUT ' + put.status + ' ' + putTxt.slice(0, 200));
      await call('/api/uploads/' + pre.id + '/uploaded', { method: 'PUT' });
      let fileKey = null;
      try { fileKey = JSON.parse(putTxt).file_key || null; } catch (e) { /* 非 JSON 响应 */ }
      return { uploadId: pre.id, name: name, size: blob.size, fileKey: fileKey };
    },

    // 大附件（>几 MB）走这条：本机起带 CORS 的 http 服务，页面里 fetch 成 blob，避开 base64 膨胀
    uploadFromLocal: async (localUrl, name, mime) => {
      const blob = await (await fetch(localUrl)).blob();
      const pre = await json('/api/uploads', { name: name, size: blob.size, type: mime });
      const fd = new FormData();
      fd.append('file', new File([blob], name, { type: mime }));
      const put = await fetch(pre.upload_url, { method: 'PUT', body: fd });
      const putTxt = await put.text();
      if (!put.ok) throw new Error('media PUT ' + put.status + ' ' + putTxt.slice(0, 200));
      await call('/api/uploads/' + pre.id + '/uploaded', { method: 'PUT' });
      return { uploadId: pre.id, name: name, size: blob.size };
    },

    // uploads 必须是【字符串 id 数组】：传数字会被静默丢弃，传对象直接 500
    _save: (aid, o, isDraft) => json('/api/course/activities/' + aid + '/submissions', {
      comment: o.comment || '',
      uploads: (o.uploads || []).map(String),
      slides: [],
      is_draft: isDraft,
      mode: 'normal',
      other_resources: [],
      uploads_in_rich_text: [],
    }),

    saveDraft: (aid, o) => XMU._save(aid, o, true),

    submit: (aid, o) => XMU._save(aid, o, false),

    raw: call,
  };

  window.XMU = XMU;
  return 'XMU ready @ ' + location.host;
}
