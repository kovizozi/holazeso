# Vízállás-oldalak: interaktív grafikonok, térkép, beágyazás

A 2026-11-25-i felhasználói visszajelzés alapján (`1e32bb1` utáni állapot). Megvalósítás: Sonnet ügynök, fázisonként egymás után. Minden fázisban érvényes a `CLAUDE.md` (nincs em dash, `--sp-*` térköz, fekete/fehér plusz `--accent`, `?v=N` bővítés), Open-Meteo tesztben mindig mockolva, nincs commit.

## A felhasználó kérései (eredeti tartalom szerint)

1. A `/vizallas/` oldalakon az ábrák nem érnek ki a tartalomoszlop szélére, mint a szöveg.
2. Az oszlopokon nincs hover (az SVG `<title>` nem elég, érintőképernyőn semmi). Minden diagram minden elemének legyen hoverje, ami kiírja az adott paramétereket.
3. 10 éves nézetben nem látszik a valaha mért legalacsonyabb és legmagasabb szint.
4. A felső, elmúlt napos vonalon sincs hover; kell egy éves (napi) grafikon, rajta a min és max jelölve, dátummal. A tavaknál ugyanígy.
5. Térkép az oldalon: az adott folyó vagy tó kiemelve, a többi víz szürkén, kattintásra átvisz a másik vízre.
6. Készültségi szintek (I., II., III. fok) és előrejelzés a grafikonon.
7. Nagyobb grafikon; vonaldiagram-szerű: a min és max közötti sáv halványan színezve, benne az átlag vonala.
8. A főoldali vízpanelről (folyók, tavak vízállása) el lehessen jutni a külön oldalra; ahol az elmúlt napok látszanak, legyen jelzés, hogy van részletesebb adat.
9. Szabályos diagramok: cím, tengelyek, tengelyfelirat, mértékegység.
10. Letöltés PNG-ként gombnyomásra; a képre kerüljön rá a forrás és a holazeso.hu.
11. Beágyazás más oldalba, választható méretben, a grafikon "⋯" menüjéből.

## Döntések

- **Egy kliensoldali renderelő**: új `vizallas.js` (csak a `/vizallas/*` és a beágyazó oldalakon, `extra_scripts`, `?v=N`), kis méretű, nem a `water.js`. A statikus SVG-oszlopok helyett ez rajzol. A keresőknek a mondatok (rekordok, mai érték) a HTML-ben maradnak; a grafikon helye `aspect-ratio`-val előre foglalt (nincs CLS). JS nélkül egy rövid szöveges összefoglaló marad.
- **Adat**: a generátor állomásonként `data/vizallas/<allomas-slug>.json`-t ír (éves sor, utolsó ~400 nap napi értékei, 8 napos óránkénti történet, előrejelzés, készültségi szintek, forrásmegjelölés). Ugyanezt tölti a beágyazó oldal is. A `water-history.json` kap egy `daily` részt (utolsó ~400 nap, `[dátum, cm]`), a `--fetch-history` frissíti (idei + tavalyi tábla).
- **Két grafikon állomásonként**:
  - **Friss**: szűrők `8 nap` (óránként, a snapshot történetéből), `30 nap`, `1 év` (napi). Vonal a mért értékekkel, előrejelzés szaggatott folytatásként (ha van), vízszintes vonalak a készültségi szintekre (I/II/III fok, ha ismert), a nézet min és max pontja dátummal felcímkézve, "ma" pont.
  - **Hosszú távú**: szűrők `10 év`, `30 év`, `50 év`, `összes` (évenként, évenként, 5 év, évtized, mint most). Halvány `--accent` sáv a min és max között, erős vonal az átlagra. A valaha mért min és max mindig látszik: ha a nézet tartományán kívül esik, vízszintes szaggatott referenciavonal felirattal ("valaha legalacsonyabb: -1 cm, 1954. jan. 15."), ha belül, pont és felirat. A nézet saját min/max-a is jelölve. Más forrásból származó évek (Balaton-átlag, burgenlandi adat) sávja sraffozott vagy halványabb, a még nem teljes év szaggatott, jelmagyarázattal.
- **Hover**: célkereszt (függőleges vonal) a mutató alatti időpontnál, tooltip minden paraméterrel (időszak, min dátummal, átlag, max dátummal, forrás). Egér: `pointermove`; érintés: koppintás; billentyűzet: a grafikon fókuszálható, nyilakkal léptethető. A meglévő `mapPopupShow` stílusát követi.
- **Szabályos diagram**: cím (a figure része), y tengely felirata "Vízállás (cm, a mérce 0 pontjához)", x tengely "Év" vagy "Dátum", rácsvonalak, jelmagyarázat.
- **Méret**: a tartalomoszlop teljes szélessége; asztali nézetben kb. 16:9, mobilon magasabb arány (kb. 4:3).
- **"⋯" menü** grafikononként: "Letöltés PNG-ként" (SVG -> canvas 2x, fehér háttér, a CSS-változók kiszámolt értékével, rajta cím, szűrő, "Forrás: hydroinfo.hu (OVF) · holazeso.hu"), "Beágyazás" (iframe-kód: kicsi 480x300, közepes 640x400, nagy 960x540, másolás gomb).
- **Beágyazó oldal**: `/beagyaz/vizallas/?allomas=<slug>&grafikon=friss|hossz&nezet=<szűrő>`, egyetlen generált statikus oldal, `noindex` a `_headers`-ben, kis "holazeso.hu" link (target _blank) és forrás a sarokban, világos/sötét a `prefers-color-scheme` szerint.
- **Térkép**: a generátor rajzolja statikus SVG-ként (JS nélkül is kattintható `<a>` elemek) a `water-geo.json` és a `borders.json` alapján: országhatár, minden folyó és tó szürkén, az aktuális víz `--accent`-tel, állomáspontok névvel. Hover kiírja a víz nevét. Az áttekintő `/vizallas/` oldalon is legyen, ott minden víz kattintható.
- **Főoldal**: a vízpanel folyó- és tó-listájában a nevek linkek a `/vizallas/<slug>/` oldalra, a "elmúlt napok" grafikon alatt "Részletes adatok és 150 év vízállása" link. Ez a `water.js` és a vízpanel-markup módosítása: `water.js?v`, `WATER_PANEL_URL ?v`, `script.js ?v` emelés.

## Fázisok

1. Adat: `daily` rész, `data/vizallas/*.json`, tb-kódok minden állomásra (ha van), készültségi szintek és előrejelzés-szemantika (külön kutatás eredménye alapján).
2. `vizallas.js` renderelő: két grafikon, szűrők, hover, tengelyek, jelmagyarázat, méret; a statikus oszlopdiagram kivezetése.
3. "⋯" menü: PNG-letöltés, beágyazó kód, `/beagyaz/vizallas/` oldal.
4. Térkép a vízoldalakon és az áttekintőn.
5. Főoldali vízpanel linkjei.
6. Ellenőrzés: kétszeri generálás változás nélkül, `node --check`, em dash grep, Playwright képernyőképek (390 és 1280, világos és sötét, minden szűrő), CLS mérés a vízoldalon, PNG-letöltés kipróbálása, beágyazás egy helyi teszt-HTML-ben.
