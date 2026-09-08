# holazeso.hu

"hol az eső?": egy nagyon letisztult, kérdés-válasz formátumú mikro-eszköz, ami
azonnal megválaszolja: esik-e nálad, vagy ha nem, hol a legközelebbi eső.

Nem hagyományos esőradar (azt már jól lefedi az időkép.hu és a met.hu), csak
egyetlen nagy, domináns válasz: **Nálad** / **Közelben** / **Távolban** / **Sehol**.
Ha sehol nem esik az országban, egy második kérdés jön: hol esik éppen a Földön.

A helyszínt az oldal alapból a böngésző helymeghatározásával próbálja kitalálni;
ha ez nem sikerül vagy nincs engedélyezve, kézi településkereső jön elő helyette.

## Technikai keret

- Nincs backend, nincs adatbázis: tisztán statikus HTML/CSS/JS.
- Nincs build lépés, nincs keretrendszer, nincs npm.
- Adatforrás: [Open-Meteo](https://open-meteo.com/) (ingyenes, API-kulcs nélkül, CC BY 4.0).
- Fordított geokódolás (koordinátából településnév): [BigDataCloud](https://www.bigdatacloud.com/) kliens-oldali API-ja, kulcs nélkül.
- Látogatottság: Cloudflare Web Analytics és GoatCounter, mindkettő cookie-mentes.

## Lokális futtatás

Mivel az oldal statikus és közvetlenül böngészőből hívja az Open-Meteo API-kat,
elég egy egyszerű helyi webszerver:

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
