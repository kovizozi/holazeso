# PROGRESS.md

Ez a fájl egy hosszú munkamenet állapotát rögzíti, hogy egy új session (vagy
egy `/compact` utáni folytatás) pontosan onnan tudjon továbbmenni, ahol
abbamaradt. A `CLAUDE.md` az általános szabályokat és parancsokat írja le,
az `ARCHITECTURE.md` a rendszer működését - ez a fájl a **jelenlegi
munkamenet konkrét, aktuális állapotát**.

## Legfontosabb: nyitott, befejezetlen teendő

**A push-worker KV-migrációja még nincs befejezve.** Történet:

1. A KV-tárolást átalakítottuk kulcsonkénti rekordokról egyetlen
   `subscriptions` kulcs alatti JSON tömbre (lásd `ARCHITECTURE.md`,
   "Tárolás: EGYETLEN KV kulcs" szakasz) - a régi felépítés napi 1000
   írás/listázás limitet lépte túl percenkénti cronnal.
2. A 4 meglévő (régi formátumú) feliratkozást kiolvastuk a régi
   per-endpoint kulcsokból, de az új `subscriptions` kulcsba **nem sikerült
   beírni** őket, mert épp akkor merült ki a napi KV írási kvóta.
3. A régi per-endpoint kulcsokat **nem töröltük**, tehát az adat még ott
   van, csak a `run()` (scheduled handler) mostantól kizárólag a
   `subscriptions` kulcsot olvassa, ami jelenleg üres/nem létezik - **egy
   feliratkozó sem kap értesítést**, amíg ezt nem javítjuk.

**Mit kell tenni, ha ez a session folytatja:**
1. Ellenőrizd, resetelődött-e már a KV írási kvóta:
   `curl -s -X PUT ".../storage/kv/namespaces/b930cf16ba13431787bccd98a88257f0/values/subscriptions" ...`
   (account ID: `c61cb06c1083cbbcf897a3e1afa23647`, namespace ID:
   `b930cf16ba13431787bccd98a88257f0`)
2. Listázd a régi kulcsokat (`.../storage/kv/namespaces/<id>/keys`), olvasd
   ki mindegyik értékét, és írd be egy tömbként a `subscriptions` kulcs alá.
3. Ellenőrizd a végeredményt, majd (opcionálisan, ha minden migrált) töröld
   a régi per-endpoint kulcsokat, hogy tiszta legyen a namespace.

## Munkamenet során hozott döntések (időrendben, tömören)

- **Infrastruktúra**: GitHub repó (`kovizozi/holazeso`, publikus) →
  Cloudflare Pages, Git-integrációval automatikus deploy. Domain
  `holazeso.hu` (kanonikus) + `holazeső.hu` (301 redirect rá, Cloudflare
  Redirect Rule-lal). Cloudflare Web Analytics + GoatCounter (mindkettő
  cookie-mentes).
- **Helymeghatározás**: böngésző geolocation az alapértelmezett út, kézi
  településkeresés csak fallback. Bármely ország elfogadott (a korábbi
  Magyarország-only szűrést kivettük, mert hibásan viselkedett).
- **Keresési algoritmus**: nincs fix településlista - dinamikus rács a
  felhasználó köré, egyre táguló körökben (`SEARCH_BATCHES_KM`), amíg talál
  esőt. Ha a talált pontnak nincs neve, kis helyi kereséssel keres mellette
  megnevezhető helyet (`findNearbyName`) - ennek saját koordinátáihoz kell
  számolni a távolságot/irányt, nem az eredeti ponthoz (ez egy valós, javított
  hiba volt).
- **Design**: szigorúan monokróm, tipográfia-vezérelt. A bal felső sarokból
  kivettük a "HOLAZESO.HU" feliratot (AI-sablon minta volt). Fibonacci
  térköz-skála (8/13/21/34/55/89px), szerep szerint kiosztva. A "Nálad" hero
  szót lecseréltük "Most esik"/"Hamarosan"-ra (informatívabb, a kérdés már
  eleve a keresett helyről szól). Nincs em dash (—) sehol, ez ismételten
  megerősített szabály.
- **Válasz-gazdagítás**: intenzitás (gyenge/közepes/erős + mm/óra),
  valószínűség (`precipitation_probability`), és becsült időtartam
  (mikor áll el, az hourly előrejelzésből visszafelé nézve).
- **Radar-vizualizáció** (keresés közben, a "töltés…" helyett): SVG,
  pásztázó vonal folyamatosan forog ("dolgozunk" jelzés), egy kör pontjai
  EGYSZERRE villannak fel, amikor a valódi (egyetlen, batch-elt) Open-Meteo
  hívás visszatér - ez tudatosan NEM egy kitalált, pontonkénti időzítés.
  Ha egy kör üres, a rács a következő, távolabbi körre vált, és az addig
  felvillant körök CSS transition-nel zoomolnak összébb (cumulatív
  `scale()`, `transform-origin` a radar közepére állítva - ez volt egy
  valós hiba, alapból a bal felső sarokhoz zoomolt volna). A megoldást a
  Claude Design vászon segítségével terveztük meg előre (lásd lent).
- **Push-értesítés**: külön Cloudflare Worker (`holazeso-push-worker`,
  privát repó), Web Push + VAPID (`@pushforge/builder`, natív Web Crypto,
  nem kell `nodejs_compat`). Cooldown-logika: csak akkor értesít, ha
  legalább 2 órája száraz volt, mielőtt esni kezdett - nem szól újra
  minden percben, amíg tart az eső. iOS-en csak telepített (Add to Home
  Screen) appként működik a `PushManager`, ez Apple platform-korlátozása.
- **PWA**: manifest.json, ikonok, service worker. A service worker
  eredetileg minden navigációs kérést (az `index.html`-t is) cache-elte,
  ami örökre megragaszthatta volna egy telepített appot egy régi
  `script.js?v=N` verziónál - javítva (`event.request.mode === "navigate"`
  kizárva a cache-ből).
- **Cache-busting kvirk**: a `holazeso.hu` custom domain nem tartja
  tiszteletben a `_headers` fájl `no-cache` szabályát (nem sikerült
  megoldani, csak megkerülni). Ezért a `?v=N` query param bővítése
  KÖTELEZŐ minden `script.js`/`style.css` módosításnál - lásd `CLAUDE.md`.
- **Tervezés vizuálisan**: több döntést (márkajelzés helye, térköz-rendszer,
  a valószínűség/intenzitás megjelenítési formája, a radar-koncepció) egy
  Claude Design vászon-artifacton (`https://claude.ai/code/artifact/6bb94c8b-4a7c-4a09-8f33-ed6437509f75`)
  terveztünk meg előre, mielőtt kódoltunk - ez a vászon továbbra is elérhető
  referenciaként, és frissíthető, ha újabb vizuális ötlet jön.

## Ebben a session-ben módosított/létrehozott fájlok

**`holazeso-v0` repó** (teljes commit-lista időrendben, lásd `git log`):
`index.html`, `style.css`, `script.js`, `sw.js`, `manifest.json`,
`icon-192.png`, `icon-512.png`, `favicon.svg`, `og-image.png`,
`robots.txt`, `sitemap.xml`, `_headers`, `README.md`, `ARCHITECTURE.md`,
`CLAUDE.md` (ez a session hozta létre mindet, a repót is ez a session
inicializálta a semmiből).

**`holazeso-push-worker` repó** (külön, privát): `wrangler.toml`,
`package.json`, `src/index.js` - ugyanez a session hozta létre.

## Nyitott ötletek (felmerültek, de NEM valósítottuk meg)

- Országhatárok megjelenítése a radaron nagy sugárnál (tudatosan
  későbbre hagyva, külön döntés kell hozzá - lásd a vászon 3. oldalát).
- Pontossági jelzés a helymeghatározásnál (ha a böngésző csak IP-alapú,
  pontatlan helyzetet ad).
- Sötét/világos mód kézi váltása (jelenleg csak `prefers-color-scheme`).
- A push-értesítés teljes végpontos tesztje valós (nem manuálisan
  triggerelt) esőeseménnyel még nem történt meg.

## Instrukció a `/compact`-hoz

Ha ez a beszélgetés hamarosan compact-olásra kerül, a compact parancsnak
add meg ezt az instrukciót, hogy a lényeg megmaradjon:

```
/compact Tartsd meg: a push-worker KV-migráció befejezetlen állapotát és a
pontos helyreállítási lépéseket (lásd PROGRESS.md a repóban), az összes
"Kritikus szabály" pontot a CLAUDE.md-ből (főleg az em dash tilalmat és a
?v=N cache-busting kötelezettséget), és a Cloudflare API token/fiók
azonosítókat (account c61cb06c1083cbbcf897a3e1afa23647, push-worker KV
namespace b930cf16ba13431787bccd98a88257f0). A részletes technikai
háttér (keresési algoritmus, radar-logika, push cooldown) ne kerüljön be
szó szerint, mert az ARCHITECTURE.md-ben és a kódban megvan - elég rájuk
hivatkozni.
```
