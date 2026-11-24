# SEO- és funkcióterv (holazeso.hu)

A 2026-11-24-i SEO-áttekintés alapján (`206c1ed` utáni állapot). Megvalósítás: Sonnet ügynökök, fázisonként egymás után (mind a `script.js`-t és az `index.html`-t érinti, ezért nem párhuzamosan).

Minden fázisban érvényes: `CLAUDE.md` szabályai (nincs em dash, `--sp-*` térköz, fekete/fehér plusz `--accent`, `?v=N` bővítés, radar-animáció adatvezérelt marad), Open-Meteo tesztben mindig mockolva (közös IP az otthoni gyűjtővel), nincs commit, csak a munkafa.

## Közös döntések

- **Generált statikus oldalak**: egyetlen Python-generátor (`tools/build_pages.py`, csak standard könyvtár) állít elő minden aloldalt az `index.html`-ből mint sablonból. A kimenet bekerül a repóba (mint a `cigand-news.json`), egy GitHub Action futtatja (napi cron + push, ha a sablon vagy az adatfájl változott), és csak változás esetén kommitol. Így nem kell Cloudflare-beállítás.
- **Abszolút útvonalak**: az aloldalakon minden asset `/style.css?v=N`, `/script.js?v=N`, `/places-hu.json` stb. A generátor a sablon relatív hivatkozásait átírja; a `script.js`-ben a `fetch` hívások is legyenek gyökér-abszolútak (ellenőrizni mind).
- **Slug**: ékezet nélküli kisbetű, kötőjellel (`kecskemet`, `szekesfehervar`, `hodmezovasarhely`).
- **URL-szerkezet**: `/eso/<slug>/`, `/vizallas/`, `/vizallas/<folyo-vagy-to>/`, `/cigand/`, `/ho/`, `/widget/`.
- **Adathitelesség**: generált oldalra csak olyan szám kerül, aminek a forrása ellenőrzött. A tóadatok (Balaton Siófok 44 cm, Velencei-tó 16 cm, Fertő 2 cm) még nincsenek összevetve a hivatalos értékkel: 2. fázis első lépése.

## 1. fázis: főoldali váz, településoldalak, sitemap

1. **Főoldal**
   - Title: `Hol esik most? Esik nálad? | hol az eső?`; og/twitter title ugyanez.
   - Meta description 150 karakter alatt.
   - Látható statikus `<h1>` (pl. "Hol esik most?") és 1-2 rövid bekezdés az alkalmazás alatt, a láblécnél (mit csinál az oldal, honnan jön az adat). A meglévő dinamikus `#q1-question` maradjon, de legyen `h2` vagy maradjon h1 egy olyan szakaszban, ami nem `hidden` a HTML-ben; egy oldalon egy látható h1 legyen.
2. **Ragozott helynév-tábla**: `places-hu.json` minden elemébe `slug` és `loc` (helyhatározós alak: Kecskeméten, Szegeden, Pécsett, Győrben, Budapesten, Egerben, Vácon). Kézzel, a magyar helyesírás szerint; amelyikben bizonytalan vagy, jelöld a riportban.
3. **Településoldal** `/eso/<slug>/index.html`:
   - title: `Esik most {loc}? Eső és radar | hol az eső?`, egyedi description, canonical, og:url.
   - statikus h1 ("Esik most {loc}?") és rövid bevezető, benne 2-3 klímaadat (éves átlagos csapadék, legcsapadékosabb hónap, esős napok száma), `climate-hu.json`-ból.
   - `climate-hu.json`: Open-Meteo archive (ERA5, 1991-2020 vagy 2001-2025) alapján, a generátor csak a hiányzó helyekre kéri le, a GitHub Actionben (nem az otthoni IP-ről). Lokálisan legfeljebb 3 helyre szabad tesztelni.
   - `<script>window.HOLAZESO_PLACE = {name, lat, lon}</script>` a `script.js` előtt; a `script.js` indításkor ezt használja az automatikus helymeghatározás és a mentett hely helyett (de el NEM menti, és nem törli az URL-t).
4. **Megosztás**: a megosztó gomb, ha a hely 3 km-en belül egy listás település, `/eso/<slug>/` linket ad; különben marad a `?lat=&lon=&name=`.
5. **Sitemap**: a generátor írja, minden URL-lel és `lastmod`-dal. `robots.txt` hivatkozzon rá.
6. **Workflow**: `.github/workflows/build-pages.yml` (push a mainre, ha `index.html`, `places-hu.json`, `climate-hu.json`, `tools/**` változik; napi cron 05:23; `workflow_dispatch`), kommit csak változáskor, `git pull --rebase` a push előtt.
7. Főoldal alján egy egyszerű "Települések" lista linkekkel (a 141 oldalt így a robot is megtalálja). Kompakt, többhasábos.

## 2. fázis: vízállás-oldalak és Cigánd-oldal

1. **Ellenőrzés**: a tó- és folyóértékeket vesd össze a hivatalos forrással (hydroinfo.hu, vizugy.hu) legalább 3 állomásra. Ha egy forrás nem egyezik, azt az állomást/tavat hagyd ki a generált oldalakból, és írd le a riportban.
2. A generátor a worker pillanatképeit kéri le (`/rivers-snapshot`, `/lakes-snapshot`, `Origin: https://holazeso.hu` fejléccel).
3. `/vizallas/` (áttekintő táblázat), `/vizallas/<slug>/` folyónként és tavanként (Duna, Tisza, Rába, Maros, Hármas-Körös, Dráva, Balaton, Velencei-tó, Fertő, ami az ellenőrzésen átment). Title pl. `Tisza vízállás ma: Szeged, Szolnok | hol az eső?`.
4. Az aktuális érték **mondatként a HTML-ben**: "A Tisza vízállása Szegednél ma 266 cm, 12 cm-rel alacsonyabb, mint egy hete." (a `history`-ból). Mérés időpontja és forrás feltüntetve. Kis statikus SVG-sparkline a történetből, JS nélkül.
5. `/cigand/`: a `cigand.json` tényei és időrendje, a `cigand-news.json` legutóbbi hírei, szövegként. A Cigánd-hírfigyelő workflow új hír esetén indítsa a build-pages workflow-t (`gh workflow run` vagy `workflow_call`).
6. A főoldali vízpanel alján linkek ezekre az oldalakra.
7. A napi cron ezeket frissíti; ha a worker nem elérhető, az előző oldal marad (nem ír üreset).

## 3. fázis: funkciók

1. **"Mikor áll el? / Mikor ér ide?"**: Open-Meteo `minutely_15=precipitation` a felhasználó helyére, a következő 2-4 órára (ha már van hívás a helyre, abba tedd bele, ne új kérést). Egy mondat a válasz alatt:
   - ha esik: "Még kb. 40 percig esik." (első 15 perces szelet 0,1 mm alatt; ha a 4 órán belül nincs ilyen: "A következő órákban is esik.")
   - ha nem esik, de jön: "Kb. 20 perc múlva érhet ide."
   - ha nem jön: semmi, vagy "A következő 2 órában nem várható nálad." (egy mondat, szerényen fogalmazva, ez előrejelzés).
   A radar-animáció logikájához nem nyúlhatsz.
2. **Hó és ónos eső**: a válasz szövege kövesse a csapadék típusát (`snowfall` > 0: "havazik", `weather_code` 56, 57, 66, 67: "ónos eső"). Ehhez a keresés kéréseibe a szükséges mezők kerüljenek bele.
   - **Hómód** `/ho/` oldal (generált, title "Hol esik most a hó? | hol az eső?"): ugyanaz a keresés, de csak a havazást keresi (`snowfall`). A `window.HOLAZESO_MODE = "ho"` váltja. A főoldalon novembertől márciusig egy kis szöveges link: "Hol esik a hó?".
3. **Beágyazható widget** `/widget/?hely=<slug>`: önálló, kicsi HTML+JS (NEM a teljes `script.js`), egyetlen Open-Meteo current hívás, kiírja: "Esik most Kecskeméten? Nem." és a link a `/eso/<slug>/` oldalra (target _blank). Világos/sötét a `prefers-color-scheme` szerint, max. 320x120. A településoldalon egy összecsukható "Tedd ki az oldaladra" blokk az `<iframe>` kóddal. A widget oldala `noindex`.

## 4. fázis: teljesítmény

1. A vízpanel kódja (folyók, tavak, talaj, csatornák, Cigánd) külön `water.js`-be, amit a `script.js` csak akkor tölt be (dinamikus `import()` vagy script-elem), amikor a panel a nézet közelébe ér (IntersectionObserver) vagy megnyitják. `?v=N` erre is.
2. CLS: olvasd el a `PROGRESS.md` 130-160. sorát (miért 0,297). Foglalj helyet előre a később megjelenő elemeknek (min-height, `aspect-ratio`) úgy, hogy a radar-reveal koreográfia ne változzon. Mérd Playwrighttal (PerformanceObserver layout-shift) előtte és utána, mockolt adatokkal.

## Nem kód (a felhasználó dolga)

- Google Search Console és Bing Webmaster Tools bekötése, a sitemap beküldése (`https://holazeso.hu/sitemap.xml`).
- Megosztás közösségekben (r/hungary, HUP, Prohardver, kertészkedős csoportok), helyi sajtó a Cigánd-témával.
