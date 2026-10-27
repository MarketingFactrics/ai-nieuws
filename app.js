"use strict";

// ---------- opslag (blijft op deze iPhone) ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { toast("Opslaan lukte niet"); }
  },
};

let feed = null;
let saved = store.get("saved", {});      // id -> {item, note, status, savedAt}
let seen = new Set(store.get("seen", []));
let savedFilter = "all";

const $ = (sel) => document.querySelector(sel);
const KIND_LABEL = {
  release: "Claude Code update", anthropic: "Anthropic", "claude-blog": "Claude blog",
  "video-official": "Officiële video", video: "Video", simon: "Blog", hn: "Discussie", reddit: "Community", skill: "Skill",
};
const STATUS = [["todo", "Te doen"], ["doing", "Bezig"], ["done", "Gedaan"]];

const ICON = {
  save: '<svg viewBox="0 0 24 24"><path d="M6 3.5h12v17l-6-4-6 4z"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  claude: '<svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
};

// ---------- hulpjes ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// `code` uit releasenotes als inline code tonen
function rich(s) {
  return esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function longDate(iso) {
  return new Date(iso + "T12:00:00").toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long" });
}
function ago(iso) {
  const days = Math.floor((Date.now() - new Date(iso)) / 864e5);
  if (days <= 0) return "vandaag";
  if (days === 1) return "gisteren";
  return `${days} dagen geleden`;
}
function minutes(items) {
  return items.reduce((m, i) => m + (i.videoId ? 10 : i.kind === "release" ? 3 : 2), 0);
}
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("is-on"), 2200);
}

function claudePrompt(entry) {
  const { item, note } = entry;
  if (item.kind === "skill") {
    return [
      "Ik wil me verdiepen in deze Claude-skill/plugin en hem gaan gebruiken:",
      "",
      `Naam: ${item.title}`,
      `Link: ${item.url}`,
      item.summary ? `Omschrijving: ${item.summary}` : "",
      note ? `\nMijn notitie: ${note}` : "",
      "",
      "Bekijk de link en leg in gewone taal uit wat deze skill doet, wanneer hij handig is en wanneer niet. " +
        "Geef 2 à 3 concrete voorbeelden van hoe ik hem kan inzetten, en daarna de exacte stappen om hem te installeren en te testen in Claude Code of claude.ai.",
    ].filter((l) => l !== "").join("\n");
  }
  return [
    "Ik kwam dit tegen en wil ermee aan de slag in Claude / Claude Code:",
    "",
    `Titel: ${item.title}`,
    `Bron: ${item.source}`,
    `Link: ${item.url}`,
    item.summary ? `Samenvatting: ${item.summary}` : "",
    note ? `\nMijn notitie: ${note}` : "",
    "",
    "Bekijk de link en leg in gewone taal uit wat dit is en waarom het nuttig is. " +
      "Geef daarna een concreet stappenplan om het zelf op te zetten of te gebruiken. " +
      "Gaat het om een skill, MCP-server, plugin of Claude Code-functie, geef dan de exacte installatie- en configuratiestappen.",
  ].filter((l) => l !== "").join("\n");
}
function openInClaude(id) {
  const entry = saved[id] || { item: findItem(id), note: "" };
  window.open("https://claude.ai/new?q=" + encodeURIComponent(claudePrompt(entry)), "_blank", "noopener");
}
async function copyPrompt(id) {
  try {
    await navigator.clipboard.writeText(claudePrompt(saved[id]));
    toast("Prompt gekopieerd");
  } catch {
    toast("Kopiëren lukte niet");
  }
}

function findItem(id) {
  for (const e of feed?.editions || []) for (const i of e.items) if (i.id === id) return i;
  const s = skillById(id.replace(/^skill:/, ""));
  if (s) return skillItem(s);
  return saved[id]?.item;
}

// ---------- skills ----------
let skillsData = null;
let skillQuery = "";
let skillOrigin = "all";
let skillCategory = "";
let skillLimit = 30;
const ORIGIN_LABEL = { official: "Officieel", marketplace: "Marketplace", community: "Community" };

function skillById(id) {
  return skillsData?.skills.find((s) => s.id === id);
}
function skillItem(s) {
  return { id: "skill:" + s.id, kind: "skill", source: ORIGIN_LABEL[s.origin], title: s.name, url: s.url, summary: s.description };
}
function isNew(s) {
  return s.firstSeen && (Date.now() - new Date(s.firstSeen)) / 864e5 < 7;
}
function installSteps(s) {
  if (s.install?.length) return { lines: s.install, hint: "Plak deze regels één voor één in Claude Code." };
  if (s.origin === "marketplace") return { lines: ["/plugin"], hint: `Open Claude Code, typ /plugin en zoek in Discover op “${s.name}”.` };
  return { lines: [], hint: "Kopieer de map van deze skill naar ~/.claude/skills/ (zie de bron), of vraag Claude om hulp met de knop hieronder." };
}

async function loadSkills() {
  if (skillsData) return skillsData;
  try {
    const res = await fetch("data/skills.json?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    skillsData = await res.json();
    store.set("skills-cache", skillsData);
  } catch {
    skillsData = store.get("skills-cache", null);
  }
  if (skillsData) linkSkillsInFeed();
  return skillsData;
}

function skillBadges(s) {
  return [
    `<span class="tag k-${s.origin}">${ORIGIN_LABEL[s.origin]}</span>`,
    s.verified && s.origin !== "official" ? '<span class="tag k-verified">Anthropic verified</span>' : "",
    isNew(s) ? '<span class="tag k-new">Nieuw</span>' : "",
  ].join("");
}

function skillActions(s) {
  const item = skillItem(s);
  const isSaved = !!saved[item.id];
  return `<div class="actions">
      <button class="action ${isSaved ? "is-saved" : ""}" data-save="${esc(item.id)}" aria-pressed="${isSaved}">${ICON.save}<span>${isSaved ? "Bewaard" : "Bewaar"}</span></button>
      <button class="action primary" data-claude="${esc(item.id)}">${ICON.claude}<span>Uitwerken in Claude</span></button>
      <a class="action" href="${esc(s.url)}" target="_blank" rel="noopener">${ICON.open}<span>Bron</span></a>
    </div>`;
}

function installHTML(s) {
  const { lines, hint } = installSteps(s);
  return `<div class="install">
      <p class="install-title">Installeren</p>
      ${lines.map((l) => `<div class="install-line"><code>${esc(l)}</code>
        <button class="copy-btn" data-copytext="${esc(l)}" aria-label="Kopieer ${esc(l)}">${ICON.copy}</button></div>`).join("")}
      <p class="install-hint">${esc(hint)}</p>
    </div>`;
}

function skillMeta(s) {
  return [s.category, s.maker && `door ${s.maker}`, s.installs && `${s.installs.toLocaleString("nl-NL")} installaties`]
    .filter(Boolean).map(esc).join(" · ");
}

function spotlightHTML() {
  const t = skillsData.tonight;
  const s = t && skillById(t.id);
  if (!s) return "";
  const paras = t.text || [];
  return `<article class="card spotlight">
    <div class="card-body">
      <p class="eyebrow">Skill van de avond</p>
      <h2>${esc(s.name)}</h2>
      <div class="kicker">${skillBadges(s)}<span>${skillMeta(s)}</span></div>
      <p class="summary is-full">${rich(s.description)}</p>
      ${paras.length ? `<div class="deep ${paras.length > 2 ? "is-collapsed" : ""}">${paras.map((p) => `<p>${rich(p)}</p>`).join("")}</div>
        ${paras.length > 2 ? '<button class="more" data-deep>Lees verder</button>' : ""}` : ""}
      ${installHTML(s)}
    </div>
    ${skillActions(s)}
  </article>`;
}

function filteredSkills() {
  const q = skillQuery.trim().toLowerCase();
  const rank = (s) => (s.origin === "official" ? 0 : s.verified ? 1 : 2);
  return skillsData.skills
    .filter((s) => skillOrigin === "all" || s.origin === skillOrigin)
    .filter((s) => !skillCategory || s.category === skillCategory)
    .filter((s) => !q || `${s.name} ${s.description} ${s.descriptionOriginal || ""} ${s.maker || ""}`.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || (b.installs || 0) - (a.installs || 0) || a.name.localeCompare(b.name));
}

function skillRowHTML(s) {
  return `<details class="skill" data-skill="${esc(s.id)}">
    <summary>
      <div class="skill-head"><b>${esc(s.name)}</b>${skillBadges(s)}</div>
      <p class="skill-desc">${esc(s.description)}</p>
    </summary>
    <div class="skill-body">
      <p class="install-hint">${skillMeta(s)}</p>
      ${installHTML(s)}
    </div>
    ${skillActions(s)}
  </details>`;
}

function renderSkillList() {
  const list = filteredSkills();
  const box = $("#skill-list");
  if (!box) return;
  box.innerHTML = list.length
    ? list.slice(0, skillLimit).map(skillRowHTML).join("") +
      (list.length > skillLimit ? `<button class="chip more-skills" data-moreskills>Toon meer (${list.length - skillLimit})</button>` : "")
    : `<div class="empty"><p>Geen skills gevonden. Probeer een ander woord of filter.</p></div>`;
  $("#skill-count").textContent = `${list.length} ${list.length === 1 ? "skill" : "skills"}`;
}

async function renderSkills() {
  const view = $("#view-skills");
  if (!skillsData) view.innerHTML = '<div class="skeleton"></div>';
  await loadSkills();
  if (!skillsData) {
    view.innerHTML = `<div class="empty"><h3>Skills niet geladen</h3><p>Controleer je verbinding en probeer het opnieuw.</p></div>`;
    return;
  }
  const newCount = skillsData.skills.filter(isNew).length;
  setHeader("Verdiepen", "Skills", `${skillsData.skills.length} skills en plugins${newCount ? ` · ${newCount} nieuw deze week` : ""}`);
  const cats = [...new Set(skillsData.skills.map((s) => s.category))].sort();
  const chips = [["all", "Alles"], ["official", "Officieel"], ["marketplace", "Marketplace"], ["community", "Community"]]
    .map(([k, l]) => `<button class="chip ${skillOrigin === k ? "is-active" : ""}" data-origin="${k}">${l}</button>`).join("");
  view.innerHTML = spotlightHTML() + `
    <h3 class="section-title">Alle skills</h3>
    <input class="search" id="skill-search" type="search" placeholder="Zoek, bijv. security, pdf, review" value="${esc(skillQuery)}" aria-label="Zoek skills" autocomplete="off">
    <div class="filters" role="group" aria-label="Bron">${chips}</div>
    <div class="filter-row">
      <select class="select" id="skill-category" aria-label="Categorie">
        <option value="">Alle categorieën</option>
        ${cats.map((c) => `<option ${c === skillCategory ? "selected" : ""}>${esc(c)}</option>`).join("")}
      </select>
      <span class="count" id="skill-count"></span>
    </div>
    <div id="skill-list"></div>`;
  renderSkillList();
}

async function openSkill(id) {
  await loadSkills();
  const s = skillById(id);
  if (!s) return;
  skillQuery = s.name;
  skillOrigin = "all";
  skillCategory = "";
  await show("skills");
  const row = document.querySelector(`[data-skill="${CSS.escape(id)}"]`);
  if (row) { row.open = true; row.scrollIntoView({ block: "start" }); }
}

// Verwijs vanuit de avondfeed naar bekende skills die in een titel genoemd worden
function linkSkillsInFeed() {
  const known = skillsData.skills.filter((s) => (s.origin === "official" || s.verified) && s.name.length >= 6);
  document.querySelectorAll("#view-tonight .card, #view-archive .card").forEach((card) => {
    if (card.querySelector("[data-openskill]")) return;
    const item = findItem(card.dataset.id);
    if (!item) return;
    const text = ` ${item.title} ${item.titleOriginal || ""} `.toLowerCase();
    const hit = known.find((s) => text.includes(` ${s.name.toLowerCase()} `) || text.includes(` ${s.name.toLowerCase().replace(/-/g, " ")} `));
    if (!hit) return;
    card.querySelector(".actions").insertAdjacentHTML("beforeend",
      `<button class="action" data-openskill="${esc(hit.id)}">${ICON.claude}<span>Skill: ${esc(hit.name)}</span></button>`);
  });
}

// ---------- bewaren ----------
function toggleSave(id) {
  if (saved[id]) {
    delete saved[id];
    toast("Niet meer bewaard");
  } else {
    saved[id] = { item: findItem(id), note: "", status: "todo", savedAt: new Date().toISOString() };
    toast("Bewaard voor later");
  }
  store.set("saved", saved);
  document.querySelectorAll(`[data-save="${CSS.escape(id)}"]`).forEach((b) => paintSave(b, !!saved[id]));
  updateBadge();
  if (!$("#view-saved").hidden) renderSaved();
}
function paintSave(btn, on) {
  btn.classList.toggle("is-saved", on);
  btn.setAttribute("aria-pressed", on);
  btn.querySelector("span").textContent = on ? "Bewaard" : "Bewaar";
}
function updateBadge() {
  const open = Object.values(saved).filter((s) => s.status !== "done").length;
  const b = $("#saved-count");
  b.textContent = open;
  b.hidden = open === 0;
}

// ---------- kaarten ----------
function cardHTML(item) {
  const isSaved = !!saved[item.id];
  let media = "";
  if (item.videoId) {
    media = `<button class="card-media" data-play="${esc(item.videoId)}" aria-label="Speel video af: ${esc(item.title)}">
      <img src="${esc(item.image)}" alt="" loading="lazy"><span class="play"><i></i></span></button>`;
  } else if (item.image && item.kind !== "reddit") {
    media = `<a class="card-media" href="${esc(item.url)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">
      <img src="${esc(item.image)}" alt="" loading="lazy" onerror="this.parentNode.remove()"></a>`;
  }
  let body = "";
  if (item.bullets?.length) {
    const many = item.bullets.length > 4;
    body = `<ul class="bullets ${many ? "is-collapsed" : ""}">${item.bullets.map((b) => `<li>${rich(b)}</li>`).join("")}</ul>
      ${many ? `<button class="more" data-more>Toon alle ${item.bullets.length} wijzigingen</button>` : ""}`;
  } else if (item.summary) {
    body = `<p class="summary">${rich(item.summary)}</p>`;
  }
  const discussion = item.discussion && item.discussion !== item.url
    ? `<a class="action" href="${esc(item.discussion)}" target="_blank" rel="noopener">${ICON.chat}<span>Reacties</span></a>` : "";
  return `<article class="card ${seen.has(item.id) ? "is-seen" : ""}" data-id="${esc(item.id)}">
    ${media}
    <div class="card-body">
      <div class="kicker"><span class="tag k-${esc(item.kind)}">${esc(KIND_LABEL[item.kind] || item.kind)}</span>
        <span>${esc(item.source)} · ${ago(item.published)}</span></div>
      <h2><a href="${esc(item.url)}" target="_blank" rel="noopener">${esc(item.title)}</a></h2>
      ${body}
    </div>
    <div class="actions">
      <button class="action ${isSaved ? "is-saved" : ""}" data-save="${esc(item.id)}" aria-pressed="${isSaved}">${ICON.save}<span>${isSaved ? "Bewaard" : "Bewaar"}</span></button>
      <a class="action" href="${esc(item.url)}" target="_blank" rel="noopener">${ICON.open}<span>${item.videoId ? "YouTube" : "Open"}</span></a>
      ${discussion}
    </div>
  </article>`;
}

// ---------- weergaven ----------
function renderTonight() {
  const view = $("#view-tonight");
  const editions = feed.editions || [];
  if (!editions.length) {
    view.innerHTML = `<div class="empty"><h3>Nog geen editie</h3><p>De eerste avondeditie verschijnt rond 18:00.</p></div>`;
    return;
  }
  const ed = editions[0];
  const isToday = ed.date === todayISO();
  $("#edition-label").textContent = isToday ? "AI Nieuws · vanavond" : "AI Nieuws · laatste editie";
  $("#edition-date").textContent = longDate(ed.date);
  $("#edition-meta").textContent = `${ed.items.length} dingen · ongeveer ${minutes(ed.items)} minuten`;

  const notYet = !isToday && new Date().getHours() < 20
    ? `<p>De editie van vanavond verschijnt rond 18:00.</p>` : "";
  view.innerHTML = ed.items.map(cardHTML).join("") + `
    <div class="done">
      <div class="moon" aria-hidden="true">🌙</div>
      <h3>Dat was het voor vanavond</h3>
      <p>Je bent bij. Er komt niets meer bij tot morgenavond.</p>
      ${notYet}
      <p id="done-saved"></p>
    </div>`;
  updateDone();
  observeSeen(ed.items.map((i) => i.id));
}

function updateDone() {
  const p = $("#done-saved");
  if (!p) return;
  const n = Object.values(saved).filter((s) => s.status === "todo").length;
  p.textContent = n ? `${n} ${n === 1 ? "ding" : "dingen"} bewaard om later mee aan de slag te gaan.` : "";
}

let observer;
function observeSeen(ids) {
  const bar = $("#progress-bar");
  const progress = $("#progress");
  const paint = () => {
    const n = ids.filter((id) => seen.has(id)).length;
    progress.hidden = false;
    bar.style.width = `${(n / ids.length) * 100}%`;
  };
  paint();
  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    let changed = false;
    for (const e of entries) {
      // Gezien = de onderkant van de kaart is in beeld geweest
      if (e.isIntersecting && !seen.has(e.target.dataset.id)) {
        seen.add(e.target.dataset.id);
        changed = true;
      }
    }
    if (changed) {
      store.set("seen", [...seen].slice(-800));
      paint();
    }
  }, { threshold: 0.9 });
  document.querySelectorAll("#view-tonight .card").forEach((c) => observer.observe(c));
}

function renderSaved() {
  const view = $("#view-saved");
  const all = Object.entries(saved).sort((a, b) => b[1].savedAt.localeCompare(a[1].savedAt));
  const list = savedFilter === "all" ? all : all.filter(([, s]) => s.status === savedFilter);
  const count = (s) => all.filter(([, e]) => e.status === s).length;
  const chips = [["all", `Alles (${all.length})`], ...STATUS.map(([k, l]) => [k, `${l} (${count(k)})`])]
    .map(([k, l]) => `<button class="chip ${savedFilter === k ? "is-active" : ""}" data-filter="${k}">${l}</button>`).join("");

  if (!all.length) {
    view.innerHTML = `<div class="empty"><h3>Nog niets bewaard</h3>
      <p>Tik op <b>Bewaar</b> bij iets dat je later wilt uitwerken. Het komt hier te staan, met ruimte voor een notitie en een knop om het direct in Claude op te pakken.</p></div>`;
    return;
  }
  view.innerHTML = `<div class="filters" role="group" aria-label="Filter">${chips}</div>` +
    (list.length ? list.map(([id, s]) => savedCardHTML(id, s)).join("")
      : `<div class="empty"><p>Niets in deze lijst.</p></div>`) +
    `<div class="backup">
      <button class="action" data-export>${ICON.copy}<span>Kopieer back-up</span></button>
      <button class="action" data-import>${ICON.open}<span>Zet back-up terug</span></button>
    </div>`;
}

function savedCardHTML(id, s) {
  const i = s.item;
  return `<article class="card" data-id="${esc(id)}">
    <div class="card-body">
      <div class="kicker"><span class="tag k-${esc(i.kind)}">${esc(KIND_LABEL[i.kind] || i.kind)}</span>
        <span>bewaard ${ago(s.savedAt)}</span></div>
      <h2><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a></h2>
      <div class="status-row" role="group" aria-label="Status">
        ${STATUS.map(([k, l]) => `<button class="status ${s.status === k ? "is-active" : ""}" data-status="${k}" data-s="${k}">${l}</button>`).join("")}
      </div>
      <textarea class="note" data-note="${esc(id)}" placeholder="Wat wil je hiermee doen?" rows="2">${esc(s.note)}</textarea>
    </div>
    <div class="actions">
      <button class="action primary" data-claude="${esc(id)}">${ICON.claude}<span>Uitwerken in Claude</span></button>
      <button class="action" data-copy="${esc(id)}">${ICON.copy}<span>Kopieer prompt</span></button>
      <button class="action" data-remove="${esc(id)}" aria-label="Verwijder">${ICON.trash}</button>
    </div>
  </article>`;
}

function renderArchive() {
  const view = $("#view-archive");
  const older = (feed.editions || []).slice(1);
  if (!older.length) {
    view.innerHTML = `<div class="empty"><h3>Nog geen eerdere edities</h3><p>Edities blijven hier drie weken staan.</p></div>`;
    return;
  }
  view.innerHTML = older.map((e) => `<details class="day">
      <summary><b>${esc(longDate(e.date))}</b><span>${e.items.length} dingen</span></summary>
      ${e.items.map(cardHTML).join("")}
    </details>`).join("");
}

async function show(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.view === name;
    t.classList.toggle("is-active", on);
    on ? t.setAttribute("aria-current", "page") : t.removeAttribute("aria-current");
  });
  for (const v of ["tonight", "skills", "saved", "archive"]) $(`#view-${v}`).hidden = v !== name;
  $("#progress").hidden = name !== "tonight";
  window.scrollTo(0, 0);
  if (name === "saved") { renderSaved(); setHeader("Om later uit te werken", "Bewaard", ""); }
  if (name === "archive") { renderArchive(); setHeader("Archief", "Eerdere avonden", ""); if (skillsData) linkSkillsInFeed(); }
  if (name === "tonight" && feed) { renderTonight(); if (skillsData) linkSkillsInFeed(); }
  if (name === "skills") await renderSkills();
}
function setHeader(eyebrow, title, meta) {
  $("#edition-label").textContent = eyebrow;
  $("#edition-date").textContent = title;
  $("#edition-meta").textContent = meta;
}

// ---------- interactie ----------
let noteTimer;
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.view) return show(t.dataset.view);
  if (t.dataset.openskill) return openSkill(t.dataset.openskill);
  if (t.dataset.origin) { skillOrigin = t.dataset.origin; skillLimit = 30; return renderSkills(); }
  if (t.hasAttribute("data-moreskills")) { skillLimit += 30; return renderSkillList(); }
  if (t.hasAttribute("data-deep")) {
    t.previousElementSibling.classList.remove("is-collapsed");
    t.remove();
    return;
  }
  if (t.dataset.copytext) {
    try { await navigator.clipboard.writeText(t.dataset.copytext); toast("Gekopieerd"); }
    catch { toast("Kopiëren lukte niet"); }
    return;
  }
  if (t.dataset.save) return toggleSave(t.dataset.save);
  if (t.dataset.play) {
    const id = t.dataset.play;
    const frame = document.createElement("div");
    frame.className = "card-media";
    frame.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&playsinline=1&rel=0"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen title="Video"></iframe>`;
    t.replaceWith(frame);
    return;
  }
  if (t.hasAttribute("data-more")) {
    t.previousElementSibling.classList.remove("is-collapsed");
    t.remove();
    return;
  }
  if (t.dataset.filter) { savedFilter = t.dataset.filter; return renderSaved(); }
  if (t.dataset.status) {
    const id = t.closest(".card").dataset.id;
    saved[id].status = t.dataset.status;
    store.set("saved", saved);
    updateBadge();
    if (t.dataset.status === "done") toast("Mooi, afgevinkt");
    return renderSaved();
  }
  if (t.dataset.claude) return openInClaude(t.dataset.claude);
  if (t.dataset.copy) return copyPrompt(t.dataset.copy);
  if (t.dataset.remove) {
    const id = t.dataset.remove;
    const backup = saved[id];
    delete saved[id];
    store.set("saved", saved);
    updateBadge();
    renderSaved();
    showUndo(() => { saved[id] = backup; store.set("saved", saved); updateBadge(); renderSaved(); });
    return;
  }
  if (t.hasAttribute("data-export")) {
    try {
      await navigator.clipboard.writeText(JSON.stringify(saved));
      toast("Back-up gekopieerd. Plak hem in Notities.");
    } catch { toast("Kopiëren lukte niet"); }
    return;
  }
  if (t.hasAttribute("data-import")) {
    const text = prompt("Plak hier je back-up:");
    if (!text) return;
    try {
      const data = JSON.parse(text);
      saved = { ...data, ...saved };
      store.set("saved", saved);
      updateBadge();
      renderSaved();
      toast("Back-up teruggezet");
    } catch { toast("Dat lijkt geen geldige back-up"); }
  }
});

function showUndo(undo) {
  const t = $("#toast");
  t.innerHTML = 'Verwijderd · <button style="text-decoration:underline;font-weight:600">Ongedaan maken</button>';
  t.style.pointerEvents = "auto";
  t.classList.add("is-on");
  t.querySelector("button").onclick = () => { undo(); t.classList.remove("is-on"); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove("is-on"); t.style.pointerEvents = ""; }, 5000);
}

document.addEventListener("input", (e) => {
  const id = e.target.dataset.note;
  if (!id || !saved[id]) return;
  saved[id].note = e.target.value;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => store.set("saved", saved), 400);
});

// ---------- laden ----------
async function load() {
  $("#view-tonight").innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  try {
    const res = await fetch("data/feed.json?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    feed = await res.json();
    store.set("feed-cache", feed);
  } catch {
    feed = store.get("feed-cache", null);
    if (!feed) {
      $("#view-tonight").innerHTML = `<div class="empty"><h3>Geen verbinding</h3>
        <p>De editie kon niet geladen worden. Probeer het zo nog eens.</p></div>`;
      return;
    }
    toast("Offline: je ziet de laatst geladen editie");
  }
  renderTonight();
  // Skills op de achtergrond laden, zodat feedkaarten naar skills kunnen verwijzen
  if (skillsData) linkSkillsInFeed(); else loadSkills();
}

let searchTimer;
document.addEventListener("input", (e) => {
  if (e.target.id !== "skill-search") return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { skillQuery = e.target.value; skillLimit = 30; renderSkillList(); }, 200);
});
document.addEventListener("change", (e) => {
  if (e.target.id !== "skill-category") return;
  skillCategory = e.target.value;
  skillLimit = 30;
  renderSkillList();
});

updateBadge();
load();
document.addEventListener("visibilitychange", () => {
  // Terug naar de app op een nieuwe avond? Haal de nieuwe editie op.
  if (document.visibilityState === "visible" && feed && feed.editions?.[0]?.date !== todayISO() && !$("#view-tonight").hidden) load();
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
