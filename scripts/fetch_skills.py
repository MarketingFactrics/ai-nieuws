#!/usr/bin/env python3
"""Bouwt de skills-catalogus en kiest de skill van de avond: schrijft data/skills.json.

Bronnen: officiële Anthropic-skills (GitHub), plugins op de Claude-marketplace en de
communitylijst van ComposioHQ. Alleen standaardbibliotheek; vertaling gratis via Google.
"""
import base64
import hashlib
import html
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_feed import NOW, ROOT, clean, get, google_translate  # noqa: E402

SKILLS_PATH = os.path.join(ROOT, "data", "skills.json")
OFFICIAL_REPO = "anthropics/skills"
COMMUNITY_REPO = "ComposioHQ/awesome-claude-skills"
# Secties uit de communitylijst die geen losse skills zijn
COMMUNITY_SKIP = {"App Automation via Composio"}

# Eén indeling voor alle bronnen, zodat filteren overal hetzelfde werkt (eerste match wint)
CATEGORIES = [
    ("Security", r"\bsecurity\b|vulnerab|\bvulns?\b|pentest|semgrep|snyk|sonarqube|\bcve\b|\bsast\b|owasp|secret scan|malware|threat model"),
    ("Code review & testen", r"review|test|tdd|lint|quality|debug|qa\b|playwright|cypress"),
    ("Documenten", r"\bdocx\b|\bpdf\b|pptx|xlsx|excel|word doc|powerpoint|spreadsheet|document"),
    ("Design & media", r"design|\bui\b|\bux\b|figma|canvas|art|image|video|gif|theme|brand|frontend|animation"),
    ("Data & analyse", r"data|analytic|sql|database|chart|bigquery|snowflake|metrics|csv"),
    ("Marketing & business", r"marketing|seo|sales|crm|ads\b|campaign|content|social|finance|invoice|legal|compliance|contract"),
    ("Schrijven & communicatie", r"writ|comms|communicat|email|slack|newsletter|blog|copy"),
    ("Ontwikkeling", r"code|dev|git|deploy|api|mcp|sdk|framework|cloud|aws|kubernetes|docker|typescript|python|react|agent"),
    ("Productiviteit", r"productiv|notion|task|calendar|meeting|note|workflow|organi|project"),
]

UA_HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36"}


def category(text):
    t = text.lower()
    for name, pattern in CATEGORIES:
        if re.search(pattern, t):
            return name
    return "Overig"


def gh_json(path):
    return json.loads(get("https://api.github.com/" + path))


def gh_file(repo, path):
    return base64.b64decode(gh_json("repos/%s/contents/%s" % (repo, path))["content"]).decode("utf-8", "replace")


def frontmatter(md):
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", md, re.S)
    if not m:
        return {}, md
    meta = {}
    for line in m.group(1).splitlines():
        if ":" in line and not line.startswith(" "):
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip().strip('"\'')
    return meta, m.group(2)


def readable(md, limit=1600):
    """Markdown → een paar leesbare alinea's (zonder codeblokken)."""
    md = re.sub(r"```.*?```", "", md, flags=re.S)
    paras, size = [], 0
    for block in re.split(r"\n\s*\n", md):
        lines = [re.sub(r"^\s*(#+|[-*]|\d+\.)\s*", "", l).strip() for l in block.splitlines()]
        text = clean(" ".join(l for l in lines if l), 600)
        text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text).replace("**", "").strip("* ")
        if len(text) < 30 or text.startswith(("|", "<")):
            continue
        paras.append(text)
        size += len(text)
        if size > limit:
            break
    return paras


# ---------- bronnen ----------

def official():
    market = json.loads(gh_file(OFFICIAL_REPO, ".claude-plugin/marketplace.json"))
    plugin_of = {s.split("/")[-1]: p["name"] for p in market["plugins"] for s in p.get("skills", [])}
    out = []
    for entry in gh_json("repos/%s/contents/skills" % OFFICIAL_REPO):
        if entry["type"] != "dir":
            continue
        slug = entry["name"]
        try:
            meta, _ = frontmatter(gh_file(OFFICIAL_REPO, "skills/%s/SKILL.md" % slug))
        except Exception as e:
            print("  officieel", slug, "mislukt:", e, file=sys.stderr)
            continue
        desc = meta.get("description", "")
        plugin = plugin_of.get(slug)
        install = ["/plugin marketplace add %s" % OFFICIAL_REPO]
        if plugin:
            install.append("/plugin install %s@%s" % (plugin, market["name"]))
        out.append({
            "id": "official:" + slug, "name": meta.get("name", slug), "origin": "official",
            "description": desc, "category": category(slug + " " + desc),
            "url": "https://github.com/%s/tree/main/skills/%s" % (OFFICIAL_REPO, slug),
            "raw": "https://raw.githubusercontent.com/%s/main/skills/%s/SKILL.md" % (OFFICIAL_REPO, slug),
            "install": install, "verified": True,
        })
    return out


def parse_marketplace_page(page):
    text = re.sub(r"<script.*?</script>|<style.*?</style>", "", page, flags=re.S)
    toks = [t.strip() for t in html.unescape(re.sub(r"<[^>]+>", "\x00", text)).split("\x00") if t.strip()]
    start = len(toks) - 1 - toks[::-1].index("Search")
    end = toks.index("Other plugins") if "Other plugins" in toks else len(toks)
    main = toks[start + 1:end]
    verified = "Anthropic verified" in main
    main = [t for t in main if t != "Anthropic verified"]
    installs = 0
    about = []
    if "Installs" in main:
        k = main.index("Installs")
        installs = int(re.sub(r"\D", "", main[k + 1]) or 0)
        about = main[k + 2:]
    maker = main[main.index("Made by") + 1] if "Made by" in main else ""
    src = re.findall(r'href="(https://github\.com/[^"]+)"', page)
    return {"name": main[0], "description": main[1] if len(main) > 1 else "", "verified": verified,
            "installs": installs, "maker": maker, "about": [a for a in about if len(a) > 30][:4],
            "source": src[0].removesuffix(".git") if src else ""}


def marketplace(previous):
    sitemap = get("https://claude.com/sitemap.xml")
    urls = sorted(set(re.findall(r"<loc>(https://claude\.com/marketplace/plugins/[a-z0-9-]+)</loc>", sitemap)))
    out = []
    # Bekende plugins hergebruiken; alleen nieuwe pagina's ophalen (en elke dag een deel verversen)
    refresh = {u for u in urls if int(hashlib.md5((u + NOW.date().isoformat()).encode()).hexdigest(), 16) % 14 == 0}
    for n, url in enumerate(urls):
        sid = "marketplace:" + url.rsplit("/", 1)[-1]
        old = previous.get(sid)
        if old and url not in refresh:
            out.append(old)
            continue
        try:
            p = parse_marketplace_page(get(url))
        except Exception as e:
            print("  marketplace", url, "mislukt:", e, file=sys.stderr)
            if old:
                out.append(old)
            continue
        item = {
            "id": sid, "name": p["name"], "origin": "marketplace", "description": p["description"],
            "category": category(p["name"] + " " + p["description"]), "url": url, "source": p["source"],
            "verified": p["verified"], "installs": p["installs"], "maker": p["maker"], "about": p["about"],
        }
        # Vertaling behouden als de tekst niet veranderde
        if old and old.get("descriptionOriginal") == item["description"]:
            item["descriptionOriginal"], item["description"] = old["descriptionOriginal"], old["description"]
        out.append(item)
        time.sleep(0.15)
        if n and n % 100 == 0:
            print("  marketplace: %d/%d" % (n, len(urls)))
    return out


def community():
    branch = gh_json("repos/" + COMMUNITY_REPO)["default_branch"]
    readme = gh_file(COMMUNITY_REPO, "README.md")
    body = readme.split("\n## Skills", 1)[-1].split("\n## Getting Started", 1)[0]
    out, section = [], ""
    for line in body.splitlines():
        h = re.match(r"^###\s+(.+)", line)
        if h:
            section = h.group(1).strip()
            continue
        m = re.match(r"^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*[-–:]\s*(.+)$", line)
        if not m or section in COMMUNITY_SKIP:
            continue
        name, link, desc = m.groups()
        if link.startswith("./") or not link.startswith("http"):
            link = "https://github.com/%s/tree/%s/%s" % (COMMUNITY_REPO, branch, link.lstrip("./").rstrip("/"))
        desc = re.sub(r"\*By \[.*$", "", desc).strip()
        gh = re.match(r"https://github\.com/([^/]+/[^/]+)/tree/([^/]+)/(.+)", link)
        out.append({
            "id": "community:" + re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-"), "name": name,
            "origin": "community", "description": clean(desc, 300), "category": category(section + " " + name + " " + desc),
            "url": link, "verified": False,
            "raw": "https://raw.githubusercontent.com/%s/%s/%s/SKILL.md" % gh.groups() if gh else None,
        })
    return out


# ---------- vertalen ----------

def translate_descriptions(skills):
    todo = [s for s in skills if s["description"] and not s.get("descriptionOriginal")]
    batch, size = [], 0
    for s in todo + [None]:
        if s is not None and size + len(s["description"]) < 3500 and len(batch) < 25:
            batch.append(s)
            size += len(s["description"])
            continue
        if batch:
            try:
                out = google_translate([b["description"] for b in batch])
                if len(out) == len(batch):
                    for b, t in zip(batch, out):
                        b["descriptionOriginal"], b["description"] = b["description"], t or b["description"]
            except Exception as e:
                print("  vertalen mislukt:", e, file=sys.stderr)
            time.sleep(0.5)
        batch, size = ([s], len(s["description"])) if s else ([], 0)
    print("  vertaald: %d nieuwe beschrijvingen" % sum(1 for s in todo if s.get("descriptionOriginal")))


# ---------- skill van de avond ----------

def pick_tonight(skills, history):
    """Kiest elke dag één skill die het verdiepen waard is; herhaalt pas als alles geweest is."""
    def worth(s):
        return s["origin"] == "official" or s.get("verified") or s.get("installs", 0) >= 5000 or s["origin"] == "community"
    pool = [s for s in skills if worth(s)]
    fresh = [s for s in pool if s["id"] not in history] or pool
    # Vaste maar gemengde volgorde: officieel en populair eerst, daarna de rest
    def rank(s):
        tier = 0 if s["origin"] == "official" else 1 if s.get("verified") or s.get("installs", 0) >= 50000 else 2
        return tier, hashlib.md5(s["id"].encode()).hexdigest()
    return sorted(fresh, key=rank)[0]


def deep_dive(skill):
    """Langere uitleg voor de skill van de avond: uit SKILL.md of de marketplace-pagina, vertaald."""
    paras = []
    if skill.get("raw"):
        try:
            _, body = frontmatter(get(skill["raw"]))
            paras = readable(body)
        except Exception as e:
            print("  verdieping uit SKILL.md mislukt:", e, file=sys.stderr)
    if not paras and skill.get("about"):
        paras = skill["about"]
    if not paras:
        return [], []
    try:
        nl = google_translate(paras)
        if len(nl) == len(paras):
            return nl, paras
    except Exception as e:
        print("  vertalen verdieping mislukt:", e, file=sys.stderr)
    return paras, paras


def main():
    try:
        with open(SKILLS_PATH) as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        data = {"skills": [], "history": []}
    previous = {s["id"]: s for s in data.get("skills", [])}

    skills = []
    for name, fn in (("officieel", official), ("marketplace", lambda: marketplace(previous)), ("community", community)):
        try:
            got = fn()
        except Exception as e:  # een kapotte bron: vorige versie van die bron houden
            print("bron", name, "mislukt:", e, file=sys.stderr)
            prefix = {"officieel": "official:", "marketplace": "marketplace:", "community": "community:"}[name]
            got = [s for s in previous.values() if s["id"].startswith(prefix)]
        print("%-11s %4d skills" % (name, len(got)))
        skills += got

    # Ontdubbelen op id, vertalingen en 'eerst gezien' behouden
    seen, unique = set(), []
    for s in skills:
        if s["id"] in seen:
            continue
        seen.add(s["id"])
        old = previous.get(s["id"])
        if s["origin"] != "community":  # community krijgt de sectie mee bij het ophalen
            s["category"] = category(s["name"] + " " + (s.get("descriptionOriginal") or s["description"]))
        s["firstSeen"] = old.get("firstSeen") if old else (NOW.date().isoformat() if previous else "2000-01-01")
        if old and old.get("descriptionOriginal") == s["description"]:
            s["descriptionOriginal"], s["description"] = old["descriptionOriginal"], old["description"]
        unique.append(s)
    translate_descriptions(unique)

    today = NOW.date().isoformat()
    tonight = data.get("tonight")
    if not tonight or tonight.get("date") != today:
        pick = pick_tonight(unique, data.get("history", []))
        text, original = deep_dive(pick)
        tonight = {"date": today, "id": pick["id"], "text": text, "textOriginal": original}
        data["history"] = (data.get("history", []) + [pick["id"]])[-400:]
        print("Skill van de avond:", pick["name"])

    data.update({"updated": NOW.isoformat(), "tonight": tonight,
                 "skills": sorted(unique, key=lambda s: s["name"].lower())})
    with open(SKILLS_PATH, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print("Catalogus: %d skills" % len(unique))


if __name__ == "__main__":
    main()
