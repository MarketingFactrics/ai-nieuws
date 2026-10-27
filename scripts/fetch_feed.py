#!/usr/bin/env python3
"""Stelt de avondeditie samen: haalt Claude / Claude Code nieuws op en schrijft data/feed.json.

Alleen standaardbibliotheek, zodat het zonder installatie in GitHub Actions draait.
"""
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FEED_PATH = os.path.join(ROOT, "data", "feed.json")
SOURCES_PATH = os.path.join(ROOT, "sources.json")

UA = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36 AINieuws/1.0"
NOW = datetime.now(timezone.utc)
KEEP_DAYS = 21          # zo lang blijven edities in de app staan
FIRST_RUN_DAYS = 7      # eerste keer: haal de afgelopen week op
MAX_PER_EDITION = 12    # bewust beperkt: geen eindeloze feed
MAX_PER_SOURCE = 2
# Hoeveel van elke soort maximaal in één avondeditie
QUOTA = {"release": 1, "anthropic": 2, "claude-blog": 2, "video-official": 2,
         "video": 4, "simon": 2, "hn": 2, "reddit": 3}

ATOM = "{http://www.w3.org/2005/Atom}"
MEDIA = "{http://search.yahoo.com/mrss/}"
YT = "{http://www.youtube.com/xml/schemas/2015}"

# Lagere waarde = belangrijker bij het samenstellen van de editie
PRIORITY = {"release": 0, "anthropic": 1, "claude-blog": 1, "video-official": 2,
            "video": 3, "simon": 4, "hn": 5, "reddit": 6}


def get(url, accept=None, retries=1):
    headers = {"User-Agent": UA, "Accept-Language": "en"}
    if accept:
        headers["Accept"] = accept
    token = os.environ.get("GITHUB_TOKEN")
    if token and url.startswith("https://api.github.com"):
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code == 429 and retries:
            time.sleep(8)
            return get(url, accept, retries - 1)
        raise


def parse_date(s):
    if not s:
        return None
    s = s.strip().replace("Z", "+00:00")
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def clean(text, limit=280):
    text = html.unescape(re.sub(r"<[^>]+>", " ", text or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + "…"


def item(id, kind, source, title, url, published, summary="", image=None, video_id=None, extra=None):
    d = {"id": id, "kind": kind, "source": source, "title": clean(title, 200), "url": url,
         "published": published.isoformat() if published else NOW.isoformat(),
         "summary": clean(summary)}
    if image:
        d["image"] = image
    if video_id:
        d["videoId"] = video_id
    if extra:
        d.update(extra)
    return d


def is_relevant(text, keywords):
    t = text.lower()
    return any(k in t for k in keywords)


# ---------- bronnen ----------

def youtube(cfg, keywords):
    out = []
    for ch in cfg["youtube"]:
        try:
            root = ET.fromstring(get("https://www.youtube.com/feeds/videos.xml?channel_id=" + ch["id"]))
        except Exception as e:
            print("  youtube", ch["name"], "mislukt:", e, file=sys.stderr)
            continue
        for e in root.findall(ATOM + "entry"):
            vid = e.findtext(YT + "videoId")
            title = e.findtext(ATOM + "title") or ""
            group = e.find(MEDIA + "group")
            desc = group.findtext(MEDIA + "description") if group is not None else ""
            # Bij makers alleen video's die echt over Claude gaan (titel, of begin van de beschrijving)
            if not ch.get("official") and not (is_relevant(title, keywords)
                                                or "claude" in (desc or "")[:200].lower()):
                continue
            # Shorts overslaan: die horen bij scrollen, niet bij rustig kijken
            if "#shorts" in (title + (desc or "")).lower():
                continue
            out.append(item("yt:" + vid, "video-official" if ch.get("official") else "video", ch["name"],
                            title, "https://www.youtube.com/watch?v=" + vid,
                            parse_date(e.findtext(ATOM + "published")), desc,
                            "https://i.ytimg.com/vi/%s/hqdefault.jpg" % vid, vid))
    return out


def github_releases(cfg, keywords):
    """Alle nieuwe releases van een repo worden in build_edition samengevoegd tot één kaart."""
    out = []
    for repo in cfg["github_releases"]:
        try:
            rels = json.loads(get("https://api.github.com/repos/%s/releases?per_page=10" % repo))
        except Exception as e:
            print("  releases", repo, "mislukt:", e, file=sys.stderr)
            continue
        for r in rels:
            if r.get("draft"):
                continue
            body = r.get("body") or ""
            bullets = [clean(l.lstrip("-* "), 160) for l in body.splitlines() if l.strip().startswith(("-", "*"))]
            out.append(item("gh:%s:%s" % (repo, r["tag_name"]), "release", repo.split("/")[-1],
                            "%s %s" % (repo.split("/")[-1], r.get("name") or r["tag_name"]), r["html_url"],
                            parse_date(r.get("published_at")), " · ".join(bullets[:3]) or body,
                            extra={"bullets": bullets[:8]}))
    return out


def sitemap_articles(cfg, state, keywords):
    """Nieuwe pagina's in een sitemap = nieuwe artikelen. Titel/datum uit og-meta."""
    out = []
    for sm in cfg["sitemaps"]:
        try:
            locs = re.findall(r"<loc>([^<]+)</loc>", get(sm["url"]))
        except Exception as e:
            print("  sitemap", sm["name"], "mislukt:", e, file=sys.stderr)
            continue
        prefix = sm["prefix"]
        urls = sorted({u for u in locs if u.startswith(prefix) and "/" not in u[len(prefix):].strip("/")
                       and u.rstrip("/") != prefix.rstrip("/")})
        seen = set(state.setdefault("sitemap_seen", {}).get(sm["url"], []))
        first_run = not seen
        new = [u for u in urls if u not in seen]
        state["sitemap_seen"][sm["url"]] = urls
        # Eerste run: kijk alleen naar de laatst toegevoegde pagina's om het snel te houden
        if first_run:
            new = new[-60:]
        for u in new[:40]:
            try:
                page = get(u)
            except Exception:
                continue
            meta = dict(re.findall(r'<meta (?:property|name)="([a-z:_]+)" content="([^"]*)"', page))
            title = meta.get("og:title") or u.rsplit("/", 1)[-1].replace("-", " ").title()
            published = parse_date(meta.get("article:published_time")) or (None if first_run else NOW)
            if published is None:
                continue
            desc = meta.get("og:description") or meta.get("description") or ""
            if "AI safety and research company" in desc:
                m = re.search(r"<p[^>]*>(.{80,600}?)</p>", page, re.S)
                desc = m.group(1) if m else ""
            if sm.get("filter") and not is_relevant(title + " " + desc, cfg["article_keywords"]):
                continue
            out.append(item("web:" + u, sm["kind"], sm["name"], html.unescape(title), u, published,
                            desc, meta.get("og:image")))
    return out


def simon(cfg, keywords):
    out = []
    try:
        root = ET.fromstring(get(cfg["simon_feed"]))
    except Exception as e:
        print("  simon mislukt:", e, file=sys.stderr)
        return out
    for e in root.findall(ATOM + "entry"):
        link = e.find(ATOM + "link")
        url = link.get("href") if link is not None else ""
        out.append(item("simon:" + url, "simon", "Simon Willison", e.findtext(ATOM + "title"), url,
                        parse_date(e.findtext(ATOM + "published") or e.findtext(ATOM + "updated")),
                        e.findtext(ATOM + "summary") or e.findtext(ATOM + "content") or ""))
    return out


def hackernews(cfg, keywords):
    out = []
    since = int((NOW - timedelta(days=FIRST_RUN_DAYS)).timestamp())
    for q in ("claude", "anthropic"):
        try:
            data = json.loads(get("https://hn.algolia.com/api/v1/search?query=%s&tags=story"
                                  "&numericFilters=points%%3E%d,created_at_i%%3E%d" % (q, cfg["hn_min_points"], since)))
        except Exception as e:
            print("  hn mislukt:", e, file=sys.stderr)
            continue
        for h in data.get("hits", []):
            if not is_relevant(h.get("title", ""), keywords):
                continue
            discuss = "https://news.ycombinator.com/item?id=" + h["objectID"]
            out.append(item("hn:" + h["objectID"], "hn", "Hacker News", h["title"], h.get("url") or discuss,
                            parse_date(h.get("created_at")),
                            "%d punten · %d reacties" % (h.get("points", 0), h.get("num_comments", 0)),
                            extra={"discussion": discuss, "score": h.get("points", 0)}))
    return out


def reddit(cfg, keywords):
    out = []
    for i, sub in enumerate(cfg["reddit"]):
        if i:
            time.sleep(3)
        try:
            root = ET.fromstring(get("https://www.reddit.com/r/%s/top/.rss?t=day&limit=10" % sub))
        except Exception as e:
            print("  reddit", sub, "mislukt:", e, file=sys.stderr)
            continue
        for rank, e in enumerate(root.findall(ATOM + "entry")):
            link = e.find(ATOM + "link")
            content = e.findtext(ATOM + "content") or ""
            thumb = e.find(MEDIA + "thumbnail")
            out.append(item("reddit:" + (e.findtext(ATOM + "id") or ""), "reddit", "r/" + sub,
                            e.findtext(ATOM + "title"), link.get("href") if link is not None else "",
                            parse_date(e.findtext(ATOM + "published") or e.findtext(ATOM + "updated")),
                            content, thumb.get("url") if thumb is not None else None,
                            extra={"score": 100 - rank}))
    return out


# ---------- samenstellen ----------

def merge_releases(releases):
    if len(releases) <= 1:
        return releases
    releases = sorted(releases, key=lambda r: r["published"])
    newest = releases[-1]
    versions = [r["title"].split(" ", 1)[-1] for r in releases]
    bullets = []
    for r in reversed(releases):
        for b in r.get("bullets", []):
            if b not in bullets:
                bullets.append(b)
    merged = dict(newest)
    merged["title"] = "%s: %d nieuwe versies (%s → %s)" % (newest["source"], len(releases), versions[0], versions[-1])
    merged["bullets"] = bullets[:12]
    merged["summary"] = " · ".join(bullets[:3])
    merged["url"] = "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md"
    return [merged]


def build_edition(candidates, seen_ids, window_start):
    fresh = [c for c in candidates if c["id"] not in seen_ids and parse_date(c["published"]) >= window_start]
    rel = [c for c in fresh if c["kind"] == "release"]
    fresh = [c for c in fresh if c["kind"] != "release"] + merge_releases(rel)
    # Dubbele links (zelfde artikel via HN én Reddit) samenvoegen
    by_url, unique = set(), []
    for c in sorted(fresh, key=lambda c: (PRIORITY.get(c["kind"], 9), -c.get("score", 0))):
        key = c["url"].split("?")[0].rstrip("/")
        if key in by_url and c["kind"] != "video":
            continue
        by_url.add(key)
        unique.append(c)
    picked, per_source, per_kind = [], {}, {}
    for c in unique:
        if len(picked) >= MAX_PER_EDITION:
            break
        if per_source.get(c["source"], 0) >= MAX_PER_SOURCE or per_kind.get(c["kind"], 0) >= QUOTA.get(c["kind"], 2):
            continue
        per_source[c["source"]] = per_source.get(c["source"], 0) + 1
        per_kind[c["kind"]] = per_kind.get(c["kind"], 0) + 1
        picked.append(c)
    # Volgorde in de app: afwisselend lezen en kijken, belangrijkste eerst
    reads = [c for c in picked if not c.get("videoId")]
    videos = [c for c in picked if c.get("videoId")]
    mixed = []
    while reads or videos:
        mixed += reads[:2]; reads = reads[2:]
        mixed += videos[:1]; videos = videos[1:]
    return mixed


# ---------- vertalen ----------

TRANSLATE_PROMPT = """Je vertaalt items voor een rustige Nederlandse nieuwsapp over Claude en Claude Code.

Voor elk item:
- title: een natuurlijke Nederlandse titel. Geen clickbait of hoofdletters-schreeuwen; rustig en informatief.
- summary: 1 à 2 zinnen in eenvoudig Nederlands over waar het over gaat en waarom het interessant is. \
Bij een video: wat je ervan leert. Verzin niets dat niet in de brontekst staat; is die mager, houd het dan kort.
- bullets: vertaal elk punt (zelfde volgorde en aantal). Lege lijst als er geen punten zijn.

Laat productnamen, functienamen, commando's, opties en code onvertaald (Claude Code, MCP, skills, subagents, `--flag`, enz.).
Geef het id ongewijzigd terug.

Items (JSON):
"""

TRANSLATE_SCHEMA = {
    "type": "object",
    "properties": {"items": {"type": "array", "items": {
        "type": "object",
        "properties": {"id": {"type": "string"}, "title": {"type": "string"},
                       "summary": {"type": "string"}, "bullets": {"type": "array", "items": {"type": "string"}}},
        "required": ["id", "title", "summary", "bullets"],
        "additionalProperties": False}}},
    "required": ["items"],
    "additionalProperties": False,
}


def translate(items):
    """Vertaalt titels, samenvattingen en releasepunten naar het Nederlands met Claude.

    Zonder ANTHROPIC_API_KEY (of bij een fout) blijven de items gewoon Engels.
    """
    todo = [i for i in items if i.get("lang") != "nl"]
    if not todo:
        return
    try:
        import anthropic
        client = anthropic.Anthropic()
    except Exception as e:
        print("  vertalen overgeslagen:", e, file=sys.stderr)
        return
    payload = [{"id": i["id"], "soort": i["kind"], "bron": i["source"], "title": i["title"],
                "summary": i.get("summary", ""), "bullets": i.get("bullets", [])} for i in todo]
    try:
        response = client.beta.messages.create(
            model="claude-opus-5-5",
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": TRANSLATE_SCHEMA}},
            messages=[{"role": "user", "content": TRANSLATE_PROMPT + json.dumps(payload, ensure_ascii=False)}],
        )
    except anthropic.APIError as e:
        print("  vertalen mislukt:", e, file=sys.stderr)
        return
    if response.stop_reason in ("refusal", "max_tokens"):
        print("  vertalen gestopt:", response.stop_reason, file=sys.stderr)
        return
    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        translated = {t["id"]: t for t in json.loads(text)["items"]}
    except (ValueError, KeyError) as e:
        print("  vertaling onleesbaar:", e, file=sys.stderr)
        return
    for i in todo:
        t = translated.get(i["id"])
        if not t:
            continue
        i["titleOriginal"] = i["title"]
        i["title"] = t["title"].strip() or i["title"]
        i["summary"] = t["summary"].strip()
        if i.get("bullets") and len(t["bullets"]) == len(i["bullets"]):
            i["bullets"] = t["bullets"]
        i["lang"] = "nl"
    print("  vertaald: %d van %d items" % (sum(1 for i in todo if i.get("lang") == "nl"), len(todo)))


def main():
    with open(SOURCES_PATH) as f:
        cfg = json.load(f)
    keywords = [k.lower() for k in cfg["keywords"]]
    try:
        with open(FEED_PATH) as f:
            feed = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        feed = {"editions": [], "state": {}}
    state = feed.setdefault("state", {})
    first_run = not feed["editions"]
    seen_ids = set(state.get("seen_ids", []))

    candidates = []
    for name, fn in (("releases", lambda: github_releases(cfg, keywords)),
                     ("sitemaps", lambda: sitemap_articles(cfg, state, keywords)),
                     ("youtube", lambda: youtube(cfg, keywords)),
                     ("simon", lambda: simon(cfg, keywords)),
                     ("hackernews", lambda: hackernews(cfg, keywords)),
                     ("reddit", lambda: reddit(cfg, keywords))):
        try:
            got = fn()
        except Exception as e:  # één kapotte bron mag de editie niet tegenhouden
            print("bron", name, "mislukt:", e, file=sys.stderr)
            got = []
        print("%-11s %3d items" % (name, len(got)))
        candidates += got

    last = parse_date(state.get("last_run"))
    window_start = NOW - timedelta(days=FIRST_RUN_DAYS) if first_run or not last else min(last, NOW - timedelta(hours=26)) - timedelta(hours=6)
    edition_items = build_edition(candidates, seen_ids, window_start)

    today = NOW.astimezone(timezone(timedelta(hours=1))).date().isoformat()
    existing = next((e for e in feed["editions"] if e["date"] == today), None)
    if existing:
        # Tweede run op dezelfde dag: aanvullen, niet vervangen
        room = max(0, MAX_PER_EDITION - len(existing["items"]))
        existing["items"] += edition_items[:room]
    elif edition_items:
        feed["editions"].insert(0, {"date": today, "items": edition_items})
    # Nieuwste editie vertalen (vangt ook items op die eerder onvertaald bleven)
    if feed["editions"]:
        translate(feed["editions"][0]["items"])
    cutoff = (NOW - timedelta(days=KEEP_DAYS)).date().isoformat()
    feed["editions"] = [e for e in feed["editions"] if e["date"] >= cutoff]

    # Alles wat we nu kandidaat zagen telt als "gezien", ook wat niet gekozen werd,
    # zodat een volle avond niet morgen nog eens terugkomt.
    seen_ids |= {c["id"] for c in candidates}
    state["seen_ids"] = sorted(seen_ids)[-3000:]
    state["last_run"] = NOW.isoformat()
    feed["generated"] = NOW.isoformat()

    os.makedirs(os.path.dirname(FEED_PATH), exist_ok=True)
    with open(FEED_PATH, "w") as f:
        json.dump(feed, f, ensure_ascii=False, indent=1)
    print("Editie %s: %d items" % (today, len(edition_items)))


if __name__ == "__main__":
    main()
