"use strict";
/* =====================================================================
   올인원 시험캘린더 — 앱 로직
   구성: 1.설정 상수  2.저장  3.유틸  4.아이콘  5.데이터 조회
         6.규칙 기반 추천  7.Gemini  8.화면(오늘·캘린더·시험·시간표·설정)
         9.렌더  10.동작(버튼·폼)  11.시작
   ===================================================================== */

/* ---------- 1. 설정 상수 ---------- */
// 미리 넣어 둘 키는 config.js에 적습니다. (사용자가 설정 탭에서 넣은 키가 있으면 그쪽이 우선)
// ⚠ config.js를 공개 저장소에 올리면 누구나 키를 볼 수 있습니다. 올리기 전 config.js 안내를 따르세요.
const PRESET = Object.assign({ geminiKey: "", neisKey: "" }, window.JGCAL_KEYS);

const STORE_KEY = "jgcal.v1";
// 모델 이름은 자주 바뀌어서(예전 gemini-2.5-flash는 새 키에 제공이 끝남) 안 되면 아래 순서대로 자동으로 다음 모델을 시도한다.
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-flash-lite-latest", "gemini-3.1-flash-lite", "gemini-flash-latest", "gemini-2.5-flash"];
const TYPE = { perf: "수행평가", info: "중요 정보", etc: "기타", exam: "시험" };
const DOW = ["일", "월", "화", "수", "목", "금", "토"];
const SUBJECTS = ["국어", "영어", "수학", "고급미적분", "물리학", "화학", "생명과학", "지구과학", "한국사", "통합사회", "정보"];
const TABS = [["today", "오늘"], ["cal", "캘린더"], ["exam", "시험"], ["tt", "시간표"], ["set", "설정"]];

/* ---------- 2. 저장 (localStorage) ---------- */
const defaults = () => ({
  events: [],            // {id,title,type,subject,weight,note,date,done}
  exams: [],             // {id,subject,date,tasks:[{id,text,min,done}]}
  settings: {
    gemini: { key: "", model: DEFAULT_MODEL },
    neis: { key: "", office: "Q10", school: "7140163", schoolName: "전남과학고등학교", grade: 2, cls: 2 }
  },
  tt: { neis: {}, manual: {}, fetched: {} },
  ai: { date: "", sig: "", source: "", model: "", items: [], error: "" },
  // 사용 기록(검증용). 이 기기에만 저장된다. days = 날짜별 {shown: 추천 수, done: 완료 수, source}
  stats: { events: 0, exams: 0, tasks: 0, days: {} }
});
function merge(dst, src) {
  const isObj = v => v && typeof v === "object" && !Array.isArray(v);
  for (const k in src) {
    if (isObj(src[k]) && isObj(dst[k])) merge(dst[k], src[k]);
    else dst[k] = src[k];
  }
  return dst;
}
/** 지금은 없는 예전 기능의 데이터가 저장본이나 가져온 파일에 남아 있으면 지운다 */
function stripLegacy(raw) {
  if (raw && raw.settings) delete raw.settings.dorm;
  return raw;
}
function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    const legacy = !!(raw.settings && raw.settings.dorm);
    const d = merge(defaults(), stripLegacy(raw));
    if (d.settings.gemini.model === "gemini-2.5-flash") d.settings.gemini.model = DEFAULT_MODEL;   // 예전 기본값 → 새 기본값
    if (legacy) localStorage.setItem(STORE_KEY, JSON.stringify(d));   // 지운 기능의 데이터는 저장소에서도 바로 정리
    return d;
  } catch (e) { return defaults(); }
}
/** 오늘 추천이 몇 개였고 그중 몇 개를 끝냈는지 날짜별로 남긴다 (최근 90일) */
function snapshotToday() {
  const a = S.ai;
  if (a.date !== today() || !a.items.length) return;
  S.stats.days[a.date] = { shown: a.items.length, done: a.items.filter(recDone).length, source: a.source };
  const keys = Object.keys(S.stats.days).sort();
  while (keys.length > 90) delete S.stats.days[keys.shift()];
}
function save() {
  snapshotToday();
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); }
  catch (e) { toast("저장 공간 문제로 저장하지 못했어요"); }
}
let S = load();

/* ---------- 3. 유틸 ---------- */
const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const compact = s => s.replace(/-/g, "");
const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const today = () => ymd(new Date());
const daysFromNow = n => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
const diff = (s, t = today()) => Math.round((parse(s) - parse(t)) / 86400000);
const dday = n => n === 0 ? "D-Day" : n > 0 ? `D-${n}` : `D+${-n}`;
const shortDate = s => `${Number(s.slice(5, 7))}/${Number(s.slice(8))} (${DOW[parse(s).getDay()]})`;
const uid = () => Math.random().toString(36).slice(2, 9);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const geminiKey = () => S.settings.gemini.key || PRESET.geminiKey;
const neisKey = () => S.settings.neis.key || PRESET.neisKey;
function hash(str) { let x = 5381; for (let i = 0; i < str.length; i++) x = ((x << 5) + x + str.charCodeAt(i)) | 0; return String(x); }
function monday(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); const w = x.getDay(); x.setDate(x.getDate() + (w === 0 ? -6 : 1 - w)); return x; }
/** 주말이면 다음 주 월요일, 평일이면 이번 주 월요일 */
function schoolWeek() { const n = new Date(); if (n.getDay() === 6) n.setDate(n.getDate() + 2); if (n.getDay() === 0) n.setDate(n.getDate() + 1); return monday(n); }
const weekDates = () => [...Array(5)].map((_, i) => { const d = new Date(ui.ttWeek); d.setDate(d.getDate() + i); return d; });

let toastTimer;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("on");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 2600);
}
function openDialog(html) { const d = $("#dlg"); d.innerHTML = html; try { d.showModal(); } catch (e) { } }
function closeDialog() { const d = $("#dlg"); if (d.open) d.close(); }

/* ---------- 4. 아이콘 (SVG) ---------- */
const ICON_PATHS = {
  today: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.4 2.4 2.4 4.6-5"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  exam: '<path d="M6 3.5h8l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-10.5A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5Z"/><path d="M14 3.5V8h4M8.5 12.5h7M8.5 16h4.5"/>',
  tt: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M9 9.5v10M15 9.5v10M3.5 14.5h17"/>',
  set: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  prev: '<path d="m14.5 6-6 6 6 6"/>',
  next: '<path d="m9.5 6 6 6-6 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  spark: '<path d="M12 3.5 13.8 10l6.7 2-6.7 2L12 20.5 10.2 14l-6.7-2 6.7-2L12 3.5Z"/>',
  rule: '<path d="M4 18 18 4l2 2L6 20l-2-2ZM14.5 7.5l2 2M11.5 10.5l1 1M8.5 13.5l2 2"/>',
  trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l.8 12.5h8.4L17 7"/>',
  edit: '<path d="m5 19 .8-3.8L16 5l3 3L8.8 18.2 5 19Z"/>'
};
const icon = name => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name]}</svg>`;

/* ---------- 화면 상태 (저장되지 않음) ---------- */
const ui = {
  tab: "today",
  busy: false,
  editing: null,                       // 캘린더에서 수정 중인 일정 id
  selDate: today(),
  calY: new Date().getFullYear(),
  calM: new Date().getMonth(),
  ttWeek: schoolWeek(),
  msg: {},                             // 화면별 안내 문구 {tt, g, s}
  open: new Set()                      // 펼쳐 둔 접기 영역
};
const keepOpen = (key, force) => `data-keep="${key}" ${force || ui.open.has(key) ? "open" : ""}`;

/* ---------- 5. 데이터 조회 ---------- */
const hasData = () => S.events.length > 0 || S.exams.length > 0;
/** 일정과 시험을 달력에 올릴 수 있는 한 가지 모양으로 합친다 */
function datedItems() {
  const out = S.events.map(e => ({ kind: e.type, id: e.id, title: e.title, subject: e.subject, note: e.note, date: e.date, done: e.done, src: "event" }));
  S.exams.forEach(x => out.push({ kind: "exam", id: x.id, title: `${x.subject} 시험`, subject: x.subject, note: "", date: x.date, done: false, src: "exam" }));
  return out;
}
/** 추천 항목의 ref("e:일정id" 또는 "t:시험id:할일id")가 가리키는 실제 데이터 */
function findRef(ref) {
  if (!ref) return null;
  const p = ref.split(":");
  if (p[0] === "e") { const e = S.events.find(e => e.id === p[1]); return e ? { type: "event", e } : null; }
  if (p[0] === "t") { const x = S.exams.find(x => x.id === p[1]); const t = x && x.tasks.find(t => t.id === p[2]); return t ? { type: "task", x, t } : null; }
  return null;
}
function allRefs() {
  const refs = S.events.map(e => "e:" + e.id);
  S.exams.forEach(x => x.tasks.forEach(t => refs.push(`t:${x.id}:${t.id}`)));
  return refs;
}
/** 해당 날짜·교시의 과목 (NEIS 우선, 없으면 직접 입력) */
function subjectAt(ds, period) {
  const n = S.tt.neis[compact(ds)];
  const wd = parse(ds).getDay();
  return (n && n[period]) || (S.tt.manual[wd] && S.tt.manual[wd][period]) || "";
}

/* ---------- 6. 규칙 기반 추천 (AI가 없거나 실패했을 때 쓰는 계산) ---------- */
const urgency = d => d <= 0 ? 10 : Math.min(10, 20 / (d + 1));
function ruleRecs() {
  const c = [];
  for (const e of S.events) {
    if (e.done) continue;
    const d = diff(e.date);
    if (d < -1 || d > 30) continue;
    if (e.type === "perf") {
      const w = Number(e.weight) || 0;
      c.push({ ref: "e:" + e.id, title: e.subject && !e.title.includes(e.subject) ? `${e.subject} ${e.title}` : e.title, score: urgency(d) * (1 + w / 40), reason: `수행평가 ${dday(d)}${w ? ` · 반영 ${w}%` : ""}`, minutes: 60 });
    } else if (e.type === "info" && d >= 0 && d <= 3) {
      c.push({ ref: "e:" + e.id, title: e.title, score: urgency(d) * 0.6, reason: `중요 정보 ${dday(d)}`, minutes: 10 });
    }
  }
  for (const x of S.exams) {
    const d = diff(x.date);
    if (d < 0 || d > 45) continue;
    const rem = x.tasks.filter(t => !t.done);
    if (!x.tasks.length) {
      c.push({ ref: null, title: `${x.subject} 시험 공부 계획 입력하기`, score: urgency(d) * 0.5, reason: `${x.subject} 시험 ${dday(d)} · 해야 할 일이 비어 있어요`, minutes: 10 });
      continue;
    }
    rem.slice(0, d <= 3 ? 2 : 1).forEach((t, i) => {
      c.push({ ref: `t:${x.id}:${t.id}`, title: `${x.subject}: ${t.text}`, score: urgency(d) * (1 + 0.1 * rem.length) * (i ? 0.85 : 1), reason: `${x.subject} 시험 ${dday(d)} · 남은 할 일 ${rem.length}개`, minutes: t.min || 40 });
    });
  }
  return c.sort((a, b) => b.score - a.score).slice(0, 5).map(o => ({ ref: o.ref, title: o.title, reason: o.reason, minutes: o.minutes, done: false }));
}

/* ---------- 7. Gemini ---------- */
function buildPrompt() {
  const t = today(), L = [];
  L.push(`오늘: ${t} (${DOW[new Date().getDay()]}요일)`);
  const tl = [];
  for (let p = 1; p <= 10; p++) { const s = subjectAt(t, p); if (s) tl.push(`${p}교시 ${s}`); }
  if (tl.length) L.push(`오늘 시간표: ${tl.join(", ")}`);
  L.push("[수행평가/일정]");
  S.events.filter(e => !e.done && diff(e.date) >= -1 && diff(e.date) <= 30).sort((a, b) => a.date.localeCompare(b.date)).forEach(e =>
    L.push(`- id=e:${e.id} | ${TYPE[e.type]} | ${e.subject || "-"} | ${e.title} | ${e.date} (${dday(diff(e.date))})${e.weight ? ` | 반영 ${e.weight}%` : ""}${e.note ? ` | 메모: ${e.note.slice(0, 80)}` : ""}`));
  L.push("[시험]");
  S.exams.filter(x => diff(x.date) >= 0).forEach(x => {
    L.push(`- ${x.subject} 시험 ${x.date} (${dday(diff(x.date))})`);
    x.tasks.forEach(k => L.push(`   - id=t:${x.id}:${k.id} | ${k.done ? "완료" : "미완료"} | ${k.text}${k.min ? ` | 예상 ${k.min}분` : ""}`));
  });
  return `너는 고등학생의 하루 공부 계획을 짜 주는 코치야. 아래 데이터를 보고 "오늘 할 일"을 우선순위 순으로 최대 5개 추천해.
규칙:
- 마감/시험이 가까울수록, 수행평가 반영 비율이 클수록, 남은 양이 많을수록 우선순위를 높게 둔다.
- 이미 완료한 항목은 제외한다. 오늘 시간표가 있으면 수업 외 시간에 할 수 있는 현실적인 양만 고른다.
- ref에는 데이터에 적힌 id를 그대로 쓰고, 해당하는 id가 없으면 빈 문자열을 쓴다.
- title은 짧고 구체적으로, reason은 왜 오늘 해야 하는지 한 문장으로(해요체), minutes는 예상 소요 시간(분)이다.
- 할 일이 없으면 빈 배열을 반환한다.

${L.join("\n")}`;
}
/** Gemini 호출. 모델명이 없으면(404) 다음 후보 모델로 자동 대체한다. */
async function askGemini(prompt) {
  if (!geminiKey()) throw new Error("NOKEY");
  const models = [S.settings.gemini.model, ...FALLBACK_MODELS].filter((m, i, a) => m && a.indexOf(m) === i);
  const schema = { type: "ARRAY", items: { type: "OBJECT", properties: { ref: { type: "STRING" }, title: { type: "STRING" }, reason: { type: "STRING" }, minutes: { type: "INTEGER" } }, required: ["ref", "title", "reason", "minutes"] } };
  let busy = false;
  for (const m of models) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 30000);
    let r;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(geminiKey())}`, {
        method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 4096, responseMimeType: "application/json", responseSchema: schema } })
      });
    } finally { clearTimeout(timer); }
    if (r.status === 404) continue;
    if (r.status >= 500) { busy = true; continue; }          // 서버가 바쁘면 다음 모델로
    if (r.status === 429) throw new Error("QUOTA");
    if (r.status === 401 || r.status === 403) throw new Error("KEY");
    if (r.status === 400) { const j = await r.json().catch(() => ({})); throw new Error(/API key/i.test(JSON.stringify(j)) ? "KEY" : "BAD"); }
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const txt = ((j.candidates || [])[0]?.content?.parts || []).map(p => p.text || "").join("").replace(/^```(?:json)?|```$/g, "").trim();
    const arr = JSON.parse(txt);
    if (!Array.isArray(arr)) throw new Error("FORMAT");
    return { arr, model: m };
  }
  throw new Error(busy ? "BUSY" : "NOMODEL");
}
/** 실패 사유를 한국어 한 문장으로 */
function aiErrorReason(e) {
  const m = (e && e.message) || "";
  if (m === "NOKEY") return "API 키가 없어요.";
  if (m === "QUOTA") return "무료 사용량을 넘었어요.";
  if (m === "KEY") return "API 키가 올바르지 않아요.";
  if (m === "NOMODEL") return "사용할 수 있는 모델을 찾지 못했어요.";
  if (m === "BUSY") return "AI 서버가 지금 바빠요.";
  if (e && e.name === "AbortError") return "AI 응답이 너무 늦어요.";
  if (e instanceof TypeError) return "네트워크 문제로 AI에 연결하지 못했어요.";
  if (m.startsWith("HTTP ")) return `AI 서버 오류(${m.slice(5)})가 났어요.`;
  return "AI 응답을 처리하지 못했어요.";
}
/** 일정이 바뀌었는지 알아내기 위한 지문 */
function dataSignature() {
  return hash(JSON.stringify([S.events.map(e => [e.id, e.date, e.done, e.type, e.weight]), S.exams.map(x => [x.id, x.date, x.tasks.map(t => t.id)])]));
}
/** 오늘 추천 만들기: 키가 있으면 AI, 없거나 실패하면 규칙 기반 */
async function recommend() {
  if (ui.busy) return;
  const sig = dataSignature();
  let items = null, source = "rule", model = "", error = "";
  if (geminiKey()) {
    ui.busy = true; render();
    try {
      const valid = new Set(allRefs());
      const res = await askGemini(buildPrompt());
      items = res.arr.slice(0, 5).map(o => ({
        ref: valid.has(o.ref) ? o.ref : null, title: String(o.title || "").slice(0, 80), reason: String(o.reason || "").slice(0, 140),
        minutes: Math.max(5, Math.min(180, parseInt(o.minutes) || 30)), done: false
      })).filter(o => o.title);
      source = "ai"; model = res.model;
    } catch (e) { error = aiErrorReason(e) + " 규칙 기반으로 추천했어요."; items = null; }
    ui.busy = false;
  }
  if (!items) items = ruleRecs();
  S.ai = { date: today(), sig, source, model, items, error };
  save(); render();
}
/** 오늘 탭을 열 때: 날짜가 바뀌었거나(키 없을 땐) 일정이 바뀌었으면 자동으로 다시 계산 */
function autoRecommend() {
  if (ui.busy) return;
  if (S.ai.date !== today()) return void recommend();
  if (S.ai.sig !== dataSignature() && !geminiKey()) recommend();
}

/* ---------- 8-1. 화면: 오늘 ---------- */
const recDone = it => { const r = findRef(it.ref); return r && r.type === "task" ? r.t.done : it.done; };

function heroBlock() {
  const n = new Date(), t = today();
  const soon = datedItems().filter(x => { const d = diff(x.date, t); return d >= 0 && d <= 14 && !x.done; });
  const exams = soon.filter(x => x.kind === "exam").length;
  const summary = soon.length ? `2주 안에 일정 ${soon.length - exams}개 · 시험 ${exams}개` : "2주 안에 잡힌 일정이 없어요";
  return `<section class="hero">
    <div class="hero-date"><span class="hero-day">${n.getDate()}</span>
      <div class="hero-meta"><b>${n.getMonth() + 1}월 ${DOW[n.getDay()]}요일</b><span class="sub">${summary}</span></div></div>
    <button class="btn honey" data-act="quickadd">${icon("plus")}빠른 추가</button>
  </section>`;
}
function periodStrip(ds) {
  const wd = parse(ds).getDay();
  if (wd === 0 || wd === 6) return `<div class="sub">주말이라 수업이 없어요.</div>`;
  const cells = [];
  for (let p = 1; p <= 10; p++) { const s = subjectAt(ds, p); if (s) cells.push(`<div class="period"><small>${p}교시</small><b>${esc(s)}</b></div>`); }
  return cells.length ? `<div class="periods">${cells.join("")}</div>`
    : `<div class="sub">오늘 시간표가 없어요. 시간표 탭에서 불러오거나 직접 입력해 주세요.</div>`;
}
function emptyCard() {
  return `<div class="card empty">
    <h3>아직 등록된 일정이 없어요</h3>
    <p class="sub mt8">일정만 넣어 두면 오늘 뭐부터 할지 골라 드려요.</p>
    <ol>
      <li><span><b>빠른 추가</b>로 수행평가 마감일을 넣어요.</span></li>
      <li><span><b>시험</b> 탭에서 과목·날짜·해야 할 일을 적어요.</span></li>
      <li><span>이 화면에 <b>오늘 할 일</b>이 우선순위대로 나와요.</span></li>
    </ol>
    <div class="row wrap-x"><button class="btn honey" data-act="quickadd">${icon("plus")}첫 일정 추가</button>
      <button class="btn ghost" data-act="sample">예시 데이터로 둘러보기</button></div>
  </div>`;
}
function recCard() {
  const a = S.ai, items = a.items || [], hasKey = !!geminiKey();
  const remain = items.filter(i => !recDone(i)).reduce((s, i) => s + (i.minutes || 0), 0);
  const stale = a.date === today() && a.sig !== dataSignature() && hasKey;
  const source = ui.busy ? `<span class="spin"></span>AI가 우선순위를 판단하는 중이에요…`
    : a.source === "ai" ? `${icon("spark")}AI 추천 · ${esc(a.model)}`
    : `${icon("rule")}규칙 기반 추천 · 마감 임박도, 반영 비율, 남은 할 일`;
  let o = `<div class="card rec"><div class="card-head"><h3>오늘 뭐부터 할까</h3>
    <button class="btn sm ghost" data-act="recgo" ${ui.busy ? "disabled" : ""}>${hasKey ? "AI에게 다시 묻기" : "다시 계산"}</button></div>
    <div class="source">${source}</div>`;
  if (!ui.busy && a.source !== "ai" && !hasKey) o += `<p class="sub">설정에서 Gemini 키를 넣으면 AI가 판단해요.</p>`;
  if (a.error && !ui.busy) o += `<p class="msg-err">${esc(a.error)}</p>`;
  if (stale && !ui.busy) o += `<p class="sub">일정이 바뀌었어요. 다시 물어보면 반영돼요.</p>`;
  if (!items.length && !ui.busy) o += `<p class="sub mt12">오늘 추천할 일이 없어요. 수행평가나 시험을 등록해 보세요.</p>`;
  items.forEach((it, i) => {
    const done = recDone(it);
    o += `<div class="item ${done ? "done" : ""}"><input type="checkbox" aria-label="완료" data-act="rectoggle" data-i="${i}" ${done ? "checked" : ""}>
      <div class="grow"><div class="title">${esc(it.title)}</div><div class="sub">${esc(it.reason)}</div></div>
      <span class="pill">${it.minutes}분</span></div>`;
  });
  if (items.length) o += `<div class="rec-total"><span>남은 예상 시간</span><b>약 ${remain}분</b></div>`;
  return o + `</div>`;
}
/** 일정 한 줄 (오늘 탭·캘린더 탭 공용) */
function eventRow(x, { sub, right }) {
  const check = x.src === "event" ? `<input type="checkbox" aria-label="완료" data-act="evtoggle" data-id="${x.id}" ${x.done ? "checked" : ""}>` : `<span class="spacer22"></span>`;
  return `<div class="item ${x.done ? "done" : ""}">${check}
    <div class="grow"><div class="title"><span class="tag t-${x.kind}">${TYPE[x.kind]}</span>${esc(x.title)}</div><div class="sub">${sub}</div></div>
    <div class="side-x">${right}</div></div>`;
}
function upcomingCard() {
  const t = today();
  const list = datedItems().filter(x => { const d = diff(x.date, t); return (d >= 0 && d <= 14) || (d < 0 && d >= -7 && x.kind === "perf" && !x.done); }).sort((a, b) => a.date.localeCompare(b.date));
  let o = `<div class="card upcoming"><h3>다가오는 일정 <span class="sub">2주</span></h3>`;
  if (!list.length) o += `<p class="sub">2주 안에 잡힌 일정이 없어요.</p>`;
  list.forEach(x => {
    const d = diff(x.date, t);
    o += eventRow(x, {
      sub: `<span class="num">${shortDate(x.date)}</span>${x.subject && x.src === "event" ? " · " + esc(x.subject) : ""}`,
      right: `<span class="badge ${d <= 2 ? "hot" : ""}">${dday(d)}</span>`
    });
  });
  return o + `</div>`;
}
function viewToday() {
  const top = heroBlock() + periodStrip(today());
  if (!hasData()) return top + emptyCard();
  return top + `<div class="today-grid">${recCard()}${upcomingCard()}</div>`;
}

/* ---------- 8-2. 화면: 캘린더 ---------- */
const typeOptions = cur => ["perf", "info", "etc"].map(k => `<option value="${k}" ${cur === k ? "selected" : ""}>${TYPE[k]}</option>`).join("");
function eventForm() {
  const ev = ui.editing ? S.events.find(e => e.id === ui.editing) : null;
  const v = ev || { title: "", type: "perf", subject: "", weight: "", note: "", date: ui.selDate };
  return `<form data-form="addev" class="form">
    <label class="field full">제목<input name="title" value="${esc(v.title)}" placeholder="예: 물리 탐구보고서 제출" required></label>
    <label class="field">구분<select name="type">${typeOptions(v.type)}</select></label>
    <label class="field">날짜<input name="date" type="date" value="${esc(v.date)}" required></label>
    <label class="field">과목<input name="subject" value="${esc(v.subject)}" placeholder="예: 물리학"></label>
    <label class="field">반영 비율(%)<input name="weight" type="number" min="0" max="100" value="${esc(v.weight)}" placeholder="선택"></label>
    <label class="field full">메모<input name="note" value="${esc(v.note)}" placeholder="준비물, 제출 방법 등"></label>
    <button class="btn full">${ev ? "수정 저장" : "일정 추가"}</button>
    ${ev ? `<button type="button" class="btn ghost full" data-act="evcancel">취소</button>` : ""}
  </form>`;
}
function viewCal() {
  const first = new Date(ui.calY, ui.calM, 1), lastDay = new Date(ui.calY, ui.calM + 1, 0).getDate();
  const byDate = {}; datedItems().forEach(x => (byDate[x.date] = byDate[x.date] || []).push(x));
  let grid = `<div class="cal">` + DOW.map(d => `<div class="dow">${d}</div>`).join("");
  for (let i = 0; i < first.getDay(); i++) grid += `<div class="day off"></div>`;
  for (let d = 1; d <= lastDay; d++) {
    const ds = `${ui.calY}-${pad(ui.calM + 1)}-${pad(d)}`, its = byDate[ds] || [];
    grid += `<button type="button" class="day ${ds === today() ? "today" : ""} ${ds === ui.selDate ? "sel" : ""}" data-act="selday" data-date="${ds}" aria-label="${d}일, 일정 ${its.length}개"><span class="n">${d}</span>
      <span class="chips">${its.slice(0, 3).map(x => `<span class="chip t-${x.kind} ${x.done ? "done" : ""}">${esc(x.title)}</span>`).join("")}${its.length > 3 ? `<span class="more">+${its.length - 3}</span>` : ""}</span></button>`;
  }
  grid += `</div>`;

  const dayItems = byDate[ui.selDate] || [];
  let panel = `<div class="card"><h3>${shortDate(ui.selDate)}</h3>`;
  if (!dayItems.length) panel += `<p class="sub">이 날은 일정이 없어요.</p>`;
  dayItems.forEach(x => {
    panel += eventRow(x, {
      sub: x.src === "event" ? esc(x.note || x.subject || "") : "시험 탭에서 수정할 수 있어요",
      right: x.src === "event" ? `<button class="btn icon ghost" data-act="evedit" data-id="${x.id}" aria-label="수정">${icon("edit")}</button><button class="btn icon danger" data-act="evdel" data-id="${x.id}" aria-label="삭제">${icon("trash")}</button>` : ""
    });
  });
  panel += `<hr class="hr">${eventForm()}</div>`;

  return `<div class="cal-grid2"><div class="card"><div class="row">
      <span class="cal-title grow">${ui.calY}. ${pad(ui.calM + 1)}</span>
      <button class="btn sm ghost" data-act="caltoday">오늘</button>
      <button class="btn icon ghost" data-act="calprev" aria-label="이전 달">${icon("prev")}</button>
      <button class="btn icon ghost" data-act="calnext" aria-label="다음 달">${icon("next")}</button></div>
    ${grid}</div>${panel}</div>`;
}

/* ---------- 8-3. 화면: 시험 ---------- */
function examCard(x) {
  const d = diff(x.date), done = x.tasks.filter(t => t.done).length, pct = x.tasks.length ? Math.round(done / x.tasks.length * 100) : 0;
  let o = `<div class="card"><div class="exam-head"><h3>${esc(x.subject)}</h3>
      <span class="badge ${d >= 0 && d <= 3 ? "hot" : ""}">${dday(d)}</span>
      <button class="btn icon danger" data-act="examdel" data-id="${x.id}" aria-label="시험 삭제">${icon("trash")}</button></div>
    <div class="exam-meta"><input type="date" value="${esc(x.date)}" data-examdate="${x.id}" aria-label="시험 날짜"><span class="sub grow num" style="text-align:right">${done}/${x.tasks.length} 완료</span></div>
    <div class="bar"><i style="width:${pct}%"></i></div><div class="mt8">`;
  x.tasks.forEach(t => {
    o += `<div class="item ${t.done ? "done" : ""}"><input type="checkbox" aria-label="완료" data-act="tasktoggle" data-x="${x.id}" data-t="${t.id}" ${t.done ? "checked" : ""}>
      <div class="grow title">${esc(t.text)}</div>
      <div class="side-x">${t.min ? `<span class="pill">${t.min}분</span>` : ""}<button class="btn icon ghost" data-act="taskdel" data-x="${x.id}" data-t="${t.id}" aria-label="할 일 삭제">${icon("close")}</button></div></div>`;
  });
  return o + `</div><form data-form="addtask" data-x="${x.id}" class="task-form"><input name="text" placeholder="해야 할 일 (예: 모의고사 2회)" required><input class="min" name="min" type="number" min="5" step="5" placeholder="분" aria-label="예상 시간(분)"><button class="btn icon" style="width:40px;height:40px" aria-label="할 일 추가">${icon("plus")}</button></form></div>`;
}
function viewExam() {
  const upcoming = S.exams.filter(x => diff(x.date) >= 0).sort((a, b) => a.date.localeCompare(b.date));   // 임박한 순
  const past = S.exams.filter(x => diff(x.date) < 0).sort((a, b) => b.date.localeCompare(a.date));
  let o = `<div class="card"><h3>시험 추가</h3><form data-form="addexam" class="form">
    <input name="subject" list="subs" placeholder="과목" required><input name="date" type="date" aria-label="시험 날짜" required>
    <button class="btn full">추가</button></form>
    <datalist id="subs">${SUBJECTS.map(s => `<option value="${s}">`).join("")}</datalist></div>`;
  if (!S.exams.length) o += `<div class="card empty"><h3>등록된 시험이 없어요</h3><p class="sub mt8">과목별 시험 날짜와 해야 할 일을 적어 두면<br>오늘 할 일을 골라 드려요.</p></div>`;
  if (upcoming.length) o += `<div class="exam-list">${upcoming.map(examCard).join("")}</div>`;
  if (past.length) o += `<details ${keepOpen("past")}><summary>지난 시험 ${past.length}개</summary><div class="past">${past.map(examCard).join("")}</div></details>`;
  return o;
}

/* ---------- 8-4. 화면: 시간표 ---------- */
function viewTimetable() {
  const days = weekDates(), ds = days.map(ymd), n = S.settings.neis, t = today();
  let maxP = 7; ds.forEach(s => { const row = S.tt.neis[compact(s)]; if (row) Object.keys(row).forEach(p => maxP = Math.max(maxP, +p)); });
  const msg = ui.msg.tt;
  let o = `<div class="card"><div class="row">
      <div class="grow"><div class="cal-title">${n.grade}학년 ${n.cls}반</div><div class="sub num">${days[0].getMonth() + 1}/${days[0].getDate()} ~ ${days[4].getMonth() + 1}/${days[4].getDate()}</div></div>
      <button class="btn sm ghost" data-act="tttoday">이번 주</button>
      <button class="btn icon ghost" data-act="ttprev" aria-label="이전 주">${icon("prev")}</button>
      <button class="btn icon ghost" data-act="ttnext" aria-label="다음 주">${icon("next")}</button></div>
    <table class="tt"><tr><th class="p"></th>${days.map((d, i) => `<th class="${ds[i] === t ? "now" : ""}">${DOW[d.getDay()]}<b>${d.getDate()}</b></th>`).join("")}</tr>`;
  for (let p = 1; p <= maxP; p++) o += `<tr><td class="p">${p}</td>${ds.map(s => `<td class="${s === t ? "now" : ""}">${esc(subjectAt(s, p))}</td>`).join("")}</tr>`;
  o += `</table><div class="row wrap-x mt12"><button class="btn" data-act="ttfetch" ${ui.busy ? "disabled" : ""}>NEIS에서 불러오기</button>
      ${msg ? `<span class="${msg.err ? "msg-err" : "msg-ok"} grow">${esc(msg.text)}</span>` : ""}</div>
    </div>`;
  o += `<div class="card"><details ${keepOpen("manual")}><summary>시간표 직접 입력</summary>
    <p class="sub">요일별로 반복되는 시간표로 저장돼요. NEIS에서 불러온 내용이 있으면 그쪽이 먼저 보여요.</p>
    <table class="tt edit"><tr><th class="p"></th>${[1, 2, 3, 4, 5].map(w => `<th>${DOW[w]}</th>`).join("")}</tr>`;
  for (let p = 1; p <= maxP; p++) o += `<tr><td class="p">${p}</td>${[1, 2, 3, 4, 5].map(w => `<td><input class="tt-in" aria-label="${DOW[w]}요일 ${p}교시" data-ttwd="${w}" data-ttp="${p}" value="${esc((S.tt.manual[w] || {})[p] || "")}"></td>`).join("")}</tr>`;
  return o + `</table></details></div>`;
}
async function fetchTimetable() {
  const n = S.settings.neis, ds = weekDates().map(ymd), keyed = !!neisKey();
  ui.busy = true; ui.msg.tt = { text: "불러오는 중…" }; render();
  try {
    // 키가 있으면 한 주를 한 번에 받는다.
    // 키가 없으면 NEIS가 요청마다 앞의 5개만 주고 쪽 번호·교시 조건도 무시하므로, 하루씩 따로 받는다(요일당 1~5교시까지).
    const call = async extra => {
      const q = new URLSearchParams({ Type: "json", pIndex: 1, pSize: keyed ? 1000 : 5, ATPT_OFCDC_SC_CODE: n.office, SD_SCHUL_CODE: n.school, GRADE: n.grade, CLASS_NM: n.cls, ...extra });
      if (keyed) q.set("KEY", neisKey());
      return (await fetch("https://open.neis.go.kr/hub/hisTimetable?" + q)).json();
    };
    const results = keyed ? [await call({ TI_FROM_YMD: compact(ds[0]), TI_TO_YMD: compact(ds[4]) })]
      : await Promise.all(ds.map(s => call({ ALL_TI_YMD: compact(s) })));
    const blocks = results.map(x => x.hisTimetable).filter(Boolean);
    if (!blocks.length) {
      const r = results[0].RESULT || {};
      if (r.CODE === "INFO-200") ui.msg.tt = { text: "이 주의 시간표가 NEIS에 없어요. 아래에서 직접 입력해 주세요.", err: true };
      else throw new Error(r.MESSAGE || "응답 형식 오류");
    } else {
      let rows = [], cut = false;
      blocks.forEach(b => { const r = b[1].row || []; rows = rows.concat(r); if ((b[0].head[0].list_total_count || 0) > r.length) cut = true; });
      ds.forEach(s => delete S.tt.neis[compact(s)]);
      rows.forEach(rw => { const k = rw.ALL_TI_YMD; (S.tt.neis[k] = S.tt.neis[k] || {})[parseInt(rw.PERIO)] = String(rw.ITRT_CNTNT || "").trim(); });
      S.tt.fetched[compact(ds[0])] = Date.now(); save();
      ui.msg.tt = cut ? { text: `NEIS 키가 없어 ${rows.length}개 교시(하루 5교시까지)만 불러왔어요. 6교시부터는 직접 입력하거나 키를 넣어 주세요.`, err: true } : { text: `${rows.length}개 교시를 불러왔어요.` };
    }
  } catch (e) {
    ui.msg.tt = { text: e instanceof TypeError || e instanceof SyntaxError ? "NEIS에 연결하지 못했어요(네트워크 또는 브라우저 차단). 아래 직접 입력을 써 주세요." : "불러오지 못했어요: " + e.message, err: true };
    ui.open.add("manual");
  }
  ui.busy = false; render();
}

/* ---------- 8-5. 화면: 설정 ---------- */
/** 사용 기록 요약: 등록 수와 추천 완료율(완료한 추천 ÷ 받은 추천) */
function usageSummary() {
  const st = S.stats, days = Object.values(st.days);
  const shown = days.reduce((n, d) => n + d.shown, 0), done = days.reduce((n, d) => n + d.done, 0);
  return { events: st.events, exams: st.exams, tasks: st.tasks, days: days.length, aiDays: days.filter(d => d.source === "ai").length, shown, done, rate: shown ? Math.round(done / shown * 100) : 0 };
}
function usageCard() {
  const u = usageSummary();
  const cell = (label, value) => `<div class="stat"><b class="num">${value}</b><span class="sub">${label}</span></div>`;
  return `<div class="card"><h3>사용 기록</h3>
    <p class="sub">직접 등록한 수와 추천을 얼마나 따랐는지를 이 기기에만 기록해요. 예시·시연 데이터는 세지 않아요.</p>
    <div class="stats mt12">${cell("일정 등록", u.events)}${cell("시험 등록", u.exams)}${cell("할 일 등록", u.tasks)}${cell("추천 받은 날", u.days + "일")}${cell("받은 추천", u.shown)}${cell("추천 완료율", u.rate + "%")}</div>
    <div class="row wrap-x mt12"><button class="btn ghost sm" data-act="statcopy">기록 복사</button><button class="btn ghost sm" data-act="statreset">기록 지우기</button></div></div>`;
}
function viewSettings() {
  const g = S.settings.gemini, n = S.settings.neis;
  const note = k => ui.msg[k] ? `<div class="${ui.msg[k].err ? "msg-err" : "msg-ok"} full">${esc(ui.msg[k].text)}</div>` : "";
  return `<div class="set-grid">
  <div class="card"><h3>AI 추천 (Gemini 무료 API)</h3>
    <p class="sub">Google AI Studio(aistudio.google.com)에서 무료 API 키를 받아 넣으세요. 키는 이 기기 브라우저에만 저장돼요.</p>
    <form data-form="gset" class="form mt12">
      <label class="field full">API 키<input name="key" type="password" autocomplete="off" value="${esc(g.key)}" placeholder="${PRESET.geminiKey ? "(기본 키 있음 — 비워 두면 그대로 써요)" : "AIza..."}"></label>
      <label class="field full">모델<input name="model" value="${esc(g.model)}"></label>
      <button class="btn">저장</button><button type="button" class="btn ghost" data-act="gtest">연결 테스트</button>${note("g")}</form></div>

  <div class="card"><h3>학교 · 반 (시간표)</h3>
    <p class="sub">${esc(n.schoolName)} · 교육청 ${esc(n.office)} / 학교 ${esc(n.school)}</p>
    <form data-form="nset" class="form mt12">
      <label class="field">학년<input name="grade" type="number" min="1" max="3" value="${esc(n.grade)}"></label>
      <label class="field">반<input name="cls" type="number" min="1" max="30" value="${esc(n.cls)}"></label>
      <label class="field full">NEIS 인증키 (없으면 하루 5교시까지만 불러와져요)<input name="key" type="password" autocomplete="off" value="${esc(n.key)}" placeholder="${PRESET.neisKey ? "(기본 키 있음)" : ""}"></label>
      <button class="btn full">저장</button></form>
    <hr class="hr"><form data-form="sfind" class="row"><input name="name" placeholder="다른 학교 검색" required><button class="btn ghost">검색</button></form>${ui.msg.s ? `<div class="${ui.msg.s.err ? "msg-err" : "msg-ok"} mt8">${esc(ui.msg.s.text)}</div>` : ""}</div>

  <div class="card"><h3>데이터</h3>
    <div class="row wrap-x">
      <button class="btn ghost sm" data-act="export">내보내기</button>
      <label class="btn ghost sm">가져오기<input id="imp" type="file" accept="application/json" hidden></label>
      <button class="btn ghost sm" data-act="sample">예시 데이터 넣기</button>
      <button class="btn danger sm" data-act="reset">전체 초기화</button></div>
    <p class="sub mt8">내보내기 파일에는 API 키가 들어가지 않아요.</p>
    <hr class="hr"><h3>시연</h3>
    <p class="sub">수행평가 3개 · 시험 2개 · 예시 시간표를 한 번에 채워요.</p>
    <button class="btn honey mt8" data-act="demo">시연용 데이터 넣기</button></div>
  ${usageCard()}
  </div>`;
}

/* ---------- 9. 렌더 ---------- */
const VIEWS = { today: viewToday, cal: viewCal, exam: viewExam, tt: viewTimetable, set: viewSettings };
function renderNav() {
  $("#nav").innerHTML = TABS.map(([id, label]) => `<button type="button" data-act="tab" data-tab="${id}">${icon(id)}${label}</button>`).join("");
}
function render() {
  $("#app").innerHTML = VIEWS[ui.tab]();
  document.querySelectorAll("#nav button").forEach(b => { const on = b.dataset.tab === ui.tab; b.classList.toggle("on", on); if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  if (ui.tab === "today" && hasData()) autoRecommend();
}
/* ---------- 10-1. 예시 · 시연 데이터 ---------- */
function sampleEvents() {
  return [
    { id: uid(), title: "탐구보고서 제출", type: "perf", subject: "물리학", weight: 20, note: "", date: daysFromNow(3), done: false },
    { id: uid(), title: "영어 발표", type: "perf", subject: "영어", weight: 15, note: "", date: daysFromNow(6), done: false },
    { id: uid(), title: "수학 서술형 평가", type: "perf", subject: "수학", weight: 30, note: "", date: daysFromNow(10), done: false },
    { id: uid(), title: "야간 자습 장소 변경 안내", type: "info", subject: "", weight: "", note: "", date: daysFromNow(1), done: false }
  ];
}
function sampleExams() {
  return [
    { id: uid(), subject: "화학", date: daysFromNow(9), tasks: [{ id: uid(), text: "교과서 3단원 정리", min: 60, done: false }, { id: uid(), text: "문제집 1회독", min: 90, done: false }] },
    { id: uid(), subject: "한국사", date: daysFromNow(12), tasks: [{ id: uid(), text: "빈칸 프린트 암기", min: 40, done: false }] }
  ];
}
const SAMPLE_TIMETABLE = {
  1: ["수학", "물리학", "영어", "화학", "국어", "생명과학", "정보"],
  2: ["화학", "수학", "한국사", "영어", "물리학", "지구과학", "체육"],
  3: ["영어", "국어", "수학", "생명과학", "화학", "통합사회", "창체"],
  4: ["물리학", "수학", "지구과학", "국어", "영어", "한국사", "체육"],
  5: ["국어", "화학", "수학", "물리학", "정보", "영어", "동아리"]
};

/* ---------- 10-2. 버튼 동작 ---------- */
const ACTIONS = {
  tab: t => { ui.tab = t.dataset.tab; render(); window.scrollTo(0, 0); },

  // 일정
  quickadd: () => openDialog(`<h3>빠른 추가</h3><form data-form="quickadd" class="form">
      <label class="field full">제목<input name="title" placeholder="예: 물리 탐구보고서 제출" required autofocus></label>
      <label class="field">날짜<input name="date" type="date" value="${today()}" required></label>
      <label class="field">구분<select name="type">${typeOptions("perf")}</select></label>
      <button type="button" class="btn ghost" data-act="dlgclose">취소</button><button class="btn honey">추가</button></form>`),
  dlgclose: () => closeDialog(),
  selday: t => { ui.selDate = t.dataset.date; ui.editing = null; render(); },
  calprev: () => { ui.calM--; if (ui.calM < 0) { ui.calM = 11; ui.calY--; } render(); },
  calnext: () => { ui.calM++; if (ui.calM > 11) { ui.calM = 0; ui.calY++; } render(); },
  caltoday: () => { const n = new Date(); ui.calY = n.getFullYear(); ui.calM = n.getMonth(); ui.selDate = today(); ui.editing = null; render(); },
  evtoggle: t => { const e = S.events.find(e => e.id === t.dataset.id); if (e) { e.done = !e.done; save(); render(); } },
  evdel: t => { S.events = S.events.filter(e => e.id !== t.dataset.id); ui.editing = null; save(); render(); },
  evedit: t => { ui.editing = t.dataset.id; render(); },
  evcancel: () => { ui.editing = null; render(); },

  // 추천
  recgo: () => recommend(),
  rectoggle: t => {
    const it = S.ai.items[+t.dataset.i]; if (!it) return;
    const r = findRef(it.ref);
    if (r && r.type === "task") r.t.done = !r.t.done; else it.done = !it.done;
    save(); render();
  },

  // 시험
  examdel: t => { S.exams = S.exams.filter(x => x.id !== t.dataset.id); save(); render(); },
  tasktoggle: t => { const x = S.exams.find(x => x.id === t.dataset.x), k = x && x.tasks.find(k => k.id === t.dataset.t); if (k) { k.done = !k.done; save(); render(); } },
  taskdel: t => { const x = S.exams.find(x => x.id === t.dataset.x); if (x) { x.tasks = x.tasks.filter(k => k.id !== t.dataset.t); save(); render(); } },

  // 시간표
  ttprev: () => { ui.ttWeek.setDate(ui.ttWeek.getDate() - 7); render(); },
  ttnext: () => { ui.ttWeek.setDate(ui.ttWeek.getDate() + 7); render(); },
  tttoday: () => { ui.ttWeek = schoolWeek(); render(); },
  ttfetch: () => fetchTimetable(),

  // 설정
  gtest: async () => {
    const f = document.querySelector('[data-form="gset"]');
    if (f) { S.settings.gemini.key = f.key.value.trim(); S.settings.gemini.model = f.model.value.trim() || DEFAULT_MODEL; save(); }
    ui.msg.g = { text: "테스트 중…" }; render();
    try {
      const { model } = await askGemini('JSON 배열로 [{"ref":"","title":"연결 테스트","reason":"정상","minutes":5}] 만 그대로 출력해.');
      ui.msg.g = { text: model === S.settings.gemini.model ? `연결 성공 (${model})` : `연결 성공 — '${S.settings.gemini.model}' 모델이 없어 ${model}(으)로 대체했어요.` };
    } catch (e) { const hint = e.message === "NOKEY" ? " 키를 먼저 넣어 주세요." : ["KEY", "NOMODEL", "BAD", "FORMAT"].includes(e.message) ? " 키와 모델명을 확인해 주세요." : " 잠시 뒤 다시 눌러 주세요.";
      ui.msg.g = { text: aiErrorReason(e) + hint, err: true }; }
    render();
  },
  export: () => {
    const c = JSON.parse(JSON.stringify(S)); c.settings.gemini.key = ""; c.settings.neis.key = ""; c.ai = defaults().ai;
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(c, null, 1)], { type: "application/json" }));
    a.download = `jgcal-${today()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  reset: () => { if (confirm("모든 일정·시험·설정이 지워져요. 계속할까요?")) { localStorage.removeItem(STORE_KEY); S = defaults(); ui.msg = {}; render(); toast("초기화했어요"); } },
  statcopy: async () => {
    const u = usageSummary();
    const rows = Object.keys(S.stats.days).sort().map(k => `${k}\t${S.stats.days[k].shown}\t${S.stats.days[k].done}\t${S.stats.days[k].source === "ai" ? "AI" : "규칙"}`);
    const text = `[올인원 시험캘린더 사용 기록] ${today()} 기준\n일정 등록 ${u.events}건 · 시험 등록 ${u.exams}건 · 할 일 등록 ${u.tasks}건\n추천 받은 날 ${u.days}일(AI ${u.aiDays}일) · 받은 추천 ${u.shown}개 중 ${u.done}개 완료 (${u.rate}%)\n\n날짜\t추천 수\t완료 수\t방식\n${rows.join("\n")}`;
    try { await navigator.clipboard.writeText(text); toast("사용 기록을 복사했어요"); }
    catch (e) { openDialog(`<h3>사용 기록</h3><p class="sub" style="white-space:pre-wrap;user-select:all">${esc(text)}</p><button class="btn block" data-act="dlgclose">닫기</button>`); }
  },
  statreset: () => { if (confirm("사용 기록만 지워요. 일정과 시험은 그대로예요. 계속할까요?")) { S.stats = defaults().stats; save(); render(); toast("사용 기록을 지웠어요"); } },
  sample: () => { S.events.push(...sampleEvents()); S.exams.push(...sampleExams()); save(); render(); toast("예시 데이터를 넣었어요"); },
  demo: () => {
    if (hasData() && !confirm("지금 있는 일정·시험을 지우고 시연용 데이터로 바꿀까요?")) return;
    S.events = sampleEvents().filter(e => e.type === "perf");          // 수행평가 3
    S.exams = sampleExams();                                            // 시험 2
    if (!Object.values(S.tt.manual).some(day => Object.values(day || {}).some(Boolean))) {
      for (const wd in SAMPLE_TIMETABLE) { S.tt.manual[wd] = {}; SAMPLE_TIMETABLE[wd].forEach((s, i) => S.tt.manual[wd][i + 1] = s); }
    }
    S.ai = defaults().ai;
    save(); ui.tab = "today"; render(); window.scrollTo(0, 0); toast("시연용 데이터를 넣었어요");
  }
};
/* ---------- 10-3. 폼 제출 ---------- */
const FORMS = {
  quickadd(fd) {
    const title = fd.title.trim(); if (!title || !fd.date) return toast("제목과 날짜를 입력해 주세요");
    S.events.push({ id: uid(), done: false, title, type: fd.type, subject: "", weight: "", note: "", date: fd.date });
    S.stats.events++;
    ui.selDate = fd.date; const d = parse(fd.date); ui.calY = d.getFullYear(); ui.calM = d.getMonth();
    save(); closeDialog(); render(); toast("일정을 추가했어요");
  },
  addev(fd) {
    const o = { title: fd.title.trim(), type: fd.type, subject: (fd.subject || "").trim(), weight: fd.weight ? Number(fd.weight) : "", note: (fd.note || "").trim(), date: fd.date };
    if (!o.title || !o.date) return toast("제목과 날짜를 입력해 주세요");
    if (ui.editing) { const e = S.events.find(e => e.id === ui.editing); if (e) Object.assign(e, o); ui.editing = null; }
    else { S.events.push({ id: uid(), done: false, ...o }); S.stats.events++; }
    ui.selDate = o.date; const d = parse(o.date); ui.calY = d.getFullYear(); ui.calM = d.getMonth();
    save(); render(); toast("저장했어요");
  },
  addexam(fd) { S.exams.push({ id: uid(), subject: fd.subject.trim(), date: fd.date, tasks: [] }); S.stats.exams++; save(); render(); },
  addtask(fd, f) { const x = S.exams.find(x => x.id === f.dataset.x); if (!x) return; x.tasks.push({ id: uid(), text: fd.text.trim(), min: fd.min ? Number(fd.min) : 0, done: false }); S.stats.tasks++; save(); render(); },
  gset(fd) { S.settings.gemini.key = fd.key.trim(); S.settings.gemini.model = fd.model.trim() || DEFAULT_MODEL; save(); ui.msg.g = { text: "저장했어요" }; render(); },
  nset(fd) { Object.assign(S.settings.neis, { grade: Number(fd.grade) || 1, cls: Number(fd.cls) || 1, key: fd.key.trim() }); save(); toast("저장했어요"); render(); },
  async sfind(fd) {
    ui.msg.s = { text: "검색 중…" }; render();
    try {
      const q = new URLSearchParams({ Type: "json", pIndex: 1, pSize: 10, SCHUL_NM: fd.name.trim() }); if (neisKey()) q.set("KEY", neisKey());
      const j = await (await fetch("https://open.neis.go.kr/hub/schoolInfo?" + q)).json();
      const rows = j.schoolInfo && j.schoolInfo[1].row;
      if (!rows || !rows.length) throw new Error("검색 결과가 없어요");
      const r = rows.find(r => r.SCHUL_NM === fd.name.trim()) || rows[0];
      Object.assign(S.settings.neis, { office: r.ATPT_OFCDC_SC_CODE, school: r.SD_SCHUL_CODE, schoolName: r.SCHUL_NM }); save();
      ui.msg.s = { text: `${r.SCHUL_NM}(으)로 바꿨어요. 학년·반을 확인해 주세요.` };
    } catch (e) { ui.msg.s = { text: e instanceof TypeError || e instanceof SyntaxError ? "NEIS에 연결하지 못했어요." : e.message, err: true }; }
    render();
  }
};

/* ---------- 10-4. 이벤트 연결 ---------- */
document.addEventListener("click", e => {
  if (e.target.id === "dlg") {                       // 바깥(배경)을 누르면 닫기
    const r = e.target.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return closeDialog();
  }
  const t = e.target.closest("[data-act]");
  if (t && ACTIONS[t.dataset.act]) ACTIONS[t.dataset.act](t, e);
});
document.addEventListener("submit", e => {
  e.preventDefault();
  const f = e.target, fn = FORMS[f.dataset.form];
  if (fn) fn(Object.fromEntries(new FormData(f)), f);
});
document.addEventListener("change", e => {
  const t = e.target;
  if (t.dataset.ttwd) {                                   // 시간표 직접 입력
    const w = t.dataset.ttwd; (S.tt.manual[w] = S.tt.manual[w] || {})[t.dataset.ttp] = t.value.trim(); save();
  } else if (t.dataset.examdate) {                        // 시험 날짜 변경
    const x = S.exams.find(x => x.id === t.dataset.examdate); if (x && t.value) { x.date = t.value; save(); render(); }
  } else if (t.id === "imp" && t.files[0]) {              // 가져오기
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const j = JSON.parse(reader.result), keep = { g: S.settings.gemini.key, n: S.settings.neis.key };
        S = merge(defaults(), stripLegacy(j));
        if (!S.settings.gemini.key) S.settings.gemini.key = keep.g;
        if (!S.settings.neis.key) S.settings.neis.key = keep.n;
        save(); render(); toast("가져왔어요");
      } catch (err) { toast("파일을 읽지 못했어요"); }
    };
    reader.readAsText(t.files[0]);
  }
});
// 접기 영역을 펼쳤는지 기억해서 화면을 다시 그려도 유지
document.addEventListener("toggle", e => {
  const k = e.target.dataset && e.target.dataset.keep; if (!k) return;
  if (e.target.open) ui.open.add(k); else ui.open.delete(k);
}, true);

/* ---------- 11. 시작 ---------- */
renderNav();
render();
