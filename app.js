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
  "video-official": "Officiële video", video: "Video", simon: "Blog", hn: "Discussie", reddit: "Community",
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
  return saved[id]?.item;
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
  $("#edition-label").textContent = isToday ? "Avondeditie van vanavond" : "Laatste avondeditie";
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

function show(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.view === name;
    t.classList.toggle("is-active", on);
    on ? t.setAttribute("aria-current", "page") : t.removeAttribute("aria-current");
  });
  for (const v of ["tonight", "saved", "archive"]) $(`#view-${v}`).hidden = v !== name;
  const header = $(".masthead");
  if (name === "saved") { renderSaved(); setHeader("Om later uit te werken", "Bewaard", ""); }
  if (name === "archive") { renderArchive(); setHeader("Archief", "Eerdere avonden", ""); }
  if (name === "tonight" && feed) renderTonight();
  $("#progress").hidden = name !== "tonight";
  header.scrollIntoView();
  window.scrollTo(0, 0);
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
}

updateBadge();
load();
document.addEventListener("visibilitychange", () => {
  // Terug naar de app op een nieuwe avond? Haal de nieuwe editie op.
  if (document.visibilityState === "visible" && feed && feed.editions?.[0]?.date !== todayISO() && !$("#view-tonight").hidden) load();
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
