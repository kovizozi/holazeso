# Architektúra és működés

Ez a dokumentum a `README.md`-nél részletesebben leírja, *hogyan* működik
belülről a rendszer, és felsorolja azokat az üzemeltetési buktatókat, amiket
menet közben fedeztünk fel. A `README.md` a "hogyan futtasd/deployold"
kérdésekre válaszol, ez a fájl a "hogyan működik belülről és mire figyelj"
kérdésekre.

## Áttekintés: három rész

Az oldal maga statikus, de mögötte van egy kis backend, két darabból:

- **`holazeso-v0/`** (ez a repó): a statikus weboldal (HTML/CSS/JS, build
  nélkül). GitHub → Cloudflare Pages, Git-integrációval automatikus deploy
  minden `main` push-ra. Az esőkeresést, a "részletek és statisztika"
  panelt és a saját hely talajprofilját a böngésző közvetlenül kéri le
  (Open-Meteo, BigDataCloud).
- **`holazeso-push-worker/`** (külön repó, Cloudflare Worker + KV): a
  backend publikus része. Két feladata van:
  1. push-értesítések: `/subscribe`, `/unsubscribe`, és egy percenkénti cron,
     ami az Open-Meteótól lekéri a feliratkozók helyének csapadékát;
  2. a vízadat-panel adatainak kiszolgálása: a `/*-snapshot` végpontok a
     KV-ben tárolt pillanatképeket adják vissza a böngészőnek (`GET`), és
     fogadják a frissítést az otthoni jobtól (`POST`, Bearer token).
  Deploy kézzel: `npx wrangler deploy`.
- **`soil-moisture-mapper`** (külön repó, otthoni gépen, Docker
  containerben): a backend adatgyűjtő része. Óránként lekéri az országos
  talajnedvesség-rácsot (Open-Meteo, ~350 pont) és lekaparja a hydroinfo.hu
  folyó- és tó-vízállás tábláit, majd a pillanatképeket `POST`-olja a
  workernek. A csatorna-térkép (`app/channels.py`) és a domborzat
  (`app/elevation.py`) egyszeri, kézzel futtatott szkript. Azért fut
  otthon és nem a böngészőben, mert egy országos lekérés látogatónként
  felélné az Open-Meteo kvótát, a hydroinfo.hu-nak pedig nincs CORS-a.

Adatfolyam a vízadatokhoz:

```
hydroinfo.hu, Open-Meteo
        │  óránként
        ▼
soil-moisture-mapper (otthon, Docker) ──POST, Bearer──▶ push-worker KV
                                                          │ GET (CORS: csak éles origin)
                                                          ▼
                                                  böngésző (script.js)
```

Ha az otthoni gép áll, az oldal tovább működik: a vízadat-panel az utolsó
feltöltött pillanatképet mutatja, a "frissítve" sor jelzi, mennyire régi.
A Pages és a Worker a `Kovizozi@gmail.com's Account` Cloudflare fiók alatt
fut.

## A esőkereső algoritmus (`script.js`)

Nincs fix településlista. A `run(userLoc)` a felhasználó koordinátája köré
dinamikusan generál egy keresési **rácsot** (`generateSearchGrid`): gyűrűk ×
irányok, a gömbi navigációs képlettel (`destinationPoint`) kiszámolt
pontokkal. Ez azért jobb, mint egy fix településlista, mert bárhol a Földön
egyformán pontos.

**Fokozatosan táguló keresés** (`SEARCH_RINGS`): hat adag, mindegyik egyetlen
Open-Meteo hívás. Az első csak 150 km-ig néz (48 pont), a következők 150
km-enként lépnek kijjebb (300, majd 450 km), és csak utána gyorsul a lépés
(900, 2500, végül 9000 km), hogy távoli eső esetén se kelljen tucatnyi kört
végigvárni. Minden adag CSAK az új gyűrűt méri fel, a belsőt az előzőek már
lefedték. Ez azért kell, mert egy fix, szűk rács sokszor "Sehol"-t mondott
volna olyankor is, amikor valójában volt eső, csak a rács nem talált rá.

**A gyűrűk pontsűrűsége**: egy gyűrűn nem fix számú irányt kérdezünk le,
hanem annyit, amennyi a kerületéhez illik (6-tól 42-ig). Fix 12 iránnyal a
szomszédos pontok 30 km-en 16 km-re, 9000 km-en viszont már 4712 km-re estek
egymástól, vagyis kint egész esőrendszerek elfértek volna két pont között.

### API-terhelés és kvóta

Ezt fontos pontosan érteni, mert a keresés méretét ez korlátozza, nem a
sebesség. Az Open-Meteo ingyenes limitje **IP-nként 600/perc, 5000/óra,
10000/nap**. A súlyozás a szerver forrásából (`calculateQueryWeight`):

```
súly = Σ pontonként  max(1, max(V/10, (V/10) × (nap/14)))
```

Vagyis **minden lekérdezett pont külön 1 egységet ér**, és 10 változó / 14 nap
alatt a változók száma és a napok száma **semmit nem módosít rajta**. Ebből
két, első ránézésre meglepő következmény:

- Hiába kérünk a rácspontokról csak `current=precipitation`-t: a kvóta
  szempontjából ez ugyanannyi, mint a teljes órás előrejelzés. (A szétválasztás
  ettől még hasznos: kisebb válasz, rövidebb URL, gyorsabb hálózat.)
- Egy kérést több kérésre bontani sem segít: csak a pontok száma számít.

Ezért a teljes keresés **295 pont**, és ezért frissítünk 5 percenként, nem
percenként. A csendes háttérfrissítés ráadásul csak az 1. fázist futtatja le
(49 pont), és csak akkor megy tovább a távoli keresésre, ha a környék válasza
meg is változott.

**Egyéb API-buktatók**: a koordinátákat 4 tizedesre kerekítve küldjük
(`coord`), különben a legtávolabbi adag URL-je túllépi a szerver 8 KB-os
korlátját (414). A `destinationPoint` a hosszúsági fokot visszaforgatja a
[-180, 180] tartományba, mert a legtávolabbi gyűrűk átlógnak a dátumvonalon
(enélkül a távoli keresés egyáltalán nem működött). Egy kérésben legfeljebb
1000 pont lehet (nem dokumentált szerver-beállítás).

**Névfeloldás (`findNearbyName`)**: a legközelebbi esős rácspontnak gyakran
nincs neve (pl. tenger felett van). Ilyenkor a pont körül egyre táguló
gyűrűkben (20/60/150 km) keresünk nevesíthető helyet, párhuzamos
lekérdezésekkel. **Fontos**: ha a névadó pont eltolódott az eredeti esős
ponttól, a kiírt távolságot/irányt/térkép-linket a **névadó pont**
koordinátáihoz kell számolni (`distanceKm`, `bearingBetween`), nem az eredeti
esős ponthoz, különben a kiírt szám nem egyezik a mutatott névvel. (Ez egy
valós hiba volt, amit javítottunk: egy angliai teszt esetén 300 km-t írt ki
"Mattishall" mellé, miközben Mattishall valójában csak 150 km-re volt.)

### Országhatárok a radaron (`borders.json`)

A radar **azimutális ekvidisztáns vetület** a felhasználó körül: minden pont a
valódi távolsága és iránya szerint kerül a helyére. Ezért a határvonalakhoz
nem kell külön térképvetület, ugyanaz a `distanceKm` + `bearingBetween` pár
vetíti őket, mint a rácspontokat.

- **Forrás**: Natural Earth 1:50m `admin_0_countries` (közkincs, nem kér
  feltüntetést). Az ország-poligonok körvonalát használjuk, tehát a
  tengerpartok is megjelennek, nem csak a szárazföldi határok.
- **Előállítás**: Douglas-Peucker ritkítás 0,08 fokos tűréssel, a 0,4 foknál
  kisebb szigetek elhagyva, koordináták 2 tizedesre kerekítve. Ezután
  delta-kódolás: 0,01 fokos egész egységek, gyűrűnként az előző ponthoz
  képest. Ez 289 KB-ról 137 KB-ra viszi a fájlt (gzippel 97 KB helyett 52 KB).
  99613 csúcsból 20262 marad.
- **Betöltés**: lusta, a keresés indulásakor, és SOSEM várakoztatja a választ.
  Ha nem érkezik meg vagy hibázik, a radar határok nélkül működik tovább.
- **Rajzolás**: a határréteg mindig az aktuális legnagyobb sugárhoz igazodik,
  ezért a köröktől eltérően nem zoomoljuk, hanem minden új körnél
  újrarajzoljuk. A látható körből kilépő szakaszokat megszakítjuk (nem a
  peremre lapítjuk). Olcsó szélesség szerinti előszűrés előzi meg a gömbi
  számolást, különben kis sugárnál feleslegesen menne végig mind a 20 ezer
  csúcson.
- **Minimális vizuális sugár** (`RADAR_MIN_VISUAL_RADIUS_KM`, `script.js`):
  a tényleges keresési sugár (ahol a legközelebbi esőt találtuk) gyakran
  kisebb, mint ami a határ felismeréséhez kellene. Magyarország
  legeldugottabb pontja (a határtól legtávolabb eső hely) kb. 112 km-re van
  bármelyik határtól, ezért 220 km-es alsó korlát biztosítja, hogy a radar
  MINDIG mutasson legalább egy darab határt, bárhol állunk az országban.
  `radarEnsureMinRadius()` ezt minden keresés legvégén érvényesíti, egy
  tisztán vizuális `radarAddTier` hívással (nem keres újra).

### Folyók és a Balaton a radaron (`water-geo.json`)

Ugyanazzal az azimutális vetítéssel és lusta betöltési mintával, mint a
határok (`loadWaterGeo`/`radarDrawWaterGeo`, lásd a közös
`radarProjectRingsToPath` segédfüggvényt), csak más forrásfájlból.

- **Forrás**: Natural Earth 1:10m `rivers_lake_centerlines` (Duna, Tisza,
  Dráva) és `lakes` (Balaton). A Tisza középső szakasza az NE-adatban nem
  kapott nevet (`rivernum: 330`, `name: null`), ezért a 3 folyót
  `rivernum` alapján válogattuk ki (25/363+330/303), nem a `name` mezővel.
  A Fertő-tó és a Velencei-tó NINCS ebben a rétegben: 10m felbontáson a
  Natural Earth lakes-adata nem tartja nyilván őket külön tóként (a
  dedikált Tavak-szakasz saját, kézzel rajzolt ábrája ettől függetlenül
  mindháromat mutatja).
- **Előállítás**: ugyanaz a Douglas-Peucker + delta-kódolás, mint a
  határoknál (0,015 fok tűrés a folyóknál, 0,01 a Balatonnál, mert az
  kisebb és közelről néznénk). A fájl ~1,8 KB (12 folyó-szakasz, 1 tó-
  gyűrű) - nem kellett a határokéhoz hasonló méretoptimalizálás.
- **Rajzolás**: a folyók NYITOTT vonalként (nem gyűrűként), a Balaton ZÁRT
  gyűrűként, de mindkettő csak körvonalként (nincs kitöltés, a projekt
  monokróm/sík-design szabálya miatt) - a Balatont a folyóktól és a
  határtól egy szaggatott mintázat különbözteti meg, nem szín.

## A válasz két szakaszban (`run`)

A keresés két kérdésre válaszol, egymás után, és a radar mindkettő után
lejjebb csúszik egy lépéssel (`#result` `data-phase` attribútuma vezérli, mi
látszik; a FLIP-animációt a `slideRadar` intézi):

1. **"Esik-e X környékén?"** Ehhez csak a saját pont előrejelzése és a legelső,
   150 km-es gyűrű kell. Válasz: `Most esik` / `Hamarosan` (nálad), `Igen`
   (a környéken esik), `Nem`. Az első kettőnél nincs második szakasz: ha
   nálad esik, a "hol esik pontosan" kérdés értelmetlen.
2. **"De hol esik pontosan?"** Csak az első válasz kimondása UTÁN indul, és
   csak akkor, ha nálad nem esik. Innen tágul kifelé a keresés, amíg talál,
   majd névfeloldás után kiírja a helyet, a távolságot és az irányt. Ha
   sehol nem talált, a válasz "Sehol".

Az első szakasz válasza szándékosan nem függ a távoli kereséstől: enélkül nem
lehetne két szakaszra bontani, mert a "Közelben/Távolban/Sehol" típusú válasz
csak a teljes keresés végén derülne ki. A közel/távol információt most a
második szakasz kiírt távolsága hordozza.

## Részletek-panel és vízadat-panel

A végleges válasz (`revealPhase(PHASE_DONE)`) után két további blokk jelenik
meg a radar alatt. Mindkettő a **keresett helyre** (`currentLoc`) szól, nem
arra a településre, ahol a radar esőt talált.

### "részletek és statisztika" (`#stats-panel`, `buildStatsPanel`)

Lenyíló `<details>`, zárva indul, csak kinyitáskor kér le (31+ napos
csapadék-história, az elmúlt 3 év ugyanezen időszaka, előrejelzés,
hőmérséklet, talajnedvesség, Open-Meteo Flood API vízhozam). Nem fut bele az
5 percenkénti automatikus frissítésbe. A tetején a `#stats-place` sor
("Az adatok helye: <név>") mondja ki, melyik helyre vonatkoznak a számok.
Minden adata Open-Meteo-alapú, ezért bármely országban működik.

### Vízadat-panel (`#water-panel`, `buildWaterPanel`)

**Csak magyarországi helyszínnél jelenik meg** (`currentLoc.countryCode ===
"HU"`), mert minden adata Magyarországra vonatkozik. Ismeretlen országkódnál
sem jelenik meg; a `run()` addigra már megpróbálja pótolni reverse
geocodinggal. Külföldi helynél a hozzá tartozó lekérések sem futnak le. A
`resetWaterPanel()` minden keresés elején elrejti.

Nem lenyíló: a radar után rögtön, nyitva jelenik meg. Sorrend:

1. **Saját hely** (`#water-local-section`): a keresett pont 5 mélységi
   talajnedvesség-profilja (Open-Meteo, `fetchUserSoilProfile`), az
   országos átlaghoz mérve. Legfelül, mert ez szól a keresett helyre. A
   lekérése a snapshotokkal együtt, ugyanabban a `Promise.all`-ban indul
   (saját `.catch`-csel), és elsőként rajzolódik ki, hogy később ne ugorjon
   be az országos adatok fölé. Ha nem jön meg, csak ez a szekció marad
   rejtve.
2. **Országos adatok** ("mennyi víz van összesen az országban?" cím és
   tartalomjegyzék alatt): talajvíz Balatonokban, talajnedvesség-dombormű,
   folyóhálózat, élő folyó-mércék, csatorna-térkép (lustán, látótérbe
   érve tölt), vízmérleg, tavak.

**Adatforrás**: a `holazeso-push-worker` KV-jében tárolt pillanatképek
(`GET /soil-snapshot`, `/rivers-snapshot`, `/lakes-snapshot`,
`/channels-snapshot`). Ezeket egy külön repó, a `soil-moisture-mapper`
otthoni gépen futó jobja tölti fel óránként (a csatornákat alkalmanként,
kézzel), Bearer tokenes `POST`-tal. A folyó- és tó-vízállás a hydroinfo.hu
(OVF) méréseiből, a talajnedvesség az Open-Meteo modelljéből jön. Statikus
fájlok mellette: `water-geo.json` (folyók, Balaton), `borders.json`
(országhatár), `elevation.json` (domborzat a csatorna-térképhez).

**Lokális tesztelés**: a worker CORS-a csak az éles originekre válaszol, ezért
`localhost`-ról a vízadat-panel "a vízadatok most nem érhetők el" üzenettel
áll meg. Ez nem hiba. Teszteléshez a kéréseket éles `Origin` fejléccel kell
továbbítani (pl. Playwright `page.route`).

## Push-értesítés rendszer

### Kliens oldal (`script.js`, `sw.js`)

A "értesíts, ha esni kezd" gomb a `Notification.requestPermission()` +
`PushManager.subscribe()` böngésző API-kat használja, a VAPID nyilvános
kulccsal (`VAPID_PUBLIC_KEY` konstans a `script.js`-ben). A feliratkozást
(endpoint + kulcsok + mentett hely) elküldi a Worker `/subscribe`
végpontjának. A `sw.js` egy `push` eseménykezelőt tartalmaz, ami megjeleníti
az OS-szintű értesítést.

**iOS-korlát**: iPhone/iPad-en a Safari csak akkor engedélyezi a
`PushManager`-t, ha az oldal telepített (kezdőképernyőre kitett) appként fut,
sima böngészőfülben a `PushManager` API elérhetetlen. Ez Apple szándékos
platformkorlátozása, nem javítható a kódunkból. Mac-es Safari-n (16+) ez a
korlátozás nincs, ott böngészőfülben is működik.

### Worker (`holazeso-push-worker/src/index.js`)

Egy Cloudflare Worker `fetch` (HTTP: `/subscribe`, `/unsubscribe`, valamint
a vízadat-panel pillanatképei: `GET`/`POST /soil-snapshot`, `/rivers-snapshot`,
`/lakes-snapshot`, `/channels-snapshot`, ld. "Vízadat-panel" fent) és
`scheduled` (Cron Trigger, percenként) handlerrel. A snapshot-`POST`
szerver-szerver hívás, a `SOIL_SNAPSHOT_TOKEN` secret-tel hitelesítve, nem a
CORS-allowlist-tel.

**Tárolás: EGYETLEN KV kulcs.** Eredetileg minden feliratkozás saját KV
kulcs alatt volt (`endpoint` → rekord), és a cron minden körben
`list()`-elt, minden kulcsot egyenként `get()`-elt, majd minden rekordot
feltétel nélkül visszaírt (`put()`). Ez **egyetlen feliratkozóval, percenkénti
cron mellett is** túllépte a Cloudflare KV ingyenes csomagjának napi 1000
írás/listázás limitjét (1440 tick/nap > 1000). Ezért most **egyetlen KV
kulcs** (`subscriptions`) alatt egy JSON tömbben van minden feliratkozás:
körönként 1 olvasás, és írás **csak akkor**, ha ténylegesen változott
valami (nem minden tick-nél). Ez a napi művelet-számot gyakorlatilag
függetlenné teszi a feliratkozók számától.

**Cooldown-logika**: minden feliratkozásnak van egy `state` mezője
(`"dry"` vagy `"wet_notified"`) és egy `dryStreakStart` időbélyege.
Értesítés csak akkor megy ki, ha esik ÉS legalább 2 órája
(`DRY_STREAK_REQUIRED_MS`) száraz volt előtte; ez akadályozza meg, hogy egy
hosszan tartó esőnél percenként új értesítés menjen. Küldés után a
feliratkozás "wet_notified" állapotba kerül, és csak akkor tér vissza
"dry"-ra (és kezdi újra számolni a száraz streaket), amikor tényleg eláll az
eső. **Csak sikeres (201-es) küldés után** áll be "wet_notified"-ra; ha a
küldés hibázik (nem lejárt előfizetés, csak pl. átmeneti hálózati hiba), a
következő percben újra próbálkozik.

**Titkosítás**: `@pushforge/builder` csomag, natív Web Crypto API-t használ
(nem Node.js `crypto`-t), ezért `nodejs_compat` flag nélkül is fut
Cloudflare Workers-en. A VAPID privát kulcs Wrangler secret-ként van tárolva
(`VAPID_PRIVATE_KEY`), nincs commitolva sehova.

**CORS**: csak a `holazeso.hu`/`holazeső.hu`/`xn--holazes-8mb.hu` originek
engedélyezettek.

## PWA (`manifest.json`, `sw.js`, ikonok)

Telepíthető appként (Android "Install", iOS "Add to Home Screen"). A
`sw.js` egy egyszerű stale-while-revalidate cache-t tart fenn a saját
eredetű statikus fájlokra.

**Fontos csapda, amit javítottunk**: a service worker eredetileg **minden**
azonos eredetű GET-et cache-elt, beleértve magát a navigációs kérést
(`index.html`-t) is. Mivel az `index.html` hordozza a `script.js?v=N` /
`style.css?v=N` cache-busting hivatkozásokat (lásd lent), ez azt
jelenthette, hogy egy telepített app **örökre megragad egy régi
verziónál**: a cache-elt régi `index.html` mindig a régi `?v=N`-re
hivatkozna. Ezért a `sw.js` mostantól sosem cache-eli a navigációs
kéréseket (`event.request.mode === "navigate"`), és `skipWaiting()` +
`clients.claim()` segítségével a service worker frissítése is azonnal
átveszi az irányítást, nem várja meg, hogy az app minden nyitott példánya
bezáródjon.

**Automatikus frissítés**: mivel telepített (standalone) módban nincs
böngésző-frissítés gomb, az app percenként újralekérdezi az időjárást,
amíg látható (`shouldAutoRefresh()`: csak akkor fut, ha a lap látható ÉS
van kiválasztott hely ÉS az eredmény-nézet aktív), plusz azonnal frissít,
amikor visszaválasztod az appot (`visibilitychange`).

## Design-rendszer

Szigorúan monokróm (fekete/fehér, sötét módban megfordítva
`prefers-color-scheme`-mel), tipográfia-vezérelt, nincs szín/gradiens/
árnyék. A bal felső sarokban eredetileg egy nagybetűs, ritkított
"HOLAZESO.HU" felirat volt, ezt (mint tipikus SaaS-sablon mintát)
eltávolítottuk; a domain csak a láblécben szerepel.

**Térköz-rendszer**: nem egyenletesen nagyobb margók, hanem egy
Fibonacci-skála (`--sp-1` … `--sp-6`: 8/13/21/34/55/89 px), szerep szerint
kiosztva: szoros távolság (8-13px) egy szemantikailag összetartozó
elempáron belül (pl. kérdés → rá adott válasz), arányosan nagyobb ugrás
(34px) csoportváltásnál (fő válasz blokk → pontos hely blokk), legnagyobb
(89px) a tartalomtól teljesen független részek előtt (pl. lábléc).

## Üzemeltetési buktatók

### `?v=N` cache-busting: KÖTELEZŐ minden script.js/style.css módosításnál

A `holazeso.hu` custom domain (ismeretlen okból, Cloudflare Pages-kvirk)
**nem veszi figyelembe** a `_headers` fájl `no-cache` szabályát
`script.js`/`style.css`-re, a böngészők akár 4 óráig a régi verziót
cache-elhetik. Az `index.html`-ben ezért `script.js?v=N` / `style.css?v=N`
szerepel: **minden alkalommal, amikor módosítod ezeket a fájlokat, bővítsd a
megfelelő `?v=N` számot** az `index.html`-ben. Az `index.html` maga mindig
frissen töltődik (`max-age=0, must-revalidate`), ezzel nincs teendő.

Diagnosztizálva, de nem megoldva: miért nem tartja tiszteletben a domain a
`_headers`-t. A direkt `*.pages.dev` URL helyesen `no-cache`-t ad, csak a
custom domainen keresztül nem, valamilyen Cloudflare Pages
custom-domain-routing sajátosság, nem zóna-szintű cache-beállítás
(Page Rules, Cache Rules egyike sem érintett, purge sem oldja meg tartósan).

### Cloudflare KV ingyenes limitek

Napi **1000 írás/listázás/törlés**, napi **100 000 olvasás**, lásd fentebb
a "Tárolás: EGYETLEN KV kulcs" szakaszt. Ha valaha nagyon sok feliratkozó
lenne (több ezer), a jelenlegi egyetlen-blob megoldás mérete és a
körönkénti Open-Meteo hívások darabszáma (100-as csoportokban) újra
átgondolandó, de hobbi-projekt méretben bőven elég.

### KV write-migráció óvatosan

Ha valaha újra átalakul a KV tárolási formátum, a régi adatokat explicit
migrálni kell (kiolvasni a régi formátumban, beírni az újban); automatikus
migráció nincs beépítve, és a napi limit alatt kell maradni a migráció
közben is.

## SEO

`robots.txt`, `sitemap.xml`, JSON-LD (`WebSite` schema), Open
Graph + Twitter card meta tagek, generált `og-image.png` (1200×630,
monokróm, a felhő-favicon nagyított változatával). A tényleges válasz-
tartalom kliens-oldalon, a felhasználó helyzete alapján generálódik, ezért
keresőrobot szempontjából nincs "indexelhető" tartalma az egyes
válaszoknak (ez a projekt jellegéből adódik, nem hiba); a SEO itt a
márka/domain felismerhetőségéről szól, nem tartalom-rangsorolásról.

## UX-átalakítás (2026. nov.): új statikus fájlok és komponensek

- `places-hu.json`: kb. 140 magyar település (n, lat, lon, r = rang 1-3). A radar, a talajtérkép és a csatorna-térkép feliratai és a talajcellák nevei használják (`loadPlaces`).
- `counties-hu.json`: megyehatárok (geoBoundaries, CC BY 4.0, egyszerűsítve), a nagyított csatorna-térképen pontvonal.
- `cigand.json` (kézzel karbantartott: tények, időrend, források, `active`, `updated`) és `cigand-geo.json` (OpenStreetMap-kivonat, egyszer előállítva): a vízpanel tetején álló Cigánd-blokk (`buildCigand`). `active: false` esetén egy soros összefoglalóvá zsugorodik és az országos szakaszok alá költözik. A negyedik, mért csempe csak akkor jelenik meg, ha a rivers-snapshotban van "Dombrád" állomás.
- Ábraszélességek: `.fig-narrow/.fig-medium/.fig-wide` (420/720/960 px) és a `--ar` képarány a magasságot a nézet 70%-ára korlátozza.
- Közös buborék: `mapPopupShow` / `popupSparklineSvg` (talajtérkép, folyóhálózat, csatorna-térkép, Cigánd-térkép).
- A radar nagyítása (`radarZoomTo`) csak a keresés VÉGE után a megjelenített sugarat (`radarMaxRadiusKm`) változtatja; a `RADAR_SWEEP_MS`-t és a pásztázó animációt nem érinti. A feliratok méretét a `--k` (képpont/viewBox-egység) tartja állandóan.
- A csatorna-térkép egy kattintásra aktiválódik (`is-active`), utána a sima görgő nagyít; Escape vagy kívülre kattintás elengedi.
- A 0 literes (adat nélküli) talajcellák nincs-adatnak számítanak a talajtérképen és a fejsorban.
- A Tisza-tó nincs a tó-kártyák között (nincs valódi tó-mérce); a Velencei-tó körvonala kézzel rajzolt séma.
