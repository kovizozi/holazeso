# Architektúra és működés

Ez a dokumentum a `README.md`-nél részletesebben leírja, *hogyan* működik
belülről a rendszer, és felsorolja azokat az üzemeltetési buktatókat, amiket
menet közben fedeztünk fel. A `README.md` a "hogyan futtasd/deployold"
kérdésekre válaszol, ez a fájl a "hogyan működik belülről és mire figyelj"
kérdésekre.

## Áttekintés: két különálló projekt

- **`holazeso-v0/`** (ez a repó): a statikus weboldal. GitHub → Cloudflare
  Pages, Git-integrációval automatikus deploy minden `main` push-ra.
- **`holazeso-push-worker/`** (külön repó, külön Cloudflare Worker): a
  push-értesítés háttérrendszere. Ez az egyetlen rész, ami "backend"-nek
  számít; mindkettő a `Kovizozi@gmail.com's Account` Cloudflare fiók alatt fut.

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

**API-terhelés**: a rácspontokról CSAK azt kérdezzük le, esik-e ott most
(`current=precipitation`). Az órás előrejelzés (mikor áll el, mekkora
eséllyel) egyedül a felhasználó saját helyére kell, azt a `fetchUserForecast`
külön, párhuzamosan kéri le. Amíg ez egyben ment, a kérés súlya átlépte az
Open-Meteo percenkénti limitjét (429). A koordinátákat 4 tizedesre kerekítve
küldjük (`coord`), különben a legtávolabbi adag URL-je túllépi a szerver
8 KB-os korlátját (414). A `destinationPoint` a hosszúsági fokot visszaforgatja
a [-180, 180] tartományba, mert a legtávolabbi gyűrűk átlógnak a dátumvonalon
(ezek nélkül a távoli keresés egyáltalán nem működött).

**Névfeloldás (`findNearbyName`)**: a legközelebbi esős rácspontnak gyakran
nincs neve (pl. tenger felett van). Ilyenkor a pont körül egyre táguló
gyűrűkben (20/60/150 km) keresünk nevesíthető helyet, párhuzamos
lekérdezésekkel. **Fontos**: ha a névadó pont eltolódott az eredeti esős
ponttól, a kiírt távolságot/irányt/térkép-linket a **névadó pont**
koordinátáihoz kell számolni (`distanceKm`, `bearingBetween`), nem az eredeti
esős ponthoz, különben a kiírt szám nem egyezik a mutatott névvel. (Ez egy
valós hiba volt, amit javítottunk: egy angliai teszt esetén 300 km-t írt ki
"Mattishall" mellé, miközben Mattishall valójában csak 150 km-re volt.)

A "Közelben"/"Távolban" címke mindig a **valódi esős pont** távolságán
alapul (70 km a küszöb), függetlenül attól, hogy a névadó pont esetleg
messzebb van.

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

Egy Cloudflare Worker `fetch` (HTTP: `/subscribe`, `/unsubscribe`) és
`scheduled` (Cron Trigger, percenként) handlerrel.

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
