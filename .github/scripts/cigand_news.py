#!/usr/bin/env python3
"""Cigánd-hírfigyelő: magyar RSS-csatornákból gyűjti a Cigándot említő hírek
címét és linkjét a cigand-news.json fájlba. Csak szabványos könyvtárat használ.

Tárolt adat hírenként: cím, link, forrásnév, megjelenés ideje, első észlelés.
Cikkszöveget SOSEM tárolunk (szerzői jog). A fájlt csak akkor írjuk újra, ha a
hírek listája változott, így a Action nem kommitol feleslegesen."""
import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html import unescape
from pathlib import Path

FEEDS = [
    ("telex.hu", "https://telex.hu/rss"),
    ("HVG", "https://hvg.hu/rss"),
    ("Index", "https://index.hu/24ora/rss/"),
    ("444", "https://444.hu/feed"),
    ("Magyar Nemzet", "https://magyarnemzet.hu/feed"),
    ("Portfolio", "https://www.portfolio.hu/rss/all.xml"),
    ("Agrárszektor", "https://www.agrarszektor.hu/rss"),
    ("BOON", "https://www.boon.hu/feed"),
]
USER_AGENT = "holazeso-news-watcher (+https://holazeso.hu)"
TIMEOUT = 20
KEYWORD = "cigánd"
MAX_ITEMS = 30
MAX_AI_CALLS = 10
AI_URL = "https://api.deepseek.com/chat/completions"
AI_MODEL = "deepseek-chat"
AI_TIMEOUT = 60
MAX_AI_ATTEMPTS = 3
ARTICLE_CHARS = 12000
CAPACITY_M3 = 94_000_000
DESCS = {}
OUT = Path(__file__).resolve().parents[2] / "cigand-news.json"


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def strip_html(text):
    return unescape(re.sub(r"<[^>]*>", " ", text or ""))


def norm_link(link):
    return link.split("?")[0].split("#")[0].rstrip("/")


def parse_date(text):
    if not text:
        return None
    try:
        dt = parsedate_to_datetime(text.strip())
    except (TypeError, ValueError):
        try:
            dt = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def local(tag):
    return tag.rsplit("}", 1)[-1]


def fetch_items(name, url, now):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        root = ET.fromstring(resp.read())
    found = []
    for el in root.iter():
        if local(el.tag) not in ("item", "entry"):
            continue
        f = {}
        for ch in el:
            k = local(ch.tag)
            if k == "link" and not (ch.text or "").strip() and ch.get("href"):
                f.setdefault("link", ch.get("href"))
            elif k in ("title", "link", "description", "summary", "pubDate",
                       "published", "updated", "date"):
                f.setdefault(k, ch.text or "")
        title = strip_html(f.get("title")).strip()
        link = (f.get("link") or "").strip()
        desc = strip_html(f.get("description") or f.get("summary"))
        if not title or not link:
            continue
        if KEYWORD not in (title + " " + desc).lower():
            continue
        pub = parse_date(f.get("pubDate") or f.get("published")
                         or f.get("updated") or f.get("date"))
        DESCS[link] = desc
        found.append({
            "title": re.sub(r"\s+", " ", title),
            "link": link,
            "source": name,
            "published": iso(pub or now),
            "first_seen": iso(now),
        })
    return found


# ---- AI-lépés: csak az ebben a futásban újonnan talált hírekre ----

SYSTEM_PROMPT = (
    "Magyar hírcikkekből gyűjtesz adatot a cigándi árapasztó tározóról. "
    "Csak azt vedd ki, amit a cikk kifejezetten kimond; ha bizonytalan vagy, "
    "az érték legyen null. Soha ne következtess számot. A summary magyar, "
    "legfeljebb két mondat, saját szavaiddal, idézet (pár szónál hosszabb) "
    "nélkül, gondolatjel (em dash) nélkül. Az evidence a cikkszövegből szó "
    "szerint kimásolt rövid részlet, amely a számot vagy az állapotot kimondja.\n\n"
    "Válaszolj KIZÁRÓLAG egyetlen json objektummal, pontosan ebben az alakban:\n"
    '{"relevant": true, "summary": "A zsilipek nyitva vannak, a tározóba víz jut.", '
    '"facts": {"stored_volume_m3": 2000000, "gate_status": "nyitva", '
    '"fact_date": "2026-11-21", "evidence": "mintegy 2 millió köbméter víz"}}\n'
    "Itt gate_status csak \"nyitva\", \"zárva\" vagy null lehet; a facts minden "
    "mezője lehet null; a fact_date ÉÉÉÉ-HH-NN alakú."
)
USER_TMPL = (
    "Releváns-e a cikk a cigándi árapasztó tározóról, a beengedett vízről vagy "
    "a Bodrogköz aszály elleni vízpótlásáról? (Pl. egy kerékpártúra nem az.)\n\n"
    "Cím: {title}\n\nSzöveg:\n{text}"
)

WORD_NUM = {"egy": 1, "két": 2, "kettő": 2, "három": 3, "négy": 4, "öt": 5,
            "hat": 6, "hét": 7, "nyolc": 8, "kilenc": 9, "tíz": 10}
MULT = {"millió": 1_000_000, "ezer": 1_000, "milliárd": 1_000_000_000}


def norm_ws(text):
    return re.sub(r"\s+", " ", text or "").strip().lower()


def number_candidates(text):
    """A szövegből kiolvasható mennyiségek (m3-ben vagy darabban), magyar
    alakokkal: "2 millió", "2,5 millió", "2 000 000", "kétmillió"."""
    t = norm_ws(text).replace("\u00a0", " ")
    out = []
    pat = r"(\d{1,3}(?:[ .]\d{3})+|\d+)(?:,(\d+))?(?:\s*(milliárd|millió|ezer))?"
    spans = []
    for m in re.finditer(pat, t):
        whole = re.sub(r"[ .]", "", m.group(1))
        val = float(whole + ("." + m.group(2) if m.group(2) else ""))
        if m.group(3):
            val *= MULT[m.group(3)]
        out.append(val)
        spans.append((m.start(), m.end(), val, bool(m.group(3))))
    for m in re.finditer(r"(egy|két|kettő|három|négy|öt|hat|hét|nyolc|kilenc|tíz)\s*-?\s*(milliárd|millió|ezer)", t):
        out.append(WORD_NUM[m.group(1)] * MULT[m.group(2)])
    # "2 millió 300 ezer": szomszédos millió + ezer összege
    for a, b in zip(spans, spans[1:]):
        if a[3] and b[3] and a[2] >= 1e6 and b[2] < 1e6 and b[0] - a[1] <= 2:
            out.append(a[2] + b[2])
    return out


def validate_facts(raw, text):
    """Nem bízunk a modellben: a tényeket csak akkor tartjuk meg, ha az evidence
    szó szerint szerepel a letöltött szövegben, a szám az evidence-ben is áll,
    és beleesik a tározó kapacitásába."""
    if not isinstance(raw, dict):
        return None
    evidence = (raw.get("evidence") or "").strip()
    if not evidence or norm_ws(evidence) not in norm_ws(text):
        return None
    facts = {"evidence": evidence}
    vol = raw.get("stored_volume_m3")
    if isinstance(vol, (int, float)) and not isinstance(vol, bool) and 0 <= vol <= CAPACITY_M3:
        if any(abs(c - vol) <= max(1.0, vol * 0.01) for c in number_candidates(evidence)):
            facts["stored_volume_m3"] = vol
    stem = {"nyitva": "nyit", "zárva": "zár"}.get(raw.get("gate_status"))
    if stem and stem in norm_ws(evidence):
        facts["gate_status"] = raw["gate_status"]
    fd = raw.get("fact_date")
    if isinstance(fd, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", fd):
        facts["fact_date"] = fd
    if "stored_volume_m3" not in facts and "gate_status" not in facts:
        return None
    return facts


def article_text(link, fallback):
    try:
        req = urllib.request.Request(link, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read(2_000_000).decode(resp.headers.get_content_charset() or "utf-8", "replace")
        raw = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", raw)
        text = re.sub(r"\s+", " ", strip_html(raw)).strip()
        if len(text) > 200:
            return text[:ARTICLE_CHARS]
    except Exception as err:
        print(f"cikk letöltése nem sikerült ({err}), a címet használjuk", file=sys.stderr)
    return fallback[:ARTICLE_CHARS]


def fake_ai(title, text):
    """CIGAND_NEWS_FAKE_AI=1: előre gyártott válasz teszteléshez, API nélkül."""
    m = re.search(r"[^.]*köbméter[^.]*", text)
    evidence = m.group(0).strip() if m else None
    vol = 7_000_000 if "HALLUCINATE" in text else 2_000_000
    return {"relevant": "kerékpár" not in title.lower(),
            "summary": "Teszt összefoglaló a cikkről.",
            "facts": {"stored_volume_m3": vol if evidence else None, "gate_status": "nyitva",
                      "fact_date": "2026-11-21", "evidence": evidence}}


def valid_shape(res):
    if not isinstance(res, dict) or not isinstance(res.get("relevant"), bool):
        return False
    if not res["relevant"]:
        return True
    f = res.get("facts")
    return isinstance(res.get("summary"), str) and isinstance(f, dict) and all(
        k in f for k in ("stored_volume_m3", "gate_status", "fact_date", "evidence"))


def deepseek_extract(key, title, text):
    body = json.dumps({
        "model": AI_MODEL,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": USER_TMPL.format(title=title, text=text)},
        ],
    }).encode("utf-8")
    req = urllib.request.Request(AI_URL, data=body, headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {key}",
        "User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=AI_TIMEOUT) as resp:
        out = json.loads(resp.read())
    return json.loads(out["choices"][0]["message"]["content"])


def enrich(items):
    """AI-összefoglaló és tények a még fel nem dolgozott hírekre (az új híreknél
    és a korábban sikertelen próbálkozásoknál, hírenként legfeljebb 3 kísérlet),
    futásonként legfeljebb MAX_AI_CALLS hívással."""
    fake = os.environ.get("CIGAND_NEWS_FAKE_AI") == "1"
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not fake and not key:
        print("figyelmeztetés: nincs DEEPSEEK_API_KEY, AI-lépés kihagyva", file=sys.stderr)
        return
    todo = [i for i in items if not i.get("ai") and i.get("ai_attempts", 0) < MAX_AI_ATTEMPTS]
    todo.sort(key=lambda i: i["published"], reverse=True)
    for it in todo[:MAX_AI_CALLS]:
        text = article_text(it["link"], it["title"] + ". " + DESCS.get(it["link"], ""))
        try:
            res = fake_ai(it["title"], text) if fake else deepseek_extract(key, it["title"], text)
            if not valid_shape(res):
                raise ValueError("hibás válaszalak")
        except Exception as err:
            it["ai_attempts"] = it.get("ai_attempts", 0) + 1
            print(f"figyelmeztetés: AI-hívás sikertelen ({err}), {it['ai_attempts']}. kísérlet", file=sys.stderr)
            continue
        it.pop("ai_attempts", None)
        it["ai"] = True
        it["relevant"] = res["relevant"]
        if it["relevant"]:
            summ = (res.get("summary") or "").replace("\u2014", "-").strip()
            if summ:
                it["summary"] = summ
            facts = validate_facts(res.get("facts"), text)
            if facts:
                it["facts"] = facts


def fact_when(it):
    return (it.get("facts") or {}).get("fact_date") or it["published"][:10]


def latest_status(items, old_status):
    best = None
    for it in items:
        if it.get("relevant") is False or not it.get("facts"):
            continue
        if best is None or (fact_when(it), it["published"]) > (fact_when(best), best["published"]):
            best = it
    if best is None:
        return old_status
    if old_status and old_status.get("when", "") >= fact_when(best):
        return old_status
    f = best["facts"]
    return {"stored_volume_m3": f.get("stored_volume_m3"), "gate_status": f.get("gate_status"),
            "fact_date": f.get("fact_date"), "when": fact_when(best), "source": best["source"],
            "link": best["link"], "title": best["title"]}


def main():
    now = datetime.now(timezone.utc)
    try:
        prev = json.loads(OUT.read_text(encoding="utf-8"))
        old = prev.get("items", [])
        old_status = prev.get("latest_status")
    except (OSError, ValueError):
        old, old_status = [], None

    fresh = []
    for name, url in FEEDS:
        try:
            fresh += fetch_items(name, url, now)
        except Exception as err:
            print(f"{name}: kihagyva ({err})", file=sys.stderr)

    merged, seen_links, seen_titles = [], set(), set()
    # A régi elemek elöl, hogy megmaradjon az eredeti first_seen.
    for it in old + fresh:
        lk, tt = norm_link(it["link"]), it["title"].lower()
        if lk in seen_links or tt in seen_titles:
            continue
        seen_links.add(lk)
        seen_titles.add(tt)
        merged.append(it)
    enrich(merged)
    merged.sort(key=lambda i: i["published"], reverse=True)
    merged = merged[:MAX_ITEMS]
    status = latest_status(merged, old_status)

    if merged == old and status == old_status and OUT.exists():
        print(f"nincs változás ({len(merged)} hír, {len(fresh)} találat most)")
        return 0
    data = {"updated": iso(now), "sources": [n for n, _ in FEEDS], "items": merged}
    if status:
        data["latest_status"] = status
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"frissítve: {len(merged)} hír, {len(fresh)} találat most")
    return 0


if __name__ == "__main__":
    sys.exit(main())
