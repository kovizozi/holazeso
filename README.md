# holazeso.hu

"hol az eső?": egy nagyon letisztult, kérdés-válasz formátumú mikro-eszköz, ami
azonnal megválaszolja: esik-e nálad, vagy ha nem, hol a legközelebbi eső.

Nem hagyományos esőradar (azt már jól lefedi az időkép.hu és a met.hu), csak
egyetlen nagy, domináns válasz: **Nálad** / **Közelben** / **Távolban** / **Sehol**.
Ha sehol nem esik az országban, egy második kérdés jön: hol esik éppen a Földön.

A válasz alatt egy lenyíló "részletek és statisztika" panel (csapadék,
előrejelzés, hőmérséklet a keresett helyre), és magyarországi helyszínnél egy
vízadat-panel is megjelenik: a keresett hely talajnedvessége, majd országos
talajvíz, folyók, csatornák, vízmérleg és tavak.

A helyszínt az oldal alapból a böngésző helymeghatározásával próbálja kitalálni;
ha ez nem sikerül vagy nincs engedélyezve, kézi településkereső jön elő helyette.

## Technikai keret

- Maga az oldal statikus HTML/CSS/JS, de van mögötte egy kis backend, két külön
  repóban:
  - `holazeso-push-worker` (Cloudflare Worker + KV): push-értesítések, és a
    vízadat-panel pillanatképeinek kiszolgálása;
  - `soil-moisture-mapper` (otthoni gépen, Docker): óránként gyűjti a vízadatokat,
    és feltölti a workernek.

  Részletek: `ARCHITECTURE.md`, "Áttekintés".
- Nincs build lépés, nincs keretrendszer, nincs npm.
- Adatforrás: [Open-Meteo](https://open-meteo.com/) (ingyenes, API-kulcs nélkül, CC BY 4.0).
- Vízadatok: a hydroinfo.hu (Országos Vízügyi Főigazgatóság) élő vízállás-mérései
  és az Open-Meteo talajnedvesség-modellje, a külön `soil-moisture-mapper` repó
  otthoni jobja gyűjti óránként, és a push-worker KV-jében tárolja.
- Fordított geokódolás (koordinátából településnév): [BigDataCloud](https://www.bigdatacloud.com/) kliens-oldali API-ja, kulcs nélkül.
- Látogatottság: Cloudflare Web Analytics és GoatCounter, mindkettő cookie-mentes.
- Nincs fix településlista: a `script.js` a felhasználó koordinátája köré dinamikusan
  generál egy keresési rácsot (gyűrűk × irányok), és abban keresi a legközelebbi esőt,
  egyre táguló körökben, amíg nem talál. Ha a talált pontnak nincs neve (pl. tenger
  felett van), egy kis helyi kereséssel talál mellette megnevezhető helyet.
- SEO alapok: `robots.txt`, `sitemap.xml`, WebSite structured data (JSON-LD),
  favicon (`favicon.svg`), és egy generált `og-image.png` a közösségi megosztásokhoz.

### Fontos: cache-busting a `?v=N` verziószámmal

A `holazeso.hu` custom domain (ismeretlen okból, Cloudflare Pages-kvirk) **nem veszi
figyelembe** a `_headers` fájl `no-cache` szabályát `script.js`/`style.css`-re, ezért
a böngészők akár 4 óráig a régi verziót cache-elhetik. Ezért az `index.html`-ben
`script.js?v=N` és `style.css?v=N` szerepel: **minden alkalommal, amikor módosítod
a `script.js`-t vagy a `style.css`-t, bővítsd a megfelelő `?v=N` számot** az
`index.html`-ben, különben a felhasználók a régi verziót fogják kapni a következő
deployod után is. (Az `index.html` maga mindig frissen töltődik, `max-age=0`
fejléccel, ezzel nincs teendő.)

## Lokális futtatás

Mivel az oldal statikus, elég egy egyszerű helyi webszerver (a vízadat-panel
localhostról nem tölt be, mert a worker csak az éles domaint engedi, ld.
`ARCHITECTURE.md`):

1. Nyisd meg a mappát VS Code-ban.
2. Telepítsd a **Live Server** kiegészítőt, ha még nincs meg.
3. Jobb klikk az `index.html`-en → **Open with Live Server**.

(Közvetlenül `file://`-ként megnyitva egyes böngészőkben a `fetch` hívások
CORS-problémákba futhatnak, ezért érdemes helyi szerverről futtatni.)

## Deployolás Cloudflare Pages-re

1. Told fel ezt a repót GitHub-ra.
2. Cloudflare dashboardban: **Workers & Pages → Create → Pages → Connect to Git**,
   válaszd ki ezt a repót.
3. Build beállítások: **Framework preset: None**, build command üresen hagyható,
   build output directory: `/` (a repó gyökere, mivel nincs build lépés).
4. Deploy. Ezután minden `main`-re történő push automatikusan újra deployol.

## Licenc

A forráskód MIT licenc alatt áll, részletek a [`LICENSE`](LICENSE) fájlban.
Az alább felsorolt külső adatforrásokra a saját licencük vonatkozik.

## Adatforrások

- [Open-Meteo](https://open-meteo.com/): időjárás, csapadék-előrejelzés, talajnedvesség,
  árvízi és magassági adatok (CC BY 4.0).
- [hydroinfo.hu](https://www.hydroinfo.hu/) / Országos Vízügyi Főigazgatóság: folyók és
  tavak vízállása.
- [OpenStreetMap](https://www.openstreetmap.org/copyright) közreműködői: térképi geometria
  (ODbL), a gyűjtő a Geofabrik kivonatain keresztül is használja.
- [BigDataCloud](https://www.bigdatacloud.com/): fordított geokódolás.
- [RainViewer](https://www.rainviewer.com/): radarképek.
- [geoBoundaries](https://www.geoboundaries.org/): megyehatárok (CC BY 4.0); országhatárok:
  Natural Earth.
- Copernicus DEM (GLO-30): domborzati adat a vízgyűjtő-számításokhoz.
