const SUBS = ["VitaPiracy","vitahacks","PSVitaHomebrew"];
const COLORS = {VitaPiracy:"var(--c2)", vitahacks:"var(--c3)", PSVitaHomebrew:"var(--c1)"};
const TOPICS = {
  Port:      /\b(port|ported|porting)\b/i,
  Homebrew:  /\b(homebrew|vpk|vitashell|henkaku|enso|taihen)\b/i,
  Game:      /\b(game|games|rom|remake|demo|release)\b/i,
  App:       /\b(app|apps|tool|plugin|emulator|launcher|manager|update|v\d+(\.\d+)+)\b/i,
};
const NEWS_RE = /\b(port|ported|new|release|released|update|updated|v\d+(\.\d+)+|homebrew|plugin|app|game|emulator|vpk|beta)\b/i;

const state = { subs:new Set(SUBS), tags:new Set(), posts:[] };
const $ = id => document.getElementById(id);

function mkChip(parent, label, set, key, color){
  const b = document.createElement("button");
  b.className = "chip"; b.type = "button";
  b.textContent = label;
  b.setAttribute("aria-pressed", set.has(key));
  b.onclick = () => {
    set.has(key) ? set.delete(key) : set.add(key);
    b.setAttribute("aria-pressed", set.has(key));
    render();
  };
  parent.appendChild(b);
}
SUBS.forEach(s => mkChip($("subs"), "r/"+s, state.subs, s));
Object.keys(TOPICS).forEach(t => mkChip($("tags"), t, state.tags, t));
state.tags.clear();
$("tags").querySelectorAll(".chip").forEach(b => b.setAttribute("aria-pressed","false"));

function ago(ts){
  const s = Math.max(1, Date.now()/1000 - ts);
  const u = [[86400,"d"],[3600,"h"],[60,"m"]];
  for(const [n,l] of u) if(s >= n) return Math.floor(s/n)+l+" ago";
  return "just now";
}
function topicsOf(p){
  const text = p.title + " " + (p.flair||"");
  return Object.keys(TOPICS).filter(t => TOPICS[t].test(text));
}

/* Reddit blocks many direct browser requests, so try several routes in turn */
function proxyRoutes(){
  const r = [];
  if(/^https?:$/.test(location.protocol)) r.push(["local", u => "/proxy?url=" + encodeURIComponent(u)]);
  let c = ""; try{ c = localStorage.getItem("vitaproxy") || ""; }catch(e){}
  if(c) r.push(["custom", u => c.includes("{url}") ? c.replace("{url}", encodeURIComponent(u)) : c + encodeURIComponent(u)]);
  r.push(["direct", u => u]);
  r.push(["corsproxy", u => "https://corsproxy.io/?url=" + encodeURIComponent(u)]);
  r.push(["allorigins", u => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u)]);
  return r;
}
async function getJSON(url){
  const routes = proxyRoutes();
  const waits = [0, 1400, 3600, 7000];
  let last;
  routes.sort((a, b) => (b[0] === state.route) - (a[0] === state.route));
  for(const waitMs of waits){
    if(waitMs) await sleep(waitMs);
    for(const [name, build] of routes){
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 9000);
      try{
        const r = await fetch(build(url), {signal: ctl.signal});
        if(r.status === 429) throw new Error("HTTP 429");
        if(!r.ok) throw new Error("HTTP " + r.status);
        const j = JSON.parse(await r.text());
        if(!j.data || !j.data.children) throw new Error("bad data");
        state.route = name;
        return j;
      }catch(e){ last = e; /* try next route / next wait */ }
      finally{ clearTimeout(t); }
    }
  }
  throw last || new Error("all routes failed");
}
const REDDIT = sub => `https://www.reddit.com/r/${sub}/new.json?limit=50&raw_json=1`;
const REDDIT_MULTI = `https://www.reddit.com/r/${SUBS.join("+")}/new.json?limit=150&raw_json=1`;
function mapPost(d, sub){
  return {
    id:d.id, sub, title:d.title, flair:d.link_flair_text, score:d.score,
    comments:d.num_comments, created:d.created_utc, author:d.author,
    permalink:"https://www.reddit.com"+d.permalink,
    link: d.is_self ? null : d.url, domain: d.domain,
    thumb: /^https?:/.test(d.thumbnail||"") ? d.thumbnail : null
  };
}
async function timed(url, ms){
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms || 9000);
  try{
    const r = await fetch(url, {signal:c.signal});
    if(!r.ok) throw new Error("HTTP " + r.status);
    return r;
  } finally { clearTimeout(t); }
}
/* 1) posts.json, refreshed automatically by the GitHub Action (same site, so no blocking) */
async function fromFile(){
  const j = await (await timed("posts.json?t=" + Date.now(), 6000)).json();
  return (j && j.posts && j.posts.length) ? j : null;
}
function parseListing(j, fallbackSub){
  if(!j || !j.data || !j.data.children) throw new Error("Unexpected reply");
  return j.data.children
    .map(c => c.data)
    .filter(d => !d.stickied)
    .map(d => mapPost(d, d.subreddit || fallbackSub));
}
function decodeHtml(s){
  const t = document.createElement("textarea");
  t.innerHTML = s || "";
  return t.value;
}
function parseAtomListing(xml, sub){
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const entries = [...doc.querySelectorAll("entry")];
  return entries.map(e => {
    const txt = q => (e.querySelector(q)?.textContent || "").trim();
    const link = e.querySelector("link")?.getAttribute("href") || "";
    const id = txt("id").replace(/^.*t3_/, "");
    const created = Date.parse(txt("updated") || txt("published")) / 1000;
    const author = txt("author > name").replace(/^\/?u\//i, "");
    const thumb = e.querySelector("media\\:thumbnail, thumbnail")?.getAttribute("url") || null;
    return {
      id,
      sub,
      title: decodeHtml(txt("title")),
      flair: null,
      score: null,
      comments: null,
      created: Number.isFinite(created) ? created : Math.floor(Date.now()/1000),
      author,
      permalink: link,
      link: null,
      domain: "reddit.com",
      thumb
    };
  }).filter(p => p.id && p.title);
}
async function fromRedditRss(sub){
  const waits = [0, 1400, 3600, 7000];
  const url = `https://www.reddit.com/r/${sub}/new/.rss?limit=50`;
  let last;
  for(const waitMs of waits){
    if(waitMs) await sleep(waitMs);
    const routes = proxyRoutes();
    routes.sort((a, b) => (b[0] === state.route) - (a[0] === state.route));
    for(const [name, build] of routes){
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 9000);
      try{
        const r = await fetch(build(url), {signal: ctl.signal});
        if(r.status === 429) throw new Error("HTTP 429");
        if(!r.ok) throw new Error("HTTP " + r.status);
        const text = await r.text();
        if(!/<feed[\s>]/i.test(text)) throw new Error("bad rss");
        state.route = name;
        const posts = parseAtomListing(text, sub);
        if(posts.length) return posts;
      }catch(e){ last = e; }
      finally{ clearTimeout(t); }
    }
  }
  throw last || new Error("rss failed");
}
/* 2) live from Reddit, directly or through public relays (backup) */
async function fromReddit(sub){
  try{
    const j = await getJSON(REDDIT(sub));
    return parseListing(j, sub);
  }catch(e){
    return fromRedditRss(sub);
  }
}
async function fromRedditCombined(){
  const j = await getJSON(REDDIT_MULTI);
  return parseListing(j, "").filter(p => SUBS.includes(p.sub));
}
function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}
function missingSubs(posts){
  const have = new Set((posts || []).map(p => p.sub));
  return SUBS.filter(s => !have.has(s));
}
function mergePosts(a, b){
  const out = new Map();
  [...(a || []), ...(b || [])].forEach(p => {
    if(!p || !p.id || !p.sub) return;
    out.set(`${p.sub}:${p.id}`, p);
  });
  return [...out.values()].sort((x, y) => y.created - x.created);
}

async function load(){
  $("status").className = "status";
  $("status").textContent = "Loading...";
  let posts = [], src = "";
  try{
    const f = await fromFile();
    if(f){
      posts = f.posts;
      const mins = Math.max(0, Math.round((Date.now() - f.updated) / 60000));
      src = "refreshed " + (mins < 60 ? mins + " min" : Math.round(mins/60) + " h") + " ago";
      if(mins > 150) posts = [];            // stale, try live below
    }
  }catch(e){}

  if(posts.length){
    const startMissing = missingSubs(posts);
    if(startMissing.length){
      let merged = posts;
      try{ merged = mergePosts(merged, await fromRedditCombined()); }
      catch(e){}
      for(const sub of missingSubs(merged)){
        try{ merged = mergePosts(merged, await fromReddit(sub)); }
        catch(e){}
        await sleep(350);
      }
      posts = merged;
      if(!missingSubs(posts).length) src += " + live top-up";
    }
  }

  if(!posts.length){
    try{
      posts = await fromRedditCombined();
    }catch(e){}
  }
  if(!posts.length){
    for(const sub of SUBS){
      try{ posts.push(...await fromReddit(sub)); }
      catch(e){}
      await sleep(350);
    }
    if(posts.length) src = "live from Reddit";
  }
  if(posts.length){
    state.posts = posts; state.src = src;
    try{ localStorage.setItem("vitafeed", JSON.stringify({t:Date.now(), posts})); }catch(e){}
  } else {
    try{
      const c = JSON.parse(localStorage.getItem("vitafeed") || "null");
      if(c){ state.posts = c.posts; state.src = "saved copy from " + new Date(c.t).toLocaleString(); }
    }catch(e){}
  }

  const missing = missingSubs(posts);
  render(); updateDevice();
  if(!posts.length){
    $("status").className = "status err";
    $("status").textContent = "Couldn't reach Reddit right now. Press Refresh in a minute.";
  } else if(missing.length){
    $("status").className = "status err";
    $("status").textContent = `${state.last ? state.last.length : posts.length} posts - ${state.src || ""} - missing: ${missing.join(", ")}`;
  }
}

function render(){
  const q = $("q").value.trim().toLowerCase();
  const sort = $("sort").value;
  const only = $("onlyNews").checked;
  let list = state.posts.filter(p => state.subs.has(p.sub));
  if(q) list = list.filter(p => p.title.toLowerCase().includes(q));
  if(state.tags.size) list = list.filter(p => topicsOf(p).some(t => state.tags.has(t)));
  if(only) list = list.filter(p => NEWS_RE.test(p.title + " " + (p.flair||"")));
  list.sort((a,b) => sort==="score" ? (b.score||0)-(a.score||0) : sort==="comments" ? (b.comments||0)-(a.comments||0) : b.created-a.created);

  state.last = list;
  const root = $("list");
  root.textContent = "";
  if(!list.length){
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = state.posts.length ? "No posts match these filters. Clear the search or switch on more subreddits." : "No posts loaded yet.";
    root.appendChild(d);
  }
  for(const p of list){
    const a = document.createElement("article");
    a.style.setProperty("--c", COLORS[p.sub]);
    const h = document.createElement("h2");
    const l = document.createElement("a");
    l.href = p.permalink; l.target = "_blank"; l.rel = "noopener noreferrer";
    l.textContent = p.title;
    h.appendChild(l); a.appendChild(h);
    if(p.thumb){
      const im = document.createElement("img");
      im.className = "thumb"; im.src = p.thumb; im.alt = ""; im.loading = "lazy"; im.referrerPolicy = "no-referrer";
      a.appendChild(im);
    }
    const m = document.createElement("div");
    m.className = "meta";
    const add = (txt, cls) => { const s = document.createElement("span"); if(cls) s.className = cls; s.textContent = txt; m.appendChild(s); };
    add("r/"+p.sub, "sr");
    if(Date.now()/1000 - p.created < 21600) add("New", "tag new");
    if(p.flair) add(p.flair, "tag");
    topicsOf(p).forEach(t => add(t, "tag"));
    add(ago(p.created));
    if(p.score != null) add(p.score + " points");
    if(p.comments != null) add(p.comments + " comments");
    a.appendChild(m);
    if(p.link && !/reddit\.com$|redd\.it$/.test(p.domain||"")){
      const e = document.createElement("div");
      e.className = "ext";
      const el = document.createElement("a");
      el.href = p.link; el.target = "_blank"; el.rel = "noopener noreferrer";
      el.textContent = "Linked page on " + p.domain;
      e.appendChild(el); a.appendChild(e);
    }
    root.appendChild(a);
  }
  if(!$("status").classList.contains("err"))
    $("status").textContent = `${list.length} posts - ${state.src || ""}`;
}

$("q").oninput = render;
$("sort").onchange = render;
$("onlyNews").onchange = render;
$("refresh").onclick = load;
setInterval(load, 5*60*1000);

/* ---- Ports tracker search ---- */
const SHEET_ID = "1_nuD1Sr5sNCtZPjWMliR-fFZDvQToUtnMwhh_dJkNeE", SHEET_GID = "1739999294";
const T = { rows:[], shown:50, loading:false, loaded:false };
const norm = x => String(x ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const urlRe = /https?:\/\/[^\s)]+/g;

function loadSheet(){
  if(T.loaded || T.loading) return;
  T.loading = true;
  const tag = document.createElement("script");
  const timer = setTimeout(() => fail("The sheet took too long to respond."), 12000);
  function fail(msg){
    T.loading = false; clearTimeout(timer);
    const c = $("tcount"); c.className = ""; c.classList.add("err");
    c.textContent = msg + " Use \"Show the full sheet\" below instead. The sheet must be shared as viewable by link.";
    $("sheetDetails").open = true;
  }
  window.google = window.google || {};
  google.visualization = google.visualization || {};
  google.visualization.Query = google.visualization.Query || {};
  google.visualization.Query.setResponse = resp => {
    clearTimeout(timer); T.loading = false;
    if(!resp || resp.status !== "ok") return fail("Google refused to share the sheet data.");
    try{ ingest(resp.table); T.loaded = true; fillFilters(); renderTracker(); }
    catch(e){ fail("Could not read the sheet's layout."); }
  };
  tag.onerror = () => fail("Could not reach Google Sheets.");
  tag.src = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?gid=${SHEET_GID}&headers=1&tqx=out:json`;
  document.head.appendChild(tag);
}

function ingest(table){
  let labels = table.cols.map(c => (c.label || "").trim());
  let rows = table.rows.map(r => (r.c || []).map(c => c ? (c.f ?? c.v ?? "") : ""));
  let first = 2;
  if(!labels.some(Boolean)){ labels = rows.shift().map(x => String(x).trim()); first = 3; }
  const find = re => labels.findIndex(l => re.test(l));
  const col = {
    name: find(/game|name/i), dev: find(/github|developer/i), plat: find(/platform/i),
    stage: find(/stage/i), play: find(/playab|status/i), notes: find(/notes|issues/i),
    proof: find(/proof|gameplay/i), by: find(/verified by/i), date: find(/date/i)
  };
  if(col.name < 0) col.name = 1;
  const get = (r, i) => i >= 0 && r[i] != null ? String(r[i]).trim() : "";
  T.rows = rows.map((r, i) => {
    const o = { n:i + first, name:get(r,col.name), dev:get(r,col.dev), plat:get(r,col.plat),
      stage:get(r,col.stage), play:get(r,col.play), notes:get(r,col.notes),
      proof:get(r,col.proof), by:get(r,col.by), date:get(r,col.date) };
    o.hay = norm([o.name,o.plat,o.stage,o.play,o.notes,o.by,o.dev].join(" "));
    return o;
  }).filter(o => o.name);
}

function fillFilters(){
  const opts = (id, key) => {
    const sel = $(id), vals = [...new Set(T.rows.map(r => r[key]).filter(Boolean))].sort();
    vals.forEach(v => { const o = document.createElement("option"); o.value = v; o.textContent = v; sel.appendChild(o); });
  };
  opts("tplat","plat"); opts("tstage","stage"); opts("tplay","play");
}


/* developer-page button: project pages only, never file-host links */
const FILE_HOSTS = /(mediafire|gofile|drive\.google|docs\.google|mega\.nz|pixeldrain|buzzheavier|filebin|1fichier|dropbox|wetransfer|archive\.org\/download|zippyshare|anonfiles|upload)/i;
function devLink(r){
  const urls = (r.dev.match(urlRe) || []).map(u => u.replace(/[.,;]+$/, "")).filter(u => !FILE_HOSTS.test(u));
  if(!urls.length) return null;
  const u = urls[0];
  let m;
  if((m = u.match(/^https:\/\/(github\.com|gitlab\.com)\/([^\/?#]+)\/([^\/?#]+)\/?$/i)))
    return { href:`https://${m[1]}/${m[2]}/${m[3]}/releases`, label:"Get port" };
  if(/^https:\/\/(github|gitlab|gitee)\.com\//i.test(u)) return { href:u, label:/releases/i.test(u) ? "Get port" : "View project" };
  if(/itch\.io/i.test(u)) return { href:u, label:"Get on itch.io" };
  if(/rinnegatamante\.eu\/vitadb/i.test(u)) return { href:u, label:"View on VitaDB" };
  if(/gamebrew\.org/i.test(u)) return { href:u, label:"GameBrew page" };
  if(/reddit\.com/i.test(u)) return { href:u, label:"Reddit thread" };
  return { href:u, label:"Project page" };
}
function renderTracker(){
  const terms = norm($("tq").value).split(/\s+/).filter(Boolean);
  const plat = $("tplat").value, stage = $("tstage").value, play = $("tplay").value, sort = $("tsort").value;
  let list = T.rows.filter(r =>
    terms.every(t => r.hay.includes(t)) &&
    (!plat || r.plat === plat) && (!stage || r.stage === stage) && (!play || r.play === play));
  if(sort === "name") list.sort((a,b) => a.name.localeCompare(b.name));
  if(sort === "date") list.sort((a,b) => (b.date||"").localeCompare(a.date||""));
  T.last = list;
  const root = $("tlist"); root.textContent = "";
  const c = $("tcount"); c.className = "";
  c.textContent = `${list.length} of ${T.rows.length} entries`;
  if(!list.length){
    const d = document.createElement("div"); d.className = "empty";
    d.textContent = "No entries match. Try fewer words or reset the filters.";
    root.appendChild(d);
  }
  for(const r of list.slice(0, T.shown)){
    const a = document.createElement("div"); a.className = "row";
    const h = document.createElement("h3"); h.textContent = r.name; a.appendChild(h);
    const m = document.createElement("div"); m.className = "meta";
    const add = (txt, cls) => { if(!txt) return; const s = document.createElement("span"); if(cls) s.className = cls; s.textContent = txt; m.appendChild(s); };
    add(r.plat);
    if(r.stage) add(r.stage, /release/i.test(r.stage) ? "tag ok" : "tag wip");
    if(r.play) add(r.play, "tag");
    if(r.date) add("verified " + r.date + (r.by ? " by " + r.by : ""));
    const link = (href, label, cls) => {
      const l = document.createElement("a"); l.href = href; l.target = "_blank"; l.rel = "noopener noreferrer"; l.textContent = label;
      if(cls) l.className = cls; m.appendChild(l); return l;
    };
    const dl = devLink(r);
    if(dl) link(dl.href, dl.label, "getbtn");
    const proofUrl = (r.proof.match(urlRe) || [])[0];
    if(proofUrl) link(proofUrl, "Gameplay");
    link(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=${SHEET_GID}#gid=${SHEET_GID}&range=B${r.n}`, "Open row in sheet");
    a.appendChild(m);
    if(r.notes){ const p = document.createElement("p"); p.className = "note"; p.textContent = r.notes.replace(urlRe, "").trim(); if(p.textContent) a.appendChild(p); }
    root.appendChild(a);
  }
  $("tmore").hidden = list.length <= T.shown;
  $("tmore").textContent = `Show more (${list.length - T.shown} left)`;
}
let tTimer;
$("tq").oninput = () => { clearTimeout(tTimer); tTimer = setTimeout(() => { T.shown = 50; renderTracker(); }, 150); };
["tplat","tstage","tplay","tsort"].forEach(id => $(id).onchange = () => { T.shown = 50; renderTracker(); });
$("tmore").onclick = () => { T.shown += 50; renderTracker(); };
const SHEET = "https://docs.google.com/spreadsheets/d/1_nuD1Sr5sNCtZPjWMliR-fFZDvQToUtnMwhh_dJkNeE/edit?gid=1739999294";
$("sheetLink").href = SHEET;
function showTab(t){
  const tracker = t === "tracker";
  $("feedView").hidden = tracker;
  $("trackerView").hidden = !tracker;
  $("tabFeed").setAttribute("aria-pressed", !tracker);
  $("tabTracker").setAttribute("aria-pressed", tracker);
  if(tracker) loadSheet();
  history.replaceState(null, "", tracker ? "#tracker" : "#feed");
}
$("tabFeed").onclick = () => showTab("feed");
$("tabTracker").onclick = () => showTab("tracker");
$("sheetDetails").addEventListener("toggle", () => {
  if($("sheetDetails").open && !$("sheetFrame").src) $("sheetFrame").src = SHEET + "&rm=minimal";
});
if(location.hash === "#tracker") showTab("tracker");

/* nav search, hero, device screen, keyboard */
function updateDevice(){
  const top = [...state.posts].sort((a,b) => b.created-a.created).slice(0,3);
  if(!top.length) return;
  const sc = $("devScreen"); sc.querySelectorAll(".latest-post").forEach(n => n.remove());
  const label = document.createElement("span");
  label.className = "latest-post";
  label.textContent = "LATEST";
  sc.appendChild(label);
  top.forEach(p => {
    const d = document.createElement("div");
    d.className = "latest-post";
    d.textContent = p.title;
    sc.appendChild(d);
  });
}
$("gq").oninput = () => {
  const t = $("trackerView").hidden ? $("q") : $("tq");
  t.value = $("gq").value; t.dispatchEvent(new Event("input"));
};
$("heroBtn").onclick = e => { e.preventDefault(); showTab("feed"); $("panelwrap").scrollIntoView({behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"}); };
function applyTheme(t){
  document.documentElement.dataset.theme = t;
  $("themeBtn").setAttribute("aria-checked", t === "dark");
}
applyTheme(document.documentElement.dataset.theme || "light");
$("themeBtn").onclick = () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(t);
  try{ localStorage.setItem("vitatheme", t); }catch(e){}
};

/* CSV download of the current view */
function toCSV(head, rows){
  const q = v => { v = String(v ?? ""); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return "\ufeff" + [head, ...rows].map(r => r.map(q).join(",")).join("\r\n");
}
function saveFile(name, text){
  const url = URL.createObjectURL(new Blob([text], {type:"text/csv;charset=utf-8"}));
  const a = document.createElement("a"); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("dlBtn").onclick = () => {
  const day = new Date().toISOString().slice(0,10);
  if($("trackerView").hidden){
    const rows = (state.last || []).map(p => [p.sub, p.title, p.flair||"", p.score, p.comments,
      new Date(p.created*1000).toISOString(), p.permalink]);
    if(!rows.length){ $("status").textContent = "Nothing to download yet."; return; }
    saveFile(`vita-feed-${day}.csv`, toCSV(["Subreddit","Title","Flair","Score","Comments","Posted (UTC)","Reddit link"], rows));
  } else {
    const rows = (T.last || []).map(r => [r.name, r.plat, r.stage, r.play, r.notes.replace(urlRe,"").trim(),
      (devLink(r)||{}).href||"", (r.proof.match(urlRe)||[])[0]||"", r.by, r.date]);
    if(!rows.length){ $("tcount").textContent = "The tracker has not loaded yet, nothing to download."; return; }
    saveFile(`vita-ports-${day}.csv`, toCSV(["Game","Platform","Stage","Status","Notes","Developer page","Gameplay","Verified by","Verified date"], rows));
  }
};
try{ $("proxyIn").value = localStorage.getItem("vitaproxy") || ""; }catch(e){}
$("proxySave").onclick = () => {
  try{ const v = $("proxyIn").value.trim(); v ? localStorage.setItem("vitaproxy", v) : localStorage.removeItem("vitaproxy"); }catch(e){}
  state.route = null; load();
};
document.addEventListener("keydown", e => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  if(e.key === "/" && !typing){ e.preventDefault(); $("gq").focus(); }
  if(typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if(e.key === "ArrowRight") showTab("tracker");
  if(e.key === "ArrowLeft") showTab("feed");
});
load();
