import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, set, update, remove, onValue, runTransaction, onDisconnect,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

if (String(firebaseConfig.apiKey || "").startsWith("YOUR")) {
  document.getElementById("app").innerHTML =
    `<div class="loading">还没填 Firebase 配置：请先编辑 firebase-config.js</div>`;
  throw new Error("firebase-config.js 未配置");
}

const db = getDatabase(initializeApp(firebaseConfig));

/* =========================================================
   数据结构（Realtime Database）
   rooms/{CODE}
     hostId
     settings: { capacity: 2|3|4, seconds }
     players/{pid}: { name, joinedAt, online }
     game:
       phase: "lobby" | "guess" | "reveal" | "over"
       round, deadline, revealUntil, winRound, winWord
       rounds/r{n}: { words/{pid}: "词", participants: [pid], closed, matched }
   ========================================================= */

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const REVEAL_MS = 4000;      // 每轮揭晓停留时间
const MAX_WORD = 20;
const MAX_NAME = 12;
const TONES = ["purple", "orange", "teal", "pink"];
const COPY_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 5.5v-.5A2.5 2.5 0 0 0 13 2.5H7A2.5 2.5 0 0 0 4.5 5v6A2.5 2.5 0 0 0 7 13.5h.5"/></svg>`;
const HOME_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3.5 11 12 3.8 20.5 11"/><path d="M5.5 9.5V20h4.5v-5.5h4V20h4.5V9.5"/></svg>`;

/* ---------- 本地身份：不登录，用随机 id 认人 ---------- */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 隐私模式 */ } },
};
const myId = store.get("tcxj_pid") || (() => {
  const id = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
    : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  store.set("tcxj_pid", id);
  return id;
})();

/* ---------- 服务器时间（避免各人手机时间不准） ---------- */
let serverOffset = 0;
onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });
const now = () => Date.now() + serverOffset;

/* ---------- 运行状态 ---------- */
const app = document.getElementById("app");
const $ = (sel) => document.querySelector(sel);
let code = null;          // 当前房间码
let room = null;          // 最新房间数据
let roomUnsub = null;
let viewKey = "";         // 只有它变了才整页重画，避免打字时输入框被刷新
let presenceMode = null;  // "lobby" | "game"
let connected = false;
let rejoining = false;
let autoSubmitted = false;
const inflight = new Map();

/* ---------- 小工具 ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (w) => String(w || "").toLowerCase().replace(/[\s\p{P}]/gu, ""); // 比较时忽略大小写、空格、标点
const rk = (n) => `r${n}`; // 用 r1、r2 当键，避免 Firebase 把数字键转成数组
const asList = (x) => (Array.isArray(x) ? x : Object.values(x || {})).filter((v) => v != null); // 数组读回来可能是对象
const toneOf = (i) => TONES[Math.max(0, i) % TONES.length];
const avatar = (i, size = "") => `<span class="avatar tone-${toneOf(i)} ${size}">${Math.max(0, i) + 1}</span>`;

function genCode() {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function playerList(r = room) {
  return Object.entries(r?.players || {})
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0) || a.id.localeCompare(b.id));
}
const activePlayers = () => playerList().filter((p) => p.online !== false);

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* 走下面的兜底 */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { /* ignore */ }
  ta.remove();
  return ok;
}

function topbar(title) {
  return `<header class="topbar">
    <button class="icon-btn" id="leave" aria-label="离开房间">${HOME_SVG}</button>
    <h1>${title}</h1>
    <span class="code-tag">${esc(code)}</span>
  </header>`;
}

/* =========================================================
   首页
   ========================================================= */
function renderHome(prefill = "", error = "") {
  stopRoom();
  viewKey = "home";
  history.replaceState(null, "", location.pathname);
  const name = store.get("tcxj_name") || "";
  app.innerHTML = `
  <header class="topbar"><span></span><h1>同词相见</h1><span></span></header>
  <main class="page">
    <section class="hero">
      <h2>想到同一个词，<br>就算相见</h2>
      <p>每人写一个词，没对上就从大家的词里继续联想，<br>直到所有人写出同一个词。</p>
    </section>
    <section class="card form">
      <label class="label" for="name">你的昵称</label>
      <input id="name" class="input" maxlength="${MAX_NAME}" placeholder="朋友们会看到这个名字" value="${esc(name)}" autocomplete="nickname">
      <label class="label spaced" for="code">加入朋友的房间</label>
      <div class="join-row">
        <input id="code" class="input code-input" maxlength="6" placeholder="6 位房间码" value="${esc(prefill)}" autocapitalize="characters" autocomplete="off">
        <button id="join" class="btn primary">加入</button>
      </div>
      <p class="error" id="err">${esc(error)}</p>
      <div class="divider"><span>或者</span></div>
      <button id="create" class="btn primary block">创建新房间</button>
    </section>
  </main>`;

  $("#create").onclick = () => { const n = readName(); if (n) createRoom(n); };
  $("#join").onclick = () => {
    const n = readName();
    if (!n) return;
    const c = $("#code").value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(c)) return showErr("房间码是 6 位字母或数字");
    joinRoom(c, n);
  };
  $("#code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#join").click(); });
}

function readName() {
  const n = $("#name").value.trim().slice(0, MAX_NAME);
  if (!n) { showErr("先起个昵称吧"); $("#name").focus(); return null; }
  store.set("tcxj_name", n);
  return n;
}
function showErr(m) { const e = $("#err"); if (e) e.textContent = m; }
function setBusy(b) { document.querySelectorAll("#create, #join").forEach((x) => { x.disabled = b; }); }

/* =========================================================
   建房 / 加入 / 离开
   ========================================================= */
async function createRoom(name) {
  setBusy(true);
  try {
    for (let i = 0; i < 5; i++) {
      const c = genCode();
      const t = now();
      const res = await runTransaction(ref(db, `rooms/${c}`), (cur) => {
        if (cur !== null) return; // 房间码撞了，放弃这次
        return {
          hostId: myId,
          createdAt: t,
          settings: { capacity: 2, seconds: 30 },
          players: { [myId]: { name, joinedAt: t, online: true } },
          game: { phase: "lobby", round: 0 },
        };
      });
      if (res.committed) return enterRoom(c);
    }
    showErr("创建失败，请重试");
  } catch (e) {
    console.error(e);
    showErr("连不上服务器：" + e.message);
  } finally {
    setBusy(false);
  }
}

async function joinRoom(c, name) {
  setBusy(true);
  try {
    const t = now();
    const res = await runTransaction(ref(db, `rooms/${c}`), (cur) => {
      if (cur === null) return null; // 本地还没数据，交给服务器再算一次
      const players = cur.players || {};
      if (players[myId]) {
        players[myId].name = name;      // 断线重连 / 刷新页面
        players[myId].online = true;
      } else {
        if (cur.game?.phase !== "lobby") return;
        if (Object.keys(players).length >= (cur.settings?.capacity || 2)) return;
        players[myId] = { name, joinedAt: t, online: true };
      }
      cur.players = players;
      return cur;
    });
    const val = res.snapshot.val();
    if (!val) return renderHome(c, "房间不存在，检查一下房间码");
    if (!res.committed || !val.players?.[myId]) {
      return renderHome(c, val.game?.phase !== "lobby" ? "这局已经开始了，等下一局吧" : "房间已经满了");
    }
    if (code !== c) enterRoom(c);
  } catch (e) {
    console.error(e);
    renderHome(c, "连不上服务器：" + e.message);
  } finally {
    setBusy(false);
  }
}

function enterRoom(c) {
  stopRoom();
  code = c;
  viewKey = "";
  presenceMode = null;
  history.replaceState(null, "", `${location.pathname}?room=${c}`);
  app.innerHTML = `<div class="loading">进入房间…</div>`;
  roomUnsub = onValue(ref(db, `rooms/${c}`), (snap) => {
    room = snap.val();
    onRoom();
  }, (err) => {
    console.error(err);
    toast("读取房间失败");
  });
}

function stopRoom() {
  if (roomUnsub) roomUnsub();
  roomUnsub = null;
  room = null;
  code = null;
}

async function leaveRoom() {
  const c = code;
  const phase = room?.game?.phase;
  if (phase === "guess" || phase === "reveal") {
    if (!confirm("离开后这局会把你当作离线，确定吗？")) return;
  }
  const others = playerList().filter((p) => p.id !== myId);
  stopRoom(); // 先停监听，免得看到自己被移除又自动重进
  const pRef = ref(db, `rooms/${c}/players/${myId}`);
  try {
    await onDisconnect(pRef).cancel();
    if (phase === "lobby") {
      await (others.length ? remove(pRef) : remove(ref(db, `rooms/${c}`)));
    } else {
      await set(ref(db, `rooms/${c}/players/${myId}/online`), false);
    }
  } catch (e) { console.warn(e); }
  renderHome();
}

/* =========================================================
   在线状态：大厅里掉线 = 退出房间；游戏中掉线 = 标记离线
   ========================================================= */
onValue(ref(db, ".info/connected"), (s) => {
  connected = s.val() === true;
  if (connected) {
    presenceMode = null; // 重连后 onDisconnect 需要重新挂
    if (room && code) onRoom();
  }
});

function syncPresence() {
  if (!connected) return;
  const mode = room.game?.phase === "lobby" ? "lobby" : "game";
  if (mode === presenceMode) return;
  presenceMode = mode;
  const pRef = ref(db, `rooms/${code}/players/${myId}`);
  const oRef = ref(db, `rooms/${code}/players/${myId}/online`);
  if (mode === "lobby") {
    onDisconnect(oRef).cancel();
    onDisconnect(pRef).remove();
  } else {
    onDisconnect(pRef).cancel();
    onDisconnect(oRef).set(false);
  }
  if (room.players[myId].online === false) set(oRef, true);
}

// 房主离开时，最早进来且在线的人接任
function fixHost() {
  const cands = activePlayers();
  if (!cands.some((p) => p.id === room.hostId) && cands[0]?.id === myId) {
    set(ref(db, `rooms/${code}/hostId`), myId);
  }
}

/* =========================================================
   收到房间数据
   ========================================================= */
function onRoom() {
  if (!room) {
    renderHome("", "房间已经不存在了");
    return;
  }
  if (!room.players?.[myId]) {
    if (rejoining) return;
    if (room.game?.phase === "lobby") {
      rejoining = true;
      joinRoom(code, store.get("tcxj_name") || "玩家").finally(() => { rejoining = false; });
    } else {
      renderHome("", "你已经不在这个房间里了");
    }
    return;
  }
  syncPresence();
  fixHost();
  render();
}

function render() {
  const g = room.game || { phase: "lobby" };
  const mine = g.rounds?.[rk(g.round)]?.words?.[myId];
  let key;
  if (g.phase === "lobby") key = "lobby:" + JSON.stringify([room.players, room.settings, room.hostId]);
  else if (g.phase === "over") key = `over:${g.round}:${g.winRound}:${room.hostId}`;
  else key = `game:${g.phase}:${g.round}:${mine != null}:${room.hostId}`;

  if (key !== viewKey) {
    viewKey = key;
    if (g.phase === "lobby") renderLobby();
    else if (g.phase === "over") renderOver();
    else { autoSubmitted = false; renderGame(); }
    $("#leave")?.addEventListener("click", leaveRoom);
  }
  updateDynamic();
}

/* =========================================================
   房间页（大厅）
   ========================================================= */
function renderLobby() {
  const list = playerList();
  const cap = room.settings?.capacity || 2;
  const secs = room.settings?.seconds || 30;
  const host = room.hostId === myId;
  const full = list.length >= cap;

  const tiles = [];
  for (let i = 0; i < Math.max(cap, list.length); i++) {
    const p = list[i];
    tiles.push(p ? `
      <div class="tile ${p.online === false ? "is-off" : ""}">
        ${p.id === room.hostId ? `<span class="tag">房主</span>` : ""}
        ${avatar(i)}
        <div class="tile-name">${esc(p.name)}${p.id === myId ? "（你）" : ""}</div>
        <div class="tile-sub">${p.online === false ? "已离线" : "已就位"}</div>
      </div>` : `
      <div class="tile is-empty">
        <span class="avatar empty">${i + 1}</span>
        <div class="tile-name">等待加入</div>
        <div class="tile-sub">把房间码发给朋友</div>
      </div>`);
  }

  const capSeg = [2, 3, 4].map((n) =>
    `<button class="seg-btn ${n === cap ? "on" : ""}" data-cap="${n}" ${!host || n < list.length ? "disabled" : ""}>${n} 人</button>`).join("");
  const custom = secs !== 30 && secs !== 60;
  const timeSeg = [
    `<button class="seg-btn ${secs === 30 ? "on" : ""}" data-secs="30" ${host ? "" : "disabled"}>30 秒</button>`,
    `<button class="seg-btn ${secs === 60 ? "on" : ""}" data-secs="60" ${host ? "" : "disabled"}>60 秒</button>`,
    `<button class="seg-btn ${custom ? "on" : ""}" data-secs="custom" ${host ? "" : "disabled"}>${custom ? `自定义 · ${secs}秒` : "自定义"}</button>`,
  ].join("");

  let sub;
  if (!full) sub = `把房间码 <b>${esc(code)}</b><button class="copy-inline" id="copyInline" aria-label="复制房间码">${COPY_SVG}</button>发给朋友，还差 ${cap - list.length} 人`;
  else sub = host ? "大家已就位，点击下方按钮开始联想。" : "大家已就位，等房主开始。";

  app.innerHTML = `
  ${topbar("同词相见 · 房间")}
  <main class="page">
    <section class="hero">
      <h2>${full ? "朋友到齐了！" : "等朋友加入…"}</h2>
      <p>${sub}</p>
    </section>

    <section class="card">
      <div class="card-head"><h3>房间里的朋友</h3><span class="pill">${list.length} / ${cap} 人</span></div>
      <div class="player-grid">${tiles.join("")}</div>
      <div class="btn-row">
        <button class="btn soft" id="copyCode">复制房间码</button>
        <button class="btn primary" id="share">邀请好友</button>
      </div>
    </section>

    <section class="card">
      <h3 class="sub-title">房间人数</h3>
      <div class="seg ${host ? "" : "readonly"}">${capSeg}</div>
      <h3 class="sub-title">每轮思考时间</h3>
      <div class="seg ${host ? "" : "readonly"}">${timeSeg}</div>
      <p class="hint">每轮 ${secs} 秒 · 全员到齐才能开始${host ? "" : " · 只有房主能改设置"}</p>
    </section>

    <div class="cta">
      ${host
        ? `<button class="btn primary big" id="start" ${full && list.length >= 2 ? "" : "disabled"}>${full ? "开始游戏" : `还差 ${cap - list.length} 人`}</button>`
        : `<button class="btn primary big" disabled>等待房主开始</button>`}
    </div>
  </main>`;

  const copyCode = async () => toast((await copyText(code)) ? `房间码 ${code} 已复制` : "复制失败，请手动记下房间码");
  $("#copyCode").onclick = copyCode;
  $("#copyInline")?.addEventListener("click", copyCode);
  $("#share").onclick = shareInvite;
  app.querySelectorAll("[data-cap]").forEach((b) => {
    b.onclick = () => update(ref(db, `rooms/${code}/settings`), { capacity: Number(b.dataset.cap) });
  });
  app.querySelectorAll("[data-secs]").forEach((b) => {
    b.onclick = () => {
      let v = b.dataset.secs;
      if (v === "custom") {
        const input = prompt("每轮思考时间（10–300 秒）", String(secs));
        if (input === null) return;
        v = parseInt(input, 10);
        if (!(v >= 10 && v <= 300)) return toast("请输入 10 到 300 之间的整数");
      }
      update(ref(db, `rooms/${code}/settings`), { seconds: Number(v) });
    };
  });
  $("#start")?.addEventListener("click", startGame);
}

async function shareInvite() {
  const url = `${location.origin}${location.pathname}?room=${code}`;
  const text = `来和我玩「同词相见」，房间码 ${code}`;
  if (navigator.share) {
    try { await navigator.share({ title: "同词相见", text, url }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  toast((await copyText(`${text}\n${url}`)) ? "邀请链接已复制，发给朋友吧" : "复制失败");
}

async function startGame() {
  const secs = room.settings?.seconds || 30;
  const t = now();
  await runTransaction(ref(db, `rooms/${code}/game`), (g) => {
    if (g === null) return null;
    if (g.phase !== "lobby") return;
    return { phase: "guess", round: 1, deadline: t + secs * 1000, startedAt: t };
  });
}

/* =========================================================
   猜词页
   ========================================================= */
function renderGame() {
  const g = room.game;
  const n = g.round;
  const list = playerList();
  const idx = (id) => list.findIndex((p) => p.id === id);
  const cur = g.rounds?.[rk(n)] || {};
  const prev = g.rounds?.[rk(n - 1)];
  const mine = cur.words?.[myId];
  const host = room.hostId === myId;

  let top;
  if (g.phase === "reveal") {
    top = `<p class="prompt">第 ${n} 轮揭晓</p>${revealBlock(cur, list)}
           <p class="next" id="next"></p>`;
  } else {
    let prompt;
    if (n === 1) {
      prompt = `<p class="prompt">第一轮：写下你脑子里冒出来的第一个词</p>`;
    } else {
      const ids = prev?.participants ? asList(prev.participants) : Object.keys(prev?.words || {});
      const chips = ids.map((id) => {
        const w = prev?.words?.[id];
        return w ? `<span class="chip tone-${toneOf(idx(id))}">${esc(w)}</span>` : "";
      }).join("");
      prompt = `<p class="prompt">上一轮大家写的是</p>
        <div class="chips">${chips || `<span class="muted small">（上一轮没人写）</span>`}</div>
        <p class="prompt after">想一个能同时联系上这些词的新词</p>`;
    }
    const body = mine != null
      ? `<div class="locked"><span class="muted small">你写的是</span><strong>${esc(mine)}</strong><span class="muted small" id="waitText">等待中…</span></div>`
      : `<form id="guess" class="guess-form" autocomplete="off">
           <input id="word" class="input big" maxlength="${MAX_WORD}" placeholder="输入一个词" enterkeyhint="send">
           <button class="btn primary" type="submit">提交</button>
         </form>
         <p class="error" id="err"></p>`;
    top = prompt + body;
  }

  app.innerHTML = `
  ${topbar(`同词相见 · 第 ${n} 轮`)}
  <main class="page">
    <section class="card">
      <div class="round-head">
        <span class="pill">${g.phase === "reveal" ? "揭晓" : "思考中"}</span>
        <span class="timer" id="timer"></span>
      </div>
      <div class="bar"><div class="bar-fill" id="bar"></div></div>
      ${top}
    </section>

    ${historyCard(g, list)}

    ${host ? `<div class="cta"><button class="btn ghost" id="giveup">结束本局</button></div>` : ""}
  </main>`;

  const form = $("#guess");
  if (form) {
    form.addEventListener("submit", (e) => { e.preventDefault(); submitWord(false); });
    $("#word").focus();
  }
  $("#giveup")?.addEventListener("click", giveUp);
}

function revealBlock(r, list) {
  const ids = r.participants ? asList(r.participants) : Object.keys(r.words || {});
  const counts = {};
  ids.forEach((id) => { const k = norm(r.words?.[id]); if (k) counts[k] = (counts[k] || 0) + 1; });
  return `<div class="reveal">${ids.map((id) => {
    const i = list.findIndex((p) => p.id === id);
    const w = r.words?.[id];
    const hit = w && counts[norm(w)] > 1; // 部分人撞上了，高亮一下
    return `<div class="reveal-item ${hit ? "hit" : ""}">
      ${avatar(i, "sm")}
      <span class="reveal-name">${esc(list[i]?.name || "?")}</span>
      <span class="reveal-word">${w ? esc(w) : `<span class="muted small">超时</span>`}</span>
    </div>`;
  }).join("")}</div>`;
}

// 每轮大家写了什么；newestFirst 时最新一轮在最上面
function roundsList(g, list, newestFirst) {
  const done = [];
  for (let k = 1; k <= (g.round || 0); k++) {
    const r = g.rounds?.[rk(k)];
    if (r?.closed) done.push([k, r]);
  }
  if (newestFirst) done.reverse();
  const cols = list.map(() => "minmax(0, 1fr)").join(" 22px ");
  const legend = `<div class="legend">${list.map((p, i) =>
    `<span class="legend-item">${avatar(i, "xs")}${esc(p.name)}</span>`).join("")}</div>`;
  const rows = done.map(([k, r]) => {
    const ids = asList(r.participants);
    const cells = list.map((p, i) => {
      const w = r.words?.[p.id];
      const word = w ? esc(w) : `<span class="muted small">${ids.includes(p.id) ? "超时" : "—"}</span>`;
      return `<div class="word-tile tone-${toneOf(i)}">${word}</div>`;
    });
    const sep = `<span class="sep ${r.matched ? "ok" : ""}">${r.matched ? "✓" : "×"}</span>`;
    return `<div class="round-row">
      <div class="round-label">第 ${k} 轮</div>
      <div class="round-words" style="grid-template-columns:${cols}">${cells.join(sep)}</div>
    </div>`;
  }).join("");
  return { count: done.length, html: legend + rows };
}

function historyCard(g, list) {
  const { count, html } = roundsList(g, list, true);
  if (!count) {
    return `<section class="card">
      <div class="card-head"><h3>对局记录</h3></div>
      <p class="muted small" style="margin:0">每一轮揭晓后，大家写的词会记在这里。</p>
    </section>`;
  }
  return `<section class="card">
    <div class="card-head"><h3>对局记录</h3><span class="pill">${count} 轮</span></div>
    ${html}
  </section>`;
}

// 不整页重画的部分：状态列表、计时器
function updateDynamic() {
  const g = room?.game;
  if (!g || (g.phase !== "guess" && g.phase !== "reveal")) return;
  const wt = $("#waitText");
  if (wt) {
    const words = g.rounds?.[rk(g.round)]?.words || {};
    const pending = activePlayers().filter((p) => p.id !== myId && words[p.id] == null);
    if (!pending.length) wt.textContent = "马上揭晓…";
    else if (playerList().length === 2) wt.textContent = "等待中… 对方还没写好";
    else wt.textContent = `等待中… ${pending.map((p) => p.name).join("、")} 还没写好`;
  }
  tick();
}

function tick() {
  const g = room?.game;
  if (!g) return;
  if (g.phase === "guess") {
    const total = (room.settings?.seconds || 30) * 1000;
    const left = Math.max(0, (g.deadline || 0) - now());
    const t = $("#timer");
    if (t) {
      t.textContent = `${Math.ceil(left / 1000)} 秒`;
      t.classList.toggle("urgent", left < 5000);
    }
    const b = $("#bar");
    if (b) b.style.width = `${Math.min(100, (left / total) * 100)}%`;
    // 时间快到时，把已经打好但没点提交的词自动交上去
    const inp = $("#word");
    if (inp && left < 600 && !autoSubmitted && inp.value.trim()) {
      autoSubmitted = true;
      submitWord(true);
    }
  } else if (g.phase === "reveal") {
    const left = Math.max(0, (g.revealUntil || 0) - now());
    const nx = $("#next");
    if (nx) nx.textContent = `没对上，${Math.ceil(left / 1000)} 秒后进入第 ${g.round + 1} 轮`;
    const b = $("#bar");
    if (b) b.style.width = `${(left / REVEAL_MS) * 100}%`;
  }
  drive();
}
setInterval(() => { if (room && code) tick(); }, 250);

/* =========================================================
   轮次推进：任何一个客户端发现条件满足都会尝试推进，
   用事务保证同一轮只推进一次
   ========================================================= */
function drive() {
  const g = room?.game;
  if (!g) return;
  if (g.phase === "guess") {
    const act = activePlayers();
    const words = g.rounds?.[rk(g.round)]?.words || {};
    const allIn = act.length > 0 && act.every((p) => words[p.id] != null);
    if (allIn || now() >= g.deadline) once(`close:${g.round}`, () => closeRound(g.round));
  } else if (g.phase === "reveal" && now() >= (g.revealUntil || 0)) {
    once(`next:${g.round}`, () => nextRound(g.round));
  }
}

function once(key, fn) {
  const k = `${code}:${key}`;
  const t = inflight.get(k);
  if (t && Date.now() - t < 3000) return;
  inflight.set(k, Date.now());
  fn().catch((e) => console.warn(e));
}

function closeRound(n) {
  const act = activePlayers().map((p) => p.id);
  const t = now();
  return runTransaction(ref(db, `rooms/${code}/game`), (g) => {
    if (g === null) return null;
    if (g.phase !== "guess" || g.round !== n) return; // 别人已经推进过了
    g.rounds = g.rounds || {};
    const r = (g.rounds[rk(n)] = g.rounds[rk(n)] || {});
    const words = r.words || {};
    const ids = act.length ? act : Object.keys(words);
    const first = norm(words[ids[0]]);
    const matched = ids.length >= 2 && first !== "" && ids.every((id) => norm(words[id]) === first);
    r.participants = ids;
    r.closed = true;
    r.matched = matched;
    if (matched) {
      g.phase = "over";
      g.winRound = n;
      g.winWord = words[ids[0]];
      g.endedAt = t;
    } else {
      g.phase = "reveal";
      g.revealUntil = t + REVEAL_MS;
    }
    return g;
  });
}

function nextRound(n) {
  const secs = room.settings?.seconds || 30;
  const t = now();
  return runTransaction(ref(db, `rooms/${code}/game`), (g) => {
    if (g === null) return null;
    if (g.phase !== "reveal" || g.round !== n) return;
    g.phase = "guess";
    g.round = n + 1;
    g.deadline = t + secs * 1000;
    delete g.revealUntil;
    return g;
  });
}

async function submitWord(auto) {
  const inp = $("#word");
  const g = room?.game;
  if (!inp || !g || g.phase !== "guess") return;
  const err = (m) => { if (!auto) { const e = $("#err"); if (e) e.textContent = m; } };

  const w = inp.value.trim().replace(/\s+/g, " ").slice(0, MAX_WORD);
  const k = norm(w);
  if (!k) return err("写一个词再提交");

  const used = new Set();
  for (let i = 1; i < g.round; i++) {
    Object.values(g.rounds?.[rk(i)]?.words || {}).forEach((x) => used.add(norm(x)));
  }
  if (used.has(k)) return err(`「${w}」之前出现过了，换一个`);
  if (now() > g.deadline + 1500) return;

  const btn = $("#guess button");
  if (btn) btn.disabled = true;
  try {
    await set(ref(db, `rooms/${code}/game/rounds/${rk(g.round)}/words/${myId}`), w);
  } catch (e) {
    console.error(e);
    if (btn) btn.disabled = false;
    err("提交失败，再试一次");
  }
}

async function giveUp() {
  if (!confirm("结束这一局？")) return;
  await runTransaction(ref(db, `rooms/${code}/game`), (g) => {
    if (g === null) return null;
    if (g.phase !== "guess" && g.phase !== "reveal") return;
    g.phase = "over";
    g.winRound = null;
    g.winWord = null;
    g.endedAt = Date.now() + serverOffset;
    return g;
  });
}

/* =========================================================
   结果页
   ========================================================= */
function renderOver() {
  const g = room.game;
  const list = playerList();
  const host = room.hostId === myId;
  let rounds = 0;
  for (let k = 1; k <= (g.round || 0); k++) if (g.rounds?.[rk(k)]?.closed) rounds++;

  const date = new Date(g.endedAt || g.startedAt || now()).toLocaleDateString("zh-CN");
  const hero = g.winRound
    ? `<h2>你们的脑回路相遇了</h2>
       <p>用了 ${g.winRound} 轮，我们都想到了「${esc(g.winWord)}」</p>`
    : `<h2>这局没能相遇</h2>
       <p>一共联想了 ${rounds} 轮，换个起点再来一次？</p>`;

  app.innerHTML = `
  ${topbar("同词相见 · 结果")}
  <main class="page">
    <section class="hero result">
      ${hero}
      <p class="meta">房间 ${esc(code)} · 共 ${rounds} 轮 · ${date}</p>
    </section>
    <section class="rounds-plain">${roundsList(g, list, false).html}</section>
    <div class="cta stack">
      ${host
        ? `<button class="btn primary big" id="again">再来一局</button>`
        : `<p class="muted small center">等房主开始下一局</p>`}
      <button class="btn soft big" id="home">返回首页</button>
    </div>
  </main>`;

  $("#again")?.addEventListener("click", playAgain);
  $("#home").addEventListener("click", leaveRoom);
}

async function playAgain() {
  const updates = { game: { phase: "lobby", round: 0 } };
  playerList().forEach((p) => { if (p.online === false) updates[`players/${p.id}`] = null; });
  await update(ref(db, `rooms/${code}`), updates);
}

/* =========================================================
   启动：链接里带房间码且有昵称就直接进
   ========================================================= */
const urlCode = (new URLSearchParams(location.search).get("room") || "").toUpperCase();
const savedName = store.get("tcxj_name");
if (/^[A-Z0-9]{6}$/.test(urlCode) && savedName) joinRoom(urlCode, savedName);
else renderHome(urlCode);
