# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Mit dokumentál mi

- **Ez a fájl**: gyors orientáció, parancsok, kritikus szabályok, amiket be kell tartani.
- **`README.md`**: mi ez a projekt, hogyan futtasd lokálisan, hogyan deployold.
- **`ARCHITECTURE.md`**: részletesen, *hogyan* működik belülről minden (keresési algoritmus, push-rendszer, PWA-csapdák, üzemeltetési buktatók). Olvasd el, mielőtt bármihez hozzányúlsz, ami nem triviális szövegváltoztatás.

## Parancsok

Nincs build lépés, nincs csomagkezelő a webhelyhez (`holazeso-v0`), nincs formális teszt suite.

- **Lokális futtatás**: nyisd meg VS Code-ban, jobb klikk `index.html` → **Open with Live Server**. (Közvetlen `file://` megnyitásnál a `fetch` hívások CORS-hibába futhatnak.)
- **Szintaxis-ellenőrzés módosítás után**: `node --check script.js`, `node --check water.js` és `node --check vizallas.js` (a `sw.js`-re is, ha azt módosítod).
- **Em dash ellenőrzés** (ez a projekt szigorú szabálya, lásd lent): `grep -n "—" script.js water.js index.html style.css README.md ARCHITECTURE.md`
- **Cigánd-hírfigyelő kézzel** (a GitHub Action óránként ugyanezt futtatja): `python3 .github/scripts/cigand_news.py`; csak változásnál írja újra a `cigand-news.json`-t.
- **Generált oldalak** (`/eso/<slug>/`, `sitemap.xml`, a főoldal településlistája): `python3 tools/build_pages.py` (hálózat nélkül); `--fetch-climate [--climate-limit 3]` a hiányzó `climate-hu.json` bejegyzéseket kéri le (helyben legfeljebb 3 helyre, a többit a GitHub Action végzi); `--fetch-recent [--recent-limit 3]` a települések friss csapadékát és holnapi előrejelzését kéri (`town-recent.json`; helyben legfeljebb 3 helyre, a teljes lekérést az Action végzi); `--fetch-water` a worker vízállás-pillanatképéből építi a `/vizallas/` oldalakat (a `/cigand/` mindig épül; ha a víz nem elérhető, a meglévő vízoldalak maradnak). Az `index.html` a sablon: a `<!--GEN:...-->` jelölők közti részt a generátor írja, ne kézzel szerkeszd. Második futás nem változtathat semmit.
- **Vízállás-archívum** (`water-history.json`, a `/vizallas/` évenkénti idősorainak adata): `python3 tools/import_hydro_archive.py --cache /tmp/hydro-cache [--stations si,bp] [--offline]` (hydroinfo.hu archívum és újabb táblák, burgenlandi Fertő-adat; ~1500 kérés 1/mp-cel; csak a saját forrású éveket írja újra); utána `python3 tools/build_pages.py`. A folyó év napi frissítése: `python3 tools/build_pages.py --fetch-history` (az Action ezt is futtatja).
- **Deploy**: `git push` a `main`-re, a Cloudflare Pages Git-integráció automatikusan deployol. Lásd `README.md` a részletekért.
- **Push-worker deploy** (a `holazeso-push-worker` külön repóban): `CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx wrangler deploy` abban a mappában.
- **Adatgyűjtő** (`soil-moisture-mapper`, otthoni gépen): `docker compose up -d --build` abban a mappában; egy kör kézzel: `docker compose run --rm soil-moisture-mapper --once`.

## Architektúra (röviden - a részletekért lásd ARCHITECTURE.md)

Három rész. A weboldal (`holazeso-v0`, ez a repó) statikus, de van mögötte egy kis backend:
- `holazeso-push-worker` (külön repó, Cloudflare Worker + KV): push-értesítések, és a vízadat-panel pillanatképeinek kiszolgálása (`/*-snapshot`).
- `soil-moisture-mapper` (külön repó, otthoni gépen, Docker): óránként gyűjti a talaj-, folyó- és tóadatokat (Open-Meteo, hydroinfo.hu), és feltölti a workernek.

Az esőkeresést és a "részletek és statisztika" panelt a `script.js` továbbra is közvetlenül a böngészőből kéri le (Open-Meteo, BigDataCloud). A worker CORS-a csak az éles origineket engedi, ezért localhostról a vízadat-panel nem tölt be (ld. ARCHITECTURE.md, "Vízadat-panel").

A válasz-logika nem fix településlistán alapul: a felhasználó koordinátája köré dinamikusan generált keresési rácsban (gyűrűk × irányok) keres esőt, egyre táguló körökben, amíg talál valamit vagy elfogynak a körök. Ezt közben egy SVG radar-animáció vizualizálja (`script.js` "Radar vizualizáció" szakasza), ami **valóban az aktuális adatérkezéshez van kötve**, nem egy kitalált időzítéshez - ez fontos, ne törd el egy "egyszerűsítés" során.

## Kritikus szabályok, amiket be kell tartani

1. **Nincs em dash (—) sehol**: sem a kódban, sem a kommentekben, sem a dokumentációban, sem a felhasználónak írt szövegben. Ez explicit, ismételten megerősített felhasználói elvárás. Ha írsz valahova szöveget, ellenőrizd `grep`-pel utána.
2. **Fekete/fehér plusz egyetlen kék kiemelőszín, lekerekített kártyák**: a szöveg és a vékony körvonalak fekete/fehérek (sötét módban megfordítva), a tömör grafikai elemek (oszlopok, kitöltések, víz, folyók, sraffozás) a `style.css` `--accent` változóját használják (a színt egyetlen helyen, az `--accent`-nél lehet hangolni; 2026-11-25-i felhasználói döntés: `#027CFF`, ami fehéren csak ~3,9:1, ezért kis szöveg színe SOHA nem `--accent`: szöveg `--fg` + akcentus aláhúzás/keret, vagy nagy félkövér (>= 18,66px bold) szöveg). Ugyanaznap a felhasználó döntött a kártyákról is: a tartalmi blokkok lekerekítettek (`--radius-card`, 12px; gombok/mezők/tooltip 8px), a kártyák háttere a pasztell szürke `--surface`, a számokat tartalmazó listák keretes táblázatok (`--frame` keret, ami az `--accent`). Továbbra is tipográfia-vezérelt, semmi árnyék/gradiens/glassmorphism. Ha bizonytalan vagy, kevesebb dekoráció felé dönts. Ne vezess be "AI-generált design klisét" (krémszín+terrakotta, neon-zöld dark mode, stb.).
3. **`?v=N` cache-busting KÖTELEZŐ**: minden `script.js`/`style.css`/`water.js` módosításnál bővítsd a megfelelő verziószámot: a `script.js?v=` és `style.css?v=` az `index.html`-ben (utána `python3 tools/build_pages.py`, hogy a generált oldalak is megkapják), a `water.js?v=` a `script.js` `WATER_JS_URL` konstansában (a generált oldalak vízpanel-töredékét, a `/water-panel.html`-t a `script.js` `WATER_PANEL_URL` konstansa tölti `?v=N`-nel; ha az `index.html` `#water-panel` markupja változik, ezt a `?v=`-t is emeld, és emeld a `script.js` `?v=`-jét is) (a `vizallas.js?v=` a `water.js` `VIZALLAS_JS_URL`-jében ÉS a `tools/build_pages.py` `VIZALLAS_JS`-ében van, együtt emelendő, és a generált `/vizallas/` oldalak script-címkéjét is frissíteni kell; a `water.js` lusta betöltéssel jön, nincs `<script>` címkéje; ha a `water.js` változik, a `script.js`-t is érinti ez a módosítás, ezért annak `?v=`-jét is emeld), különben a felhasználók akár 4 óráig a régi verziót kapják (Cloudflare Pages custom-domain kvirk, lásd ARCHITECTURE.md).
4. **Ne adj hozzá funkciót kéretlenül**: ez tanulóprojekt, a felhasználó kifejezetten kérte, hogy ne vigyük túlzásba. Ha fejlesztési ötleted van, írd le a válaszod végén, ne valósítsd meg kéretlenül.
5. **Fibonacci térköz-skála**: a CSS `--sp-1` … `--sp-6` (8/13/21/34/55/89px) egy tudatos rendszer (szoros = összetartozó elemek, tágabb = csoportváltás), ne cseréld le tetszőleges értékekre.
6. **A radar-animáció adatvezérelt, nem időzített**: egy kör adata EGYBEN érkezik meg (egyetlen Open-Meteo hívás), és pont SOSEM villanhat fel előbb, mint ahogy az a válasz megérkezett. A sugár csak akkor nő, ha az előző kör válasza megjött ÉS nem volt benne találat. A megjelenítés viszont úgy működik, mint egy igazi radarernyőn: a pásztázó vonal festi fel a pontokat, ahogy elhalad az irányuk fölött (`radarRevealTier`). Ez nem kitalált lekérdezési ütem, hanem a már meglévő adat festési módja: a pásztázás soha nem tesz úgy, mintha pontonként kérdeznénk le. A `RADAR_SWEEP_MS`-t és a `style.css` `#radar-sweep` animációját együtt kell tartani, különben elcsúszik a vonal és a pontok.
7. **Kommit- és PR-szövegek**: kövessd a git history stílusát (részletes, a "miértet" is leíró commit message-ek).
