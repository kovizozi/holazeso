// ---- Keresési rács ----
// Nincs fix településlista: a felhasználó koordinátája köré generálunk egy
// gyűrűkből álló ponthálót, és abban keressük a legközelebbi esőt. Ez minden
// országban egyformán pontos, nem csak Magyarországon vagy egy előre
// kiválasztott városlistán.
//
// Ha az első adagban (60 km-ig) nem találunk esőt, egyre távolabbi
// gyűrűket próbálunk, amíg nem találunk, vagy amíg el nem fogynak.
//
// Az adagok szűken indulnak és onnan tágulnak: az első csak 60 km-ig néz,
// a következők 150 km-enként lépnek kijjebb (300, 450), és csak utána
// gyorsul a lépés (900, 2500), hogy távoli eső esetén ne kelljen tucatnyi
// kört végigvárni.
// Így a radar induló képe a közvetlen környéket mutatja olvashatóan, nem
// egy 600 km-es, összezsúfolt áttekintést.
//
// AZ ELSŐ ADAG (SEARCH_RINGS[0]) nemcsak az első API-hívás kötege, hanem ez
// dönti el az "Esik-e X környékén?" Igen/Nem válaszát is (lásd run()). Ezt
// korábban az egész 150 km-es tartomány adta, de egy 100-150 km-es találat
// senkinek nem érződik "a környéknek" - ezért az Igen/Nem most csak 60 km-ig
// terjed, és egy 100-150 km-es találatot már a 2. fázis ("de hol esik
// pontosan?") mutat meg, nem az 1. kérdés válasza.
//
// Minden adag CSAK az új gyűrűt méri fel: a belső területet az előző adagok
// már lefedték, a radaron pedig azok zoomolnak összébb az új adag alá.
//
// Egy gyűrűn NEM fix számú irányt kérdezünk le, hanem annyit, amennyi a
// gyűrű kerületéhez illik. Korábban mindegyiken 12 irány volt, amitől a
// szomszédos pontok távolsága kifelé haladva elszállt: 30 km-en 16 km-re
// voltak egymástól, 9000 km-en viszont már 4712 km-re - vagyis kint egész
// esőrendszerek elfértek volna két pont között, miközben bent feleslegesen
// sűrű volt a háló. Ezért az irányok száma a sugárral együtt nő, így a
// pontok távolsága végig nagyságrendileg egyenletes marad (30 km-en 31 km,
// 450 km-en 88 km, 9000 km-en 1346 km).
//
// Minden adag egyetlen Open-Meteo hívás: [sugár km, irányok száma].
//
// A pontszámot az Open-Meteo kvótája korlátozza, és ez szigorúbb, mint
// elsőre látszik. A hivatalos súlyozás (ForecastApiResult.calculateQueryWeight)
// szerint MINDEN lekérdezett pont külön egységet ér, és 10 változó / 14 nap
// alatt a változók száma és a napok száma semmit nem módosít rajta. Vagyis
// hiába kérünk a rácspontokról csak "current=precipitation"-t: a súly
// ugyanannyi, mint a teljes órás előrejelzésnél. A limit IP-nként 600/perc,
// 5000/óra és 10000/nap.
//
// Ezért a legtávolabbi, 9000 km-es adagot kivettük (2500 km-en belül
// gyakorlatilag mindig van eső, és egy szándékosan ritka, félrevezető
// távoli háló rosszabb, mint ha nem is nézzük), a középső adagokat pedig
// ritkítottuk. A legrosszabb eset így 294 pont: két teljes keresés is
// belefér egy percbe, ami korábban 429-et adott volna.
const SEARCH_RINGS = [
  [[30, 6], [60, 10]],
  [[100, 14], [150, 18]],
  [[200, 16], [250, 18], [300, 20]],
  [[350, 20], [400, 22], [450, 24]],
  [[550, 20], [700, 22], [900, 24]],
  [[1200, 18], [1700, 20], [2500, 22]],
];

// A keresési sugár (SEARCH_RINGS) azt dönti el, mennyire kell távol keresni
// esőt, de NEM azt, amennyit a radaron látni akarunk: ha a találat közel van
// (akár a 60 km-es "környék"-en, akár csak a 100-150 km-es gyűrűn belül), a
// radar vizuálisan ennél messzebb kell mutasson, különben az országhatár (és
// most már a folyók/Balaton, ld. radarDrawWaterGeo) sosem fér bele látható
// méretbe egy ilyen kis körben - a felhasználó nem látja, az ország melyik
// részén áll. Magyarország legeldugottabb pontja (a határtól legtávolabb eső
// hely, kb. Szolnok térségében) kb. 112 km-re van bármelyik határtól, ezért a
// 220 km-es alsó korlát bőséges ráhagyással mindenhonnan mutat határt.
// Ezt a radarAddTier érvényesíti MINDEN körnél, a keresés legelejétől (az
// alaptérkép már a töltés alatt látszik, ezért a keretezés nem változhat a
// végén): a kör saját sugara (tier.maxRadiusKm) a pontok vetítésére marad, a
// KIJELZETT sugár (radarMaxRadiusKm) legalább ennyi.
const RADAR_MIN_VISUAL_RADIUS_KM = 220;

function ringBearings(count) {
  return Array.from({ length: count }, (_, i) => (i * 360) / count);
}

// A durva háló egy gyűrűpontján akadunk rá az esőre, de az esőterület hozzánk
// legközelebbi széle bárhol lehet az előző (üres) gyűrű és a találat között,
// és oldalra is a szomszédos irányok félútjáig. Ezért a találat köré küldünk
// még egy kis, sűrű hálót: 20 pont, egyetlen hívás. Ez a távoli találatoknál
// több száz kilométeres bizonytalanságot visz le néhány tízre, és sokkal
// olcsóbb, mint az egész hálót sűríteni (azt a kvóta amúgy sem bírná).
const REFINE_DISTANCES = 4;
const REFINE_BEARINGS = 5;
const ALL_RINGS = SEARCH_RINGS.flat();

function refinementGrid(userLoc, hit) {
  const idx = ALL_RINGS.findIndex(([km]) => km === hit.distance);
  if (idx < 0) return [];
  const innerKm = idx > 0 ? ALL_RINGS[idx - 1][0] : 0;
  const bearingSpan = 360 / ALL_RINGS[idx][1];
  const points = [];
  for (let i = 1; i <= REFINE_DISTANCES; i++) {
    const distance = innerKm + (hit.distance - innerKm) * (i / REFINE_DISTANCES);
    for (let j = 0; j < REFINE_BEARINGS; j++) {
      const offset = bearingSpan * (j / (REFINE_BEARINGS - 1) - 0.5);
      const bearing = (hit.bearing + offset + 360) % 360;
      const p = destinationPoint(userLoc.lat, userLoc.lon, bearing, distance);
      points.push({ lat: p.lat, lon: p.lon, distance, bearing });
    }
  }
  return points;
}

const RAIN_THRESHOLD_MM = 0.1; // ennél kevesebb csapadékot zajnak tekintünk

// Csapadék-erősség sávok (mm/óra), melléknévi és határozói alakkal együtt,
// hogy ne kelljen a végződést programból levezetni.
// A "key" és a "dotRadius" a radar pöttyeihez kell: a gyengébb esőt halványabb
// és kisebb pötty jelzi. Itt tartjuk, hogy az intenzitás-sávoknak egyetlen
// forrása legyen, és a szöveg meg a rajz ne csúszhasson szét egymástól.
const INTENSITY_BANDS = [
  { max: 1, key: "light", dotRadius: 4, adj: "gyenge", adv: "gyengén" },
  { max: 4, key: "medium", dotRadius: 5, adj: "közepes", adv: "közepesen" },
  { max: Infinity, key: "heavy", dotRadius: 6, adj: "erős", adv: "erősen" },
];

function intensityBand(mm) {
  return INTENSITY_BANDS.find(b => mm <= b.max);
}

function formatMm(mm) {
  return mm.toFixed(1).replace(".", ",");
}

// ---- Csapadék típusa és "hómód" ----
// A /ho/ oldal a script.js előtt beállítja a window.HOLAZESO_MODE = "ho"
// értéket: ilyenkor a keresés csak a havazást (current.snowfall > 0) tekinti
// találatnak, a szövegek pedig hóról szólnak. A keresés menete, a radar és az
// adatérkezéshez kötött felfestés változatlan, csak az "esik-e" feltétel más.
const SNOW_MODE = window.HOLAZESO_MODE === "ho";
const FREEZING_RAIN_CODES = [56, 57, 66, 67]; // WMO: ónos szitálás, ónos eső
const SNOW_CODES = [71, 73, 75, 77, 85, 86]; // WMO: hó, hószemcse, hózáporok

// "rain" | "snow" | "ice": a már találatnak számító pont csapadékának típusa.
// A hó nem csak a snowfall mezőből ismerhető fel: az Open-Meteo a snowfall-t
// 0,01 cm-re kerekíti, így gyenge havazásnál 0 jöhet, miközben a precipitation
// már küszöb fölött van és a weather_code havat mutat. Ha csak a snowfall-t
// néznénk, ezek a találatok esőként íródnának ki.
function precipKind(forecast) {
  const cur = forecast.current;
  if (FREEZING_RAIN_CODES.includes(cur.weather_code)) return "ice";
  if (cur.snowfall > 0 || SNOW_CODES.includes(cur.weather_code)) return "snow";
  return "rain";
}

// A "de hol esik pontosan?" kérdés a megtalált csapadék típusához igazodik.
function whereQuestion(kind) {
  if (SNOW_MODE) return "a legközelebbi havazás:";
  if (kind === "snow") return "de hol havazik pontosan?";
  return kind === "ice" ? "de hol esik ónos eső pontosan?" : "de hol esik pontosan?";
}

// Rácspont-találatok: index -> { mm, kind }. A radar pöttyei (típus szerinti
// piktogram) és a találati szöveg is ebből dolgozik.
function rainHits(points, forecasts) {
  return new Map(points
    .map((_, i) => i)
    .filter(i => isRainingNow(forecasts[i]))
    .map(i => [i, { mm: currentPrecipRate(forecasts[i]), kind: precipKind(forecasts[i]) }]));
}

// A fő válasz felirata ("Most esik" helyett havazásnál, ónos esőnél mást).
function nowHeroText(kind) {
  return kind === "snow" ? "Havazik" : kind === "ice" ? "Ónos eső esik" : "Most esik";
}

// Egy mondatba illő időtartam, 15 percre kerekítve: "45 perc", "1 óra 15 perc".
// until = true esetén "-ig" végű ("45 percig", "1 óráig").
function formatMinutes(min, until = false) {
  const h = Math.floor(min / 60);
  const rest = min % 60;
  const hourText = until && !rest ? "óráig" : "óra";
  const minText = until ? "percig" : "perc";
  if (h === 0) return `${rest} ${minText}`;
  return rest ? `${h} óra ${rest} ${minText}` : `${h} ${hourText}`;
}

function formatC(celsius) {
  return celsius.toFixed(1).replace(".", ",");
}

// ---- Segédfüggvények ----

// Adott koordinátától egy irányszög (fok) és távolság (km) alapján kiszámolja
// a célpont koordinátáit (gömbi navigációs képlet).
function destinationPoint(lat, lon, bearingDeg, distKm) {
  const R = 6371;
  const bearing = bearingDeg * Math.PI / 180;
  const lat1 = lat * Math.PI / 180;
  const lon1 = lon * Math.PI / 180;
  const dOverR = distKm / R;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dOverR) +
    Math.cos(lat1) * Math.sin(dOverR) * Math.cos(bearing)
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearing) * Math.sin(dOverR) * Math.cos(lat1),
    Math.cos(dOverR) - Math.sin(lat1) * Math.sin(lat2)
  );

  // A hosszúsági fokot vissza kell forgatni a [-180, 180] tartományba: a
  // legtávolabbi gyűrűk átlógnak a dátumvonalon (Magyarországtól 9000 km-re
  // keletre 199 fok jött ki), amit az Open-Meteo 400-as hibával utasít el.
  const lon2Deg = (((lon2 * 180 / Math.PI) % 360) + 540) % 360 - 180;
  return { lat: lat2 * 180 / Math.PI, lon: lon2Deg };
}

// Két koordináta közti valódi távolság kilométerben (haversine-képlet). A
// keresési rács pontjainak van saját "distance" mezőjük (mert a
// destinationPoint generálta őket), de a findNearbyName által talált,
// eltolt névadó pontnak nincs - ezt onnan számoljuk vissza.
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Két koordináta közti kezdő irányszög fokban (0 = észak, óramutató szerint).
function bearingBetween(lat1, lon1, lat2, lon2) {
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const deltaLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(deltaLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

const COMPASS_POINTS = ["É", "ÉK", "K", "DK", "D", "DNy", "Ny", "ÉNy"];

function compassLabel(bearingDeg) {
  const idx = Math.round(bearingDeg / 45) % 8;
  return COMPASS_POINTS[idx];
}

// A felhasználó koordinátája köré generált keresési pontok egy adott
// gyűrűlistára, gyűrűnként növekvő távolsággal.
function generateSearchGrid(userLoc, rings) {
  const points = [];
  for (const [distance, bearingCount] of rings) {
    for (const bearing of ringBearings(bearingCount)) {
      const p = destinationPoint(userLoc.lat, userLoc.lon, bearing, distance);
      points.push({ lat: p.lat, lon: p.lon, distance, bearing });
    }
  }
  return points;
}

function saveLocation(loc) {
  try {
    localStorage.setItem("holazeso_location", JSON.stringify(loc));
  } catch (err) {
    console.error(err);
  }
  rememberRecentLocation(loc);
}

function loadSavedLocation() {
  try {
    const raw = localStorage.getItem("holazeso_location");
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error(err);
    return null;
  }
}

// UX-audit "mentett helyek" (PROGRESS.md, Later roadmap): nem fiókos
// kedvencek, hanem az utoljára HASZNÁLT (nem a Budapest-tartalék, ld.
// tryAutoLocate catch ága) helyszínek, legfeljebb 5, legújabb elöl - a
// visszatérő látogató egy koppintással válthat köztük, újbóli gépelés
// nélkül, a #location-picker alján.
const RECENT_LOCATIONS_KEY = "holazeso_recent_locations";
const RECENT_LOCATIONS_MAX = 5;

function rememberRecentLocation(loc) {
  try {
    const recent = loadRecentLocations().filter(r => r.name !== loc.name);
    recent.unshift(loc);
    localStorage.setItem(RECENT_LOCATIONS_KEY, JSON.stringify(recent.slice(0, RECENT_LOCATIONS_MAX)));
  } catch (err) {
    console.error(err);
  }
}

function loadRecentLocations() {
  try {
    const raw = localStorage.getItem(RECENT_LOCATIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error(err);
    return [];
  }
}

// Település keresése az Open-Meteo Geocoding API-val (kézi keresés fallbackhez).
// Bármely ország találata elfogadott, nincs országra szűrés.
async function geocode(name) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=hu&format=json`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.results || data.results.length === 0) return null;
  const r = data.results[0];
  return { name: r.name, lat: r.latitude, lon: r.longitude, countryCode: r.country_code, countryName: r.country };
}

// Koordinátából településnév és ország az OpenStreetMap-alapú, kulcs nélküli
// BigDataCloud reverse geocoding API-val. Ha nem sikerül, üres mezőkkel térünk
// vissza, és általános szöveggel folytatjuk. A koordináta enélkül is elég a
// válaszhoz.
async function reverseGeocode(lat, lon) {
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=hu`;
  const res = await fetch(url);
  const data = await res.json();
  // Csak a "city" mezőt használjuk névnek: gyéren lakott pontokon a
  // "locality" mező BigDataCloud saját fallback-je miatt egy közigazgatási
  // egység nevére ugorhat (pl. "Anglia" az Egyesült Királyságban egy
  // konkrét helynév helyett), ami félrevezető lenne.
  return {
    name: data.city || null,
    countryCode: data.countryCode || null,
    countryName: data.countryName || null,
  };
}

// A böngésző helymeghatározását Promise-ba csomagolja.
function detectLocation() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("A böngésző nem támogatja a helymeghatározást."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(err),
      { timeout: 10000, maximumAge: 5 * 60 * 1000 }
    );
  });
}

// Lekéri a csapadék-előrejelzést tetszőleges pontlistára, egyetlen hívásban.
// A válasz ugyanabban a sorrendben jön vissza, ahogy küldtük a koordinátákat.
// A koordinátákat 4 tizedesre kerekítve küldjük. Ez kb. 11 méteres pontosság,
// nagyságrendekkel több, mint amit egy ~11 km-es rácsú időjárási modell
// használni tud, viszont felére rövidíti a lekérdezés URL-jét: a nyers
// float-okkal a legtávolabbi adag URL-je 8811 karakter lett, amit a szerver
// "414 Request-URI Too Large" hibával visszautasított.
const coord = value => value.toFixed(4);

const API_BASE = "https://api.open-meteo.com/v1/forecast";

async function openMeteo(url) {
  const res = await fetch(url);
  const data = await res.json();
  // Hibánál (pl. 429: percenkénti limit túllépve) az API nem előrejelzést,
  // hanem egy {reason, error} objektumot ad vissza. Ezt itt kell elkapni,
  // különben a hívó egy értelmezhetetlen alakon hasal el.
  if (!res.ok || data.error) {
    throw new Error(`Open-Meteo ${res.status}: ${data.reason || "ismeretlen hiba"}`);
  }
  return data;
}

// A rácspontokról CSAK azt kell tudnunk, esik-e ott MOST (isRainingNow). Az
// órás előrejelzés (mikor áll el, mekkora eséllyel) egyedül a felhasználó
// saját helyére kell, lásd fetchUserForecast. Korábban mind a 120+ rácspontra
// lekértük a két napnyi órás adatot is, amitől a kérés súlya az Open-Meteo
// percenkénti limitjét is átlépte (429).
async function fetchPrecipitation(points) {
  const lats = points.map(p => coord(p.lat)).join(",");
  const lons = points.map(p => coord(p.lon)).join(",");
  return openMeteo(`${API_BASE}?latitude=${lats}&longitude=${lons}&current=precipitation,snowfall,weather_code`);
}

// forecast_days=2, hogy a "hamarosan" (következő 3 óra) ablak éjfél körül is
// átnyúlhasson a következő napra, ne csak az aktuális nap 23:00-jánál vágja le.
async function fetchUserForecast(point) {
  return openMeteo(
    `${API_BASE}?latitude=${coord(point.lat)}&longitude=${coord(point.lon)}` +
    `&current=precipitation,snowfall,weather_code&hourly=precipitation,precipitation_probability` +
    `&minutely_15=precipitation&forecast_days=2&timezone=auto`
  );
}

// A "részletek és statisztika" panelhez EGYETLEN pontra (a felhasználó
// helyére) kérünk bővített adatot: múltbeli napi/órás csapadékot, pár napos
// előrejelzést, hőmérsékletet és talajnedvességet. Ez külön függvény a
// fetchUserForecast-tól, mert azt az 5 percenkénti automatikus frissítés is
// lefuttatja - oda nem kell ez a jóval nehezebb lekérdezés. Egyetlen pontra
// a grid-kvóta aggálya (lásd SEARCH_RINGS fenti kommentje) nem vonatkozik.
async function fetchUserStats(point) {
  return openMeteo(
    `${API_BASE}?latitude=${coord(point.lat)}&longitude=${coord(point.lon)}` +
    `&past_days=31&forecast_days=4` +
    `&daily=precipitation_sum,precipitation_probability_max,temperature_2m_max,temperature_2m_min,snowfall_sum,rain_sum,weather_code` +
    `&hourly=precipitation,precipitation_probability,snowfall` +
    `&current=temperature_2m,precipitation,snowfall&timezone=auto`
  );
}

// "Szokásos" csapadék-bázis: az előző néhány év ugyanarra a mai napra
// végződő 30 napos ablakára lekért, VALÓDI mért napi összeg (nem modell-
// előrejelzés). Ez nem egy hivatalos, sokéves klimatológiai normál, csak az
// elmúlt néhány év átlaga - ezért a megjelenő szöveg is így fogalmaz.
const USUAL_PRECIP_YEARS_BACK = 3;
const ARCHIVE_API_BASE = "https://archive-api.open-meteo.com/v1/archive";

async function fetchUsualPrecipitation(point) {
  const today = new Date();
  const years = Array.from({ length: USUAL_PRECIP_YEARS_BACK }, (_, i) => i + 1);
  const windows = await Promise.all(years.map(async yearsBack => {
    const end = new Date(today);
    end.setFullYear(end.getFullYear() - yearsBack);
    const start = new Date(end);
    start.setDate(start.getDate() - 29);
    const toIso = d => d.toISOString().slice(0, 10);
    const data = await openMeteo(
      `${ARCHIVE_API_BASE}?latitude=${coord(point.lat)}&longitude=${coord(point.lon)}` +
      `&start_date=${toIso(start)}&end_date=${toIso(end)}&daily=precipitation_sum&timezone=auto`
    );
    return data.daily.precipitation_sum;
  }));
  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const avg = arr => arr.reduce((a, b) => a + sum(b), 0) / arr.length;
  return {
    usual7d: avg(windows.map(w => w.slice(-7))),
    usual30d: avg(windows),
  };
}

// Az esős pontokat adja vissza egy pont- és előrejelzés-listából, távolság
// szerint növekvő sorrendben.
// A csapadék mennyiségét is rátesszük a pontra: enélkül a hívó már nem tudná
// visszakeresni, mennyire esik a megtalált helyen, és csak a helynevet meg a
// távolságot tudnánk kiírni.
function sortRaining(points, forecasts) {
  return points
    .map((point, i) => ({ point, forecast: forecasts[i] }))
    .filter(({ forecast }) => isRainingNow(forecast))
    .map(({ point, forecast }) => ({ ...point, mm: currentPrecipRate(forecast), kind: precipKind(forecast) }))
    .sort((a, b) => a.distance - b.distance);
}

// Ha egy pontnak (pl. mert tenger felett van) nincs neve, ezekben az egyre
// táguló sugarakban keresünk a közvetlen közelében megnevezhető helyet.
// Nem kell, hogy a talált hely maga is esős legyen - csak arra kell, hogy
// tudjuk emberi néven megjeleníteni, hol esik a ponthoz közel.
const LOCAL_NAME_RINGS_KM = [20, 60, 150];

// Megkeresi egy pont legközelebbi megnevezhető helyét. Előbb magát a pontot
// próbálja, majd ha nincs neve, körülötte egyre táguló, párhuzamosan
// lekérdezett gyűrűkben keres. A talált hely SAJÁT koordinátáját is
// visszaadja (lat/lon), mert az eltolódhat az eredeti ponttól akár 150 km-t
// is - a hívó félnek emiatt a talált helyhez, nem az eredeti ponthoz kell
// számolnia a távolságot/irányt, különben a kiírt adatok nem a mutatott
// névhez tartoznának. Ha semmit nem talál, üres nevű objektumot ad vissza
// az eredeti pont koordinátáival, amit a hívó fél az általános "egy közeli
// térségben" szöveggel helyettesít.
async function findNearbyName(point) {
  try {
    const place = await reverseGeocode(point.lat, point.lon);
    if (place.name) return { ...place, lat: point.lat, lon: point.lon };
  } catch (err) {
    console.error(err);
  }

  for (const radius of LOCAL_NAME_RINGS_KM) {
    const offsets = ringBearings(12).map(bearing => destinationPoint(point.lat, point.lon, bearing, radius));
    const results = await Promise.all(
      offsets.map(p =>
        reverseGeocode(p.lat, p.lon)
          .then(place => ({ ...place, lat: p.lat, lon: p.lon }))
          .catch(err => {
            console.error(err);
            return { name: null, countryCode: null, countryName: null, lat: p.lat, lon: p.lon };
          })
      )
    );
    const named = results.find(r => r.name);
    if (named) return named;
  }

  return { name: null, countryCode: null, countryName: null, lat: point.lat, lon: point.lon };
}

// A "current.precipitation" NEM mm/óra: az Open-Meteo a modell saját
// frissítési közét ("current.interval", másodpercben) adja vissza, ami a
// legtöbb európai pontra 900 (15 perc), nem 3600 (1 óra). Felszorzás nélkül
// a valós óránkénti csapadék negyedét mutattuk volna, ezért a kiírt érték
// mindig irreálisan alacsonynak ("0,x mm") tűnt, és a 0,1 mm/órás küszöb is
// a négyszeresére, kb. 0,4 mm/órára szigorult.
function currentPrecipRate(forecast) {
  const { precipitation, interval } = forecast.current;
  return precipitation * 3600 / interval;
}

function isRainingNow(forecast) {
  if (SNOW_MODE) return forecast.current.snowfall > 0;
  return currentPrecipRate(forecast) >= RAIN_THRESHOLD_MM;
}

// Rövid kitekintés a saját helyre a 15 perces adatból (minutely_15): meddig
// tart még az eső, illetve mikor érhet ide. Ez előrejelzés, ezért szerényen
// fogalmazunk, és 15 percre kerekítünk. Hiányzó adatnál null (semmit nem írunk).
// A minutely_15 értéke az előző 15 perc összege (mm), a küszöb szeletenként
// ugyanaz a 0,1 mm. A szelet-index a "current.time"-hoz tartozó szelet.
const MINUTELY_SLOTS = 16; // 4 óra
function minutelyOutlook(forecast, rainingNow, kind) {
  const m = forecast.minutely_15;
  if (SNOW_MODE || !m || !Array.isArray(m.time) || !Array.isArray(m.precipitation)) return null;
  const cur = forecast.current.time;
  const minute = parseInt(cur.slice(14, 16), 10);
  const floorMin = minute - (minute % 15);
  const idx = m.time.indexOf(cur.slice(0, 14) + String(floorMin).padStart(2, "0"));
  if (idx === -1) return null;
  const elapsed = minute - floorMin; // perc a szelet kezdete óta
  for (let k = 1; k <= MINUTELY_SLOTS; k++) {
    const v = m.precipitation[idx + k];
    if (typeof v !== "number") return null; // hiányzó adat: nem állítunk semmit
    const wet = v >= RAIN_THRESHOLD_MM;
    // A k. szelet az (idx + k - 1) * 15. perctől tart: ott kezdődik/áll el.
    if (wet !== rainingNow) {
      const minutes = Math.round((15 * (k - 1) - elapsed) / 15) * 15;
      if (rainingNow) {
        if (minutes <= 0) return "Hamarosan eláll.";
        const verb = kind === "snow" ? "havazhat" : "eshet";
        return `Még kb. ${formatMinutes(minutes, true)} ${verb}.`;
      }
      return minutes <= 0 ? "Hamarosan ideérhet." : `Kb. ${formatMinutes(minutes)} múlva ideérhet.`;
    }
  }
  return rainingNow ? "A következő órákban is eshet." : null;
}

// A "current.time" perc-pontosságú (pl. "...T18:45"), az "hourly.time" viszont
// csak egész órás bontású ("...T18:00"), ezért kerekítsük le óra-pontosságra egyezéshez.
function currentHourIndex(forecast) {
  const currentHour = forecast.current.time.slice(0, 13) + ":00";
  return forecast.hourly.time.indexOf(currentHour);
}

// Megkeresi a következő 3 órán belül az első órát, amikor esni fog, és
// visszaadja annak indexét az hourly tömbökben (vagy -1-et, ha egyikben sem esik).
function soonRainIndex(forecast) {
  const idx = currentHourIndex(forecast);
  if (idx === -1) return -1;
  for (let i = idx; i < Math.min(idx + 3, forecast.hourly.precipitation.length); i++) {
    if (forecast.hourly.precipitation[i] >= RAIN_THRESHOLD_MM) return i;
  }
  return -1;
}

function isRainingSoon(forecast) {
  return soonRainIndex(forecast) !== -1;
}

// Hány óra múlva áll el a jelenleg tartó eső (az hourly előrejelzés alapján
// megkeresi az első száraz órát). Null, ha nem talál száraz órát az
// előrejelzésben (2 napra nézünk előre).
function rainDurationHours(forecast) {
  const idx = currentHourIndex(forecast);
  if (idx === -1) return null;
  for (let i = idx; i < forecast.hourly.precipitation.length; i++) {
    if (forecast.hourly.precipitation[i] < RAIN_THRESHOLD_MM) {
      return i - idx;
    }
  }
  return null;
}

// Hány órája tart a MOST zajló esőzés: a rainDurationHours tükörképe,
// visszafelé pásztázva az első száraz óráig. Null, ha az órás tömb nem ér
// el addig (pl. past_days nem fedte le), vagy az aktuális óra maga sem esős.
function rainEventStartIndex(forecast) {
  const idx = currentHourIndex(forecast);
  if (idx === -1 || forecast.hourly.precipitation[idx] < RAIN_THRESHOLD_MM) return null;
  let start = idx;
  while (start > 0 && forecast.hourly.precipitation[start - 1] >= RAIN_THRESHOLD_MM) {
    start--;
  }
  return start;
}

// ---- Radar vizualizáció ----
// A keresés közben ezt mutatjuk a "töltés…" szöveg helyett.
//
// Fontos, mit jelent itt az "adatvezérelt": egy kör összes pontja EGYETLEN
// Open-Meteo hívásban, egyszerre érkezik meg, és pont SOSEM villanhat fel
// előbb, mint ahogy az a válasz megjött. A megjelenítés viszont úgy működik,
// mint egy igazi radarernyőn: a pásztázó vonal festi fel a pontokat, ahogy
// elhalad az irányuk fölött (radarRevealTier). Ez tehát nem kitalált
// lekérdezési ütem, hanem a már meglévő adat festési módja. A sugár (a
// következő, távolabbi körre váltás) is csak akkor nő, ha az előző kör
// válasza megérkezett ÉS abban nem volt találat - nem egy fix idő után.
// A képernyő TÉGLALAP, nem kör. A lépték mindkét irányban ugyanaz (különben
// a térkép torzulna), ezért a keresési sugár a FÉL MAGASSÁGnak felel meg, és
// oldalra ennél messzebbre látunk: a sarkokban a fél átló arányában, kb. a
// sugár kétszereséig. A tartalmat a viewBox vágja el a széleknél.
const RADAR_W = 350;
const RADAR_H = 220;
const RADAR_CENTER_X = RADAR_W / 2;
const RADAR_CENTER_Y = RADAR_H / 2;
const RADAR_MAX_PX = 100; // ennyi képpont felel meg a keresési sugárnak
const RADAR_CORNER_FACTOR = Math.hypot(RADAR_CENTER_X, RADAR_CENTER_Y) / RADAR_MAX_PX;

let radarTierGroups = []; // { el, maxRadiusKm }

function radarPolarPoint(bearingDeg, distKm, maxRadiusKm) {
  return radarProject(bearingDeg, Math.min(distKm, maxRadiusKm), maxRadiusKm);
}

// Vágás nélküli vetítés: a folytonos rétegeknek (radarkép, országhatárok) a
// kör sugarán TÚL is kell pont, mert a téglalap sarkai messzebbre látnak.
function radarProject(bearingDeg, distKm, maxRadiusKm) {
  const r = (distKm / maxRadiusKm) * RADAR_MAX_PX;
  const theta = bearingDeg * Math.PI / 180;
  return {
    x: RADAR_CENTER_X + r * Math.sin(theta),
    y: RADAR_CENTER_Y - r * Math.cos(theta),
  };
}

// ---- Országhatárok a radaron ----
// A radar azimutális ekvidisztáns vetület a felhasználó körül: minden pont a
// VALÓDI távolsága és iránya szerint kerül a helyére. Ezért a határvonalakat
// is pontosan ugyanazzal a két függvénnyel vetítjük, amivel a rácspontokat
// (distanceKm és bearingBetween) - nem kell hozzá külön térképvetület.
//
// Az adat lusta betöltésű és sosem várakoztatja a választ: ha nem érkezik meg
// vagy hibázik, a radar egyszerűen határok nélkül működik tovább.
const BORDERS_URL = "/borders.json?v=2";
// A fájl Magyarország gyűrűjét 0,001 fokos egységben kódolja (nem a többi
// ország 0,01-es egységében), hogy a valódi, 848 pontos hazai körvonal (a
// soil-moisture-mapper app/data/hungary_border.json-jéből, ld. ARCHITECTURE)
// ne vágjon le finom részletet a kerekítéssel - ld. decodeDeltaRings hívás.
const BORDERS_SCALE = 1000;
let borderRings = null;
let bordersLoading = null;
let radarOrigin = null;
let radarMaxRadiusKm = 0;
// Az alaptérkép (határok, folyók/Balaton, városok, RainViewer-kép) a keresés
// INDULÁSAKOR megjelenik, még mielőtt bármelyik kör válasza megérkezne: a
// rétegek csak a felhasználó helyétől és a megjelenített sugártól függnek, a
// csapadékadattól nem. Csak a találati pontokra vonatkozik a 6. szabály (a
// válasz előtt nem villanhatnak fel). Lásd radarDrawBase.
let radarBaseKey = ""; // melyik helyre/sugárra rajzoltuk utoljára az alaptérképet

// Delta-kódolt egészek 0,01 fokos egységekben, gyűrűnként/vonalanként
// halmozva. Ez a felére csökkenti a fájlt a nyers koordinátalistához képest.
// Közös a borders.json és a water-geo.json formátuma, csak a tartalmuk más.
function decodeDeltaRings(encoded, scale = 100) {
  return encoded.map(flat => {
    const ring = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i < flat.length; i += 2) {
      x += flat[i];
      y += flat[i + 1];
      ring.push([x / scale, y / scale]);
    }
    return ring;
  });
}

function loadBorders() {
  if (bordersLoading) return bordersLoading;
  bordersLoading = fetch(BORDERS_URL)
    .then(res => res.json())
    .then(encoded => {
      borderRings = decodeDeltaRings(encoded, BORDERS_SCALE);
      radarDrawBorders();
    })
    .catch(err => {
      console.error(err);
      borderRings = [];
    });
  return bordersLoading;
}

// ---- Folyók és a Balaton a radaron (water-geo.json) ----
// Ugyanaz az azimutális vetület és ugyanaz a lusta betöltés, mint a
// határoknál - csak másik forrásfájl, amiben nem minden ország, hanem a 3
// legnagyobb folyó (Duna, Tisza, Dráva) és a Balaton valódi körvonala van.
// A folyók (korábban Natural Earth 1:50m "rivers_lake_centerlines", kb. 300
// pont összesen, sok 2-8 pontos töredékkel) a UX-audit "a többi térkép
// folyói undetailed-nek tűnnek" észrevétele miatt ÚJRA lettek generálva: a
// csatorna-térkép adatpipeline-ja (app/channels.py) már amúgy is kinyeri a
// Duna/Tisza/Dráva MINDEN névvel egyező OSM-szakaszát (103 szakasz, kb. 2000
// pont) sokkal finomabb (0,0003 fokos RDP) felbontásban - ezt a MÁR meglévő
// geometriát használjuk itt is, nem kell hozzá új OSM-kivonat. A Balaton
// (lakes) VÁLTOZATLAN marad: az már eddig is jó felbontású volt. A Fertő-tó
// és a Velencei-tó nem szerepel benne: a Tavak-szakasz saját, kézzel
// rajzolt ábrája ettől függetlenül mutatja mindháromat.
const WATER_GEO_URL = "/water-geo.json?v=2";
// A folyók finomabb (0,001 fokos) egységben vannak kódolva, mint a tavak
// (0,01) - ld. a fenti kommentet és decodeDeltaRings hívását lent.
const WATER_GEO_RIVER_SCALE = 1000;
let waterGeo = null;
let waterGeoLoading = null;

function loadWaterGeo() {
  if (waterGeoLoading) return waterGeoLoading;
  waterGeoLoading = fetch(WATER_GEO_URL)
    .then(res => res.json())
    .then(encoded => {
      waterGeo = {
        rivers: decodeDeltaRings(encoded.rivers, WATER_GEO_RIVER_SCALE),
        lakes: decodeDeltaRings(encoded.lakes),
      };
      radarDrawWaterGeo();
    })
    .catch(err => {
      console.error(err);
      waterGeo = { rivers: [], lakes: [] };
    });
  return waterGeoLoading;
}

// ---- Közös helynévlista (places-hu.json) ----
//
// Statikus fájl, egyszer tölt be, a böngésző gyorsítótárazza (mint a
// borders.json). A radar városfeliratai ÉS a water.js térképei is ezt
// használják, ezért marad a script.js-ben. A hibája sosem buktat el semmit:
// üres lista marad, és a feliratok egyszerűen elmaradnak.
const PLACES_URL = "/places-hu.json?v=2";
let placesList = [];
let placesLoading = null;

function loadPlaces() {
  if (placesLoading) return placesLoading;
  placesLoading = fetch(PLACES_URL)
    .then(res => res.json())
    .then(list => { placesList = list; radarDrawPlaces(); })
    .catch(err => { console.error(err); placesList = []; });
  return placesLoading;
}

// ---- Domborzat (hillshade) a csatorna-térkép hátterében ----
// A felhasználó többször kérte ("terrarians"/"elevation overlay") - statikus
// fájl, mint a borders.json/water-geo.json, NEM a push-worker KV-n megy át
// (a domborzat sosem változik). A soil-moisture-mapper app/elevation.py-ja
// generálja (ld. ott a fejkommentet): Open-Meteo magassági API, egy 90x40-es
// rács, SZERVER OLDALON előre kiszámolt hillshade (0-255 szürkeárnyalat) -
// a frontendnek csak ki kell rajzolnia, nem kell újraszámolnia a
// lejtő-matekot.
const ELEVATION_URL = "/elevation.json?v=1";
let elevationGrid = null;
let elevationLoading = null;

function loadElevation() {
  if (elevationLoading) return elevationLoading;
  elevationLoading = fetch(ELEVATION_URL)
    .then(res => res.json())
    .then(data => { elevationGrid = data; })
    .catch(err => {
      console.error(err);
      elevationGrid = null;
    });
  return elevationLoading;
}

// ---- Radarkép a radaron ----
// A csapadékképet a RainViewer publikus radarcsempéiből rakjuk össze.
//
// FONTOS, mit jelent ez és mit nem: ez CSAK KÉP. A válasz továbbra is az
// Open-Meteo adatán alapul, nem ezen. A kettő eltérhet, és le is mértük, hogy
// eltér: a radar a magasban lévő visszaverődést látja, beleértve a talajzavart
// és a leérés előtt elpárolgó csapadékot, az Open-Meteo pedig a felszíni
// csapadékot modellezi. A csempe átlátszó pixele ráadásul kétértelmű: jelenthet
// "nem esik"-et és "itt nincs radarlefedettség"-et is. Ezért a radarkép
// tájékoztató háttér, nem döntési alap.
//
// Monokróm marad: a csempék színes palettáját nem vesszük át, a pixel
// erősségét a saját előtérszínünk átlátszóságára képezzük le.
const RAINVIEWER_INDEX_URL = "https://api.rainviewer.com/public/weather-maps.json";
const RADAR_IMAGE_MAX_TILES = 9;
const RADAR_IMAGE_INK = 0.45; // mennyire erős legyen a kép a pontok alatt
let radarFrame = null;
let radarFrameLoading = null;

function loadRadarFrame() {
  if (radarFrameLoading) return radarFrameLoading;
  radarFrameLoading = fetch(RAINVIEWER_INDEX_URL)
    .then(res => res.json())
    .then(data => {
      const past = data.radar && data.radar.past;
      radarFrame = past && past.length
        ? { host: data.host, path: past[past.length - 1].path }
        : null;
      drawRadarImage().catch(err => console.error(err)); // megérkezéskor azonnal kirajzoljuk
    })
    .catch(err => {
      console.error(err);
      radarFrame = null;
    });
  return radarFrameLoading;
}

function lonLatToWorldPx(lon, lat, zoom) {
  const size = 256 * 2 ** zoom;
  const s = Math.min(Math.max(Math.sin(lat * Math.PI / 180), -0.9999), 0.9999);
  return {
    x: (lon + 180) / 360 * size,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size,
  };
}

// Akkora nagyítást választunk, hogy a csempe felbontása nagyjából a radar
// saját felbontásához illjen, de a letöltött csempék száma korlátos maradjon.
function radarImageZoom(lat, maxRadiusKm) {
  const kmPerRadarPx = maxRadiusKm / RADAR_MAX_PX;
  const equatorKm = 40075 * Math.cos(lat * Math.PI / 180);
  let zoom = Math.round(Math.log2(equatorKm / (256 * kmPerRadarPx)));
  zoom = Math.max(1, Math.min(7, zoom));
  // A téglalap sarkai a sugárnál messzebbre látnak, tehát a letöltendő
  // terület is ekkora: a becslésnek ezzel kell számolnia, különben a
  // csempeszám túllépi a korlátot.
  const reachKm = maxRadiusKm * RADAR_CORNER_FACTOR;
  while (zoom > 1) {
    const tileKm = equatorKm / 2 ** zoom;
    if ((2 * reachKm / tileKm + 1) ** 2 <= RADAR_IMAGE_MAX_TILES) break;
    zoom -= 1;
  }
  return zoom;
}

function loadTileImage(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // enélkül a canvas "megfertőződne", és nem lehetne pixelt olvasni
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function foregroundRgb() {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (!hex) return [17, 17, 17];
  const n = parseInt(hex[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

let radarImageToken = 0;

async function drawRadarImage() {
  const el = document.getElementById("radar-image");
  el.removeAttribute("href");
  // Gyors egymás utáni nagyításnál a régebbi kép később is megérkezhet: csak
  // a legutolsó kérés rajzolhat.
  const imageToken = ++radarImageToken;
  if (!radarFrame || !radarOrigin || !radarMaxRadiusKm) return;

  const zoom = radarImageZoom(radarOrigin.lat, radarMaxRadiusKm);
  const world = 256 * 2 ** zoom;
  const tiles = 2 ** zoom;
  const centre = lonLatToWorldPx(radarOrigin.lon, radarOrigin.lat, zoom);
  const kmPerTilePx = 40075 * Math.cos(radarOrigin.lat * Math.PI / 180) / world;
  const radiusPx = (radarMaxRadiusKm * RADAR_CORNER_FACTOR) / kmPerTilePx;
  const tx0 = Math.floor((centre.x - radiusPx) / 256);
  const tx1 = Math.floor((centre.x + radiusPx) / 256);
  const ty0 = Math.floor((centre.y - radiusPx) / 256);
  const ty1 = Math.floor((centre.y + radiusPx) / 256);

  const stitched = document.createElement("canvas");
  stitched.width = (tx1 - tx0 + 1) * 256;
  stitched.height = (ty1 - ty0 + 1) * 256;
  const stitchedCtx = stitched.getContext("2d", { willReadFrequently: true });
  const loads = [];
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      if (ty < 0 || ty >= tiles) continue;
      const wrapped = ((tx % tiles) + tiles) % tiles;
      const url = `${radarFrame.host}${radarFrame.path}/256/${zoom}/${wrapped}/${ty}/2/1_1.png`;
      loads.push(loadTileImage(url).then(img => {
        if (img) stitchedCtx.drawImage(img, (tx - tx0) * 256, (ty - ty0) * 256);
      }));
    }
  }
  await Promise.all(loads);
  if (imageToken !== radarImageToken) return; // közben új keresés/nagyítás indulhatott

  const source = stitchedCtx.getImageData(0, 0, stitched.width, stitched.height);
  const out = document.createElement("canvas");
  out.width = RADAR_W;
  out.height = RADAR_H;
  const outCtx = out.getContext("2d");
  const target = outCtx.createImageData(RADAR_W, RADAR_H);
  const [fr, fg, fb] = foregroundRgb();

  // A radar azimutális ekvidisztáns vetület, a csempék Mercator-vetületűek,
  // ezért pixelenként visszaszámoljuk, melyik koordináta tartozik ide.
  for (let y = 0; y < RADAR_H; y++) {
    for (let x = 0; x < RADAR_W; x++) {
      const dx = x - RADAR_CENTER_X;
      const dy = y - RADAR_CENTER_Y;
      const r = Math.hypot(dx, dy);
      const bearing = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
      const point = destinationPoint(radarOrigin.lat, radarOrigin.lon, bearing,
        r / RADAR_MAX_PX * radarMaxRadiusKm);
      const w = lonLatToWorldPx(point.lon, point.lat, zoom);
      let sx = Math.round(w.x - tx0 * 256);
      const sy = Math.round(w.y - ty0 * 256);
      if (sx < 0) sx += world;
      if (sx >= world) sx -= world;
      if (sx < 0 || sy < 0 || sx >= stitched.width || sy >= stitched.height) continue;
      const alpha = source.data[(sy * stitched.width + sx) * 4 + 3];
      if (!alpha) continue;
      const di = (y * RADAR_W + x) * 4;
      target.data[di] = fr;
      target.data[di + 1] = fg;
      target.data[di + 2] = fb;
      target.data[di + 3] = Math.round(alpha * RADAR_IMAGE_INK);
    }
  }
  outCtx.putImageData(target, 0, 0);
  el.setAttribute("href", out.toDataURL());
}

// Közös vetítő a határokhoz ÉS a folyókhoz/Balatonhoz: mindkettő ugyanúgy
// lon/lat gyűrűkből (zárt vagy nyitott vonalakból) áll, és ugyanúgy kell
// SVG path "d" attribútummá alakítani, a látható területről kilépő
// szakaszokat megszakítva, nem a peremre lapítva.
function radarProjectRingsToPath(rings) {
  // Olcsó előszűrés szélesség szerint: kis sugárnál a csúcsok túlnyomó része
  // eleve kiesik, így nem kell rájuk gömbi távolságot számolni. A téglalap
  // sarkai a sugárnál messzebbre látnak, ezért a sávot ki kell tágítani.
  const reachKm = radarMaxRadiusKm * RADAR_CORNER_FACTOR;
  const latSpan = (reachKm / 111) * 1.4 + 1;
  let d = "";
  for (const ring of rings) {
    let connected = false;
    for (const [lon, lat] of ring) {
      let projected = null;
      if (Math.abs(lat - radarOrigin.lat) <= latSpan) {
        const dist = distanceKm(radarOrigin.lat, radarOrigin.lon, lat, lon);
        if (dist <= reachKm) {
          const bearing = bearingBetween(radarOrigin.lat, radarOrigin.lon, lat, lon);
          const p = radarProject(bearing, dist, radarMaxRadiusKm);
          // A téglalapon kívülre eső csúcsok kimaradnak: a viewBox amúgy is
          // levágná őket, de így a szakaszok is helyesen szakadnak meg.
          if (p.x >= 0 && p.x <= RADAR_W && p.y >= 0 && p.y <= RADAR_H) projected = p;
        }
      }
      if (!projected) {
        connected = false; // a látható területről kilépő szakaszt megszakítjuk
        continue;
      }
      d += `${connected ? "L" : "M"}${projected.x.toFixed(1)} ${projected.y.toFixed(1)}`;
      connected = true;
    }
  }
  return d;
}

function radarDrawBorders() {
  const layer = document.getElementById("radar-borders");
  layer.innerHTML = "";
  if (!borderRings || !radarOrigin || !radarMaxRadiusKm) return;

  const d = radarProjectRingsToPath(borderRings);
  if (!d) return;

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.classList.add("radar-border");
  layer.appendChild(path);
}

function radarDrawWaterGeo() {
  const layer = document.getElementById("radar-water");
  layer.innerHTML = "";
  if (!waterGeo || !radarOrigin || !radarMaxRadiusKm) return;

  const riverD = radarProjectRingsToPath(waterGeo.rivers);
  if (riverD) {
    const riverPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    riverPath.setAttribute("d", riverD);
    riverPath.classList.add("radar-river");
    layer.appendChild(riverPath);
  }

  const lakeD = radarProjectRingsToPath(waterGeo.lakes);
  if (lakeD) {
    const lakePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    lakePath.setAttribute("d", lakeD);
    lakePath.classList.add("radar-lake");
    layer.appendChild(lakePath);
  }
}

// Nagyvárosok feliratai a radaron, hogy az országhatár alakját nem ismerő is
// el tudjon igazodni (places-hu.json, ld. loadPlaces). A nagyítással egyre
// kisebb települések is kiíródnak; az egymást fedőket kihagyjuk.
function radarDrawPlaces() {
  const layer = document.getElementById("radar-places");
  layer.innerHTML = "";
  if (!placesList.length || !radarOrigin || !radarMaxRadiusKm) return;

  const maxRank = radarMaxRadiusKm >= 150 ? 1 : radarMaxRadiusKm >= 60 ? 2 : 3;
  const k = radarScaleK();
  const reachKm = radarMaxRadiusKm * RADAR_CORNER_FACTOR;
  const candidates = [];
  for (const p of placesList) {
    if (p.r > maxRank) continue;
    const dist = distanceKm(radarOrigin.lat, radarOrigin.lon, p.lat, p.lon);
    if (dist > reachKm || dist < radarMaxRadiusKm * 0.03) continue;
    const pos = radarProject(bearingBetween(radarOrigin.lat, radarOrigin.lon, p.lat, p.lon), dist, radarMaxRadiusKm);
    if (pos.x < 4 || pos.x > RADAR_W - 4 || pos.y < 8 || pos.y > RADAR_H - 4) continue;
    candidates.push({ p, pos });
  }
  candidates.sort((a, b) => a.p.r - b.p.r);

  // A felirat kb. 11 px-es betű: a szélessége viewBox-egységben a k-val osztva.
  const placed = [];
  const MAX_LABELS = 14;
  for (const c of candidates) {
    if (placed.length >= MAX_LABELS) break;
    const w = (c.p.n.length * 6.2 + 8) / k, h = 14 / k;
    const onRight = c.pos.x > RADAR_W - w - 10;
    const x0 = onRight ? c.pos.x - w : c.pos.x;
    const box = { x0, x1: x0 + w, y0: c.pos.y - h, y1: c.pos.y + 3 / k };
    if (placed.some(b => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue;
    placed.push(box);
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", c.pos.x.toFixed(1));
    dot.setAttribute("cy", c.pos.y.toFixed(1));
    dot.setAttribute("r", (1.6 / k).toFixed(2));
    dot.classList.add("radar-place-dot");
    layer.appendChild(dot);
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", (c.pos.x + (onRight ? -3 : 3) / k).toFixed(1));
    text.setAttribute("y", (c.pos.y - 3 / k).toFixed(1));
    text.setAttribute("text-anchor", onRight ? "end" : "start");
    text.classList.add("radar-place");
    text.textContent = c.p.n;
    layer.appendChild(text);
  }
}

// A radar képpont-léptéke: hány képernyő-képpont jut egy viewBox-egységre.
// Nagyobb képernyőn az SVG szövege is nagyobbra nőne (a #radar-svg max-width
// 720 px, a viewBox 350 egység), ezért a feliratok méretét ennek reciprokával
// osztjuk (--k), így a betűméret mindenhol ugyanannyi képpont marad.
function radarScaleK() {
  const svg = document.getElementById("radar-svg");
  const width = parseFloat(getComputedStyle(svg).width);
  return width > 0 ? width / RADAR_W : 1;
}

function updateRadarScale() {
  document.getElementById("radar-svg").style.setProperty("--k", radarScaleK().toFixed(3));
}

if ("ResizeObserver" in window) {
  new ResizeObserver(() => {
    updateRadarScale();
    radarDrawPlaces();
  }).observe(document.getElementById("radar-svg"));
}

// Az alaptérkép minden rétege egyben. Csak akkor rajzol, ha a hely vagy a
// sugár változott az utolsó rajzolás óta (különben a rétegek belépő animációja
// feleslegesen újraindulna, pl. a keresés végén, ha a sugár már jó). A
// rétegek külön, lusta betöltésű adatai megérkezéskor maguk rajzolják ki a
// saját rétegüket (loadBorders, loadWaterGeo, loadPlaces, loadRadarFrame).
function radarDrawBase() {
  if (!radarOrigin || !radarMaxRadiusKm) return;
  const key = `${radarOrigin.lat},${radarOrigin.lon},${radarMaxRadiusKm}`;
  if (key === radarBaseKey) return;
  radarBaseKey = key;
  radarDrawBorders();
  radarDrawWaterGeo();
  radarDrawPlaces();
  drawRadarImage().catch(err => console.error(err));
}

// ---- Nagyítás a keresés VÉGE után ----
// Csak a megjelenített sugarat (radarMaxRadiusKm) változtatjuk: a határok,
// folyók, városfeliratok és a RainViewer-kép ugyanazzal a függvénnyel
// rajzolódnak újra, mint a keresés végén, a korábbi körök pontjait pedig a
// már meglévő tier.scale mechanizmus (CSS transform) igazítja. A keresést, a
// pásztázó vonalat és a RADAR_SWEEP_MS-t nem érintjük.
const RADAR_ZOOM_MIN_LEVEL = -1;
const RADAR_ZOOM_MAX_LEVEL = 3;
const RADAR_ZOOM_MIN_RADIUS_KM = 12;
let radarBaseRadiusKm = 0;
let radarZoomLevel = 0;

function radarZoomTo(level) {
  if (!radarBaseRadiusKm) return;
  const clamped = Math.max(RADAR_ZOOM_MIN_LEVEL, Math.min(RADAR_ZOOM_MAX_LEVEL, level));
  const radius = radarBaseRadiusKm / 2 ** clamped;
  if (radius < RADAR_ZOOM_MIN_RADIUS_KM) return;
  if (clamped === radarZoomLevel) return;
  radarZoomLevel = clamped;
  clearRadarPlace();
  radarMaxRadiusKm = radius;
  radarDrawBase();
  radarTierGroups.forEach(tier => {
    tier.scale = tier.maxRadiusKm / radius;
    tier.el.style.transform = `scale(${tier.scale})`;
  });
  updateRadarZoomButtons();
}

function updateRadarZoomButtons() {
  const minRadius = radarBaseRadiusKm / 2 ** (radarZoomLevel + 1);
  document.getElementById("radar-zoom-in").disabled =
    radarZoomLevel >= RADAR_ZOOM_MAX_LEVEL || minRadius < RADAR_ZOOM_MIN_RADIUS_KM;
  document.getElementById("radar-zoom-out").disabled = radarZoomLevel <= RADAR_ZOOM_MIN_LEVEL;
  document.getElementById("radar-zoom-reset").disabled = radarZoomLevel === 0;
}

function radarZoomResetState() {
  radarBaseRadiusKm = 0;
  radarZoomLevel = 0;
}

document.getElementById("radar-zoom-in").addEventListener("click", () => radarZoomTo(radarZoomLevel + 1));
document.getElementById("radar-zoom-out").addEventListener("click", () => radarZoomTo(radarZoomLevel - 1));
document.getElementById("radar-zoom-reset").addEventListener("click", () => radarZoomTo(0));

// Görgővel (Ctrl/Cmd, hogy az oldal görgetését ne vegye el) és két ujjas
// csippentéssel is nagyítható; egy ujjal az oldal görög tovább (CSS
// touch-action: pan-y).
{
  const svg = document.getElementById("radar-svg");
  svg.addEventListener("wheel", event => {
    if (!radarBaseRadiusKm || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    radarZoomTo(radarZoomLevel + (event.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  const pointers = new Map();
  let pinchStartDist = 0;
  let pinchStartLevel = 0;
  svg.addEventListener("pointerdown", event => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
      pinchStartLevel = radarZoomLevel;
    }
  });
  svg.addEventListener("pointermove", event => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size !== 2 || !pinchStartDist) return;
    const [a, b] = [...pointers.values()];
    const ratio = Math.hypot(a.x - b.x, a.y - b.y) / pinchStartDist;
    radarZoomTo(pinchStartLevel + Math.round(Math.log2(ratio)));
  });
  const endPointer = event => { pointers.delete(event.pointerId); pinchStartDist = 0; };
  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);
}

function radarReset() {
  document.getElementById("radar-tiers").innerHTML = "";
  document.getElementById("radar-places").innerHTML = "";
  radarBaseKey = ""; // a feliratok törlődtek, a következő radarDrawBase újrarajzol
  radarTierGroups = [];
  radarZoomResetState();
  clearRadarPlace();
}

// ---- Esős pont megkoppintása ----
// Az esős pontok kattinthatók: megmutatjuk, melyik település fölött vannak.
// Az országot csak akkor írjuk ki, ha eltér a felhasználó országától, hogy
// belföldi találatnál ne legyen felesleges zaj.
const radarPlaceCache = new Map();
let radarPlaceToken = 0;

function clearRadarPlace() {
  document.getElementById("radar-labels").innerHTML = "";
}

// A feliratot a pötty mellé írjuk. A pötty saját koordinátája a köre (tier)
// helyi rendszerében van, a régebbi körök viszont össze vannak zoomolva,
// ezért a tárolt nagyítással számoljuk vissza a tényleges helyet.
function radarLabelPosition(dot) {
  const tier = radarTierGroups.find(t => t.el === dot.parentNode);
  const scale = tier ? tier.scale : 1;
  return {
    x: RADAR_CENTER_X + (Number(dot.dataset.cx) - RADAR_CENTER_X) * scale,
    y: RADAR_CENTER_Y + (Number(dot.dataset.cy) - RADAR_CENTER_Y) * scale,
  };
}

function setRadarLabel(dot, text) {
  const labels = document.getElementById("radar-labels");
  labels.innerHTML = "";
  const { x, y } = radarLabelPosition(dot);
  // A radar jobb felén befelé, balra írjuk a nevet, különben kilógna a képből.
  const onRight = x > RADAR_CENTER_X;
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.classList.add("radar-label");
  label.setAttribute("x", onRight ? x - 12 : x + 12);
  label.setAttribute("y", y + 7);
  label.setAttribute("text-anchor", onRight ? "end" : "start");
  label.textContent = text;
  labels.appendChild(label);
}

async function showRadarPlace(dot) {
  const key = `${dot.dataset.lat},${dot.dataset.lon}`;

  if (radarPlaceCache.has(key)) {
    setRadarLabel(dot, radarPlaceCache.get(key));
    return;
  }

  // Ha közben másik pontra koppintanak, csak a legutolsó válasza kerüljön ki.
  const token = ++radarPlaceToken;
  setRadarLabel(dot, "…");
  let label;
  try {
    const place = await findNearbyName({
      lat: Number(dot.dataset.lat),
      lon: Number(dot.dataset.lon),
    });
    const isForeign = place.countryCode && currentLoc && currentLoc.countryCode &&
      place.countryCode !== currentLoc.countryCode;
    label = place.name
      ? (isForeign ? `${place.name}, ${place.countryName}` : place.name)
      : "névtelen térség";
    radarPlaceCache.set(key, label);
  } catch (err) {
    console.error(err);
    label = "a helynév most nem érhető el";
  }
  if (token === radarPlaceToken) setRadarLabel(dot, label);
}

document.getElementById("radar-tiers").addEventListener("click", (event) => {
  const dot = event.target.closest(".radar-dot");
  if (dot) showRadarPlace(dot);
});

// A pásztázó vonal egy körbefordulásának ideje. Tartsd szinkronban a
// style.css #radar-sweep animációjának időtartamával: a pontok felfedése
// ehhez az értékhez igazítva számolja ki, mikor ér a vonal az adott
// irányhoz (lásd radarRevealTier).
const RADAR_SWEEP_MS = 1500;
let sweepStartedAt = 0;

function radarRestartSweep() {
  const sweep = document.getElementById("radar-sweep");
  sweep.style.animation = "none";
  sweep.getBoundingClientRect(); // kényszerített újraszámolás, hogy tényleg újrainduljon
  sweep.style.animation = "";
  sweepStartedAt = Date.now();
}

// Hol tart most a pásztázó vonal, fokban (0 = észak, óramutató szerint).
//
// A böngésző a háttérbe került lapon megállítja a CSS-animációt, a Date.now()
// viszont fut tovább. Ha csak órával számolnánk, visszatéréskor a felfestés
// elcsúszna a vonal valódi állásától, és a pontok rossz irányban villannának
// fel. A Web Animations API a tényleges animációs időt adja vissza, ami a
// megállást is figyelembe veszi; ha nem elérhető, marad az óra.
function sweepAngleNow() {
  const sweep = document.getElementById("radar-sweep");
  const animation = sweep.getAnimations ? sweep.getAnimations()[0] : null;
  const elapsed = animation && typeof animation.currentTime === "number"
    ? animation.currentTime
    : Date.now() - sweepStartedAt;
  return ((elapsed % RADAR_SWEEP_MS) / RADAR_SWEEP_MS) * 360;
}


// Új kört ad a radarhoz, a saját legnagyobb sugarához igazított skálán. A
// korábban hozzáadott köröket arányosan összébb zoomolja (CSS transition),
// hogy az új, nagyobb kör is beleférjen ugyanabba a fizikai méretbe.
function radarAddTier(points, maxRadiusKm, userLoc) {
  // A radar átskálázódik, tehát a korábbi felirat rossz helyre mutatna.
  clearRadarPlace();
  // A határréteg mindig az aktuális, legnagyobb sugárhoz igazodik, ezért a
  // korábbi körökkel ellentétben nem zoomoljuk, hanem újrarajzoljuk.
  // A kijelzett sugár sosem kisebb a RADAR_MIN_VISUAL_RADIUS_KM-nél, így a
  // térkép a töltés alatt is a felhasználó környékét mutatja, és a keresés
  // végén sem keretez át. A kör pontjai a SAJÁT sugarukhoz vetítve maradnak.
  const shownRadiusKm = Math.max(maxRadiusKm, RADAR_MIN_VISUAL_RADIUS_KM);
  radarOrigin = userLoc;
  radarMaxRadiusKm = shownRadiusKm;
  radarDrawBase();
  radarTierGroups.forEach(tier => {
    tier.scale = tier.maxRadiusKm / shownRadiusKm;
    tier.el.style.transform = `scale(${tier.scale})`;
  });

  // A lekérdezett pontokat NEM rajzoljuk ki: a radarkép már mutatja, hol van
  // csapadék, a mintavételi háló kirajzolva csak zaj lenne. Pötty csak oda
  // kerül, ahol tényleg esik (lásd radarRevealTier), ezért a kört üresen
  // hozzuk létre, és a pontokat csak megjegyezzük hozzá.
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.classList.add("radar-tier-group");
  document.getElementById("radar-tiers").appendChild(g);
  radarTierGroups.push({ el: g, maxRadiusKm, scale: 1, points });
}

// Egyetlen találati pötty létrehozása: a csapadék TÍPUSÁNAK piktogramja
// (eső: csepp, hó: hópehely, ónos eső: csepp jégjellel; a szimbólumok az
// index.html #radar-svg <defs> részében vannak). A mérete és árnyalata az
// intenzitás-sávot követi, és rákoppintva megmutatja a helynevet (lásd
// showRadarPlace). Az időzítéshez nem nyúlunk: ugyanabból a setTimeoutból
// hívódik, mint korábban a kör.
const RADAR_ICON_BY_KIND = { rain: "ico-rain", snow: "ico-snow", ice: "ico-ice" };

function addRainDot(tier, index, hit, plain = false) {
  const point = tier.points[index];
  if (!point) return;
  const { mm, kind } = hit;
  const band = intensityBand(mm);
  const { x, y } = radarPolarPoint(point.bearing, point.distance, tier.maxRadiusKm);
  const svgNS = "http://www.w3.org/2000/svg";
  // Az ónos eső jele (csepp kivágott csillaggal) kicsiben nem olvasható, ezért nagyobb.
  const size = band.dotRadius * (kind === "ice" ? 3.6 : 2.8);

  const dot = document.createElementNS(svgNS, "g");
  dot.classList.add("radar-dot", `rain-${band.key}`, `kind-${kind}`);
  dot.dataset.cx = x;
  dot.dataset.cy = y;
  dot.dataset.lat = point.lat;
  dot.dataset.lon = point.lon;
  dot.setAttribute("transform", `translate(${x} ${y})`);
  if (plain) {
    // Sűrű csoportban csak a legerősebb pont kap piktogramot (lásd
    // glyphIndexes), a többi az egykori egyszerű kis pötty.
    dot.classList.add("radar-dot-plain");
    const hitArea = document.createElementNS(svgNS, "circle");
    hitArea.setAttribute("r", 8);
    hitArea.classList.add("radar-dot-hit");
    dot.appendChild(hitArea);
    const mark = document.createElementNS(svgNS, "circle");
    mark.setAttribute("r", 2);
    mark.classList.add("ico-fill");
    dot.appendChild(mark);
    tier.el.appendChild(dot);
    return;
  }
  // Átlátszó, nagyobb tapintási felület a kicsi piktogram köré.
  const hitArea = document.createElementNS(svgNS, "circle");
  hitArea.setAttribute("r", 12);
  hitArea.classList.add("radar-dot-hit");
  dot.appendChild(hitArea);
  const icon = document.createElementNS(svgNS, "use");
  icon.setAttribute("href", `#${RADAR_ICON_BY_KIND[kind] || RADAR_ICON_BY_KIND.rain}`);
  icon.setAttribute("x", -size / 2);
  icon.setAttribute("y", -size / 2);
  icon.setAttribute("width", size);
  icon.setAttribute("height", size);
  dot.appendChild(icon);
  tier.el.appendChild(dot);

  const pulse = document.createElementNS(svgNS, "circle");
  pulse.setAttribute("cx", x);
  pulse.setAttribute("cy", y);
  pulse.setAttribute("r", band.dotRadius + 2);
  pulse.classList.add("radar-pulse", "pulsing");
  tier.el.appendChild(pulse);
}

// A rainByIndex egy Map: rácspont indexe -> { mm (mm/órában), kind } (rainHits). Minden pötty
// akkor jelenik meg, amikor a pásztázó vonal az ő irányához ér, tehát a vonal
// "festi fel" őket. Az ígéret egy teljes fordulat után teljesül, akkor is, ha
// ebben a körben nem volt eső: így a vonal láthatóan végigpásztázza a kört,
// mielőtt a keresés kijjebb lép.
// Képernyőn ~16 px-es cellánként legfeljebb egy piktogram marad (a legerősebb
// találat); a többi sima kis pötty. Különben a sűrű találati csoport egy
// összefüggő folttá olvadna. Csak a megjelenítést válogatja, az időzítést nem.
const RADAR_GLYPH_CELL_PX = 16;

function glyphIndexes(tier, rainByIndex) {
  const k = radarScaleK();
  const best = new Map();
  rainByIndex.forEach((hit, index) => {
    const point = tier.points[index];
    if (!point) return;
    const p = radarPolarPoint(point.bearing, point.distance, tier.maxRadiusKm);
    const sx = (RADAR_CENTER_X + (p.x - RADAR_CENTER_X) * tier.scale) * k;
    const sy = (RADAR_CENTER_Y + (p.y - RADAR_CENTER_Y) * tier.scale) * k;
    const cell = `${Math.floor(sx / RADAR_GLYPH_CELL_PX)},${Math.floor(sy / RADAR_GLYPH_CELL_PX)}`;
    const cur = best.get(cell);
    if (cur === undefined || hit.mm > rainByIndex.get(cur).mm) best.set(cell, index);
  });
  return new Set(best.values());
}

function radarRevealTier(rainByIndex, { instant = false } = {}) {
  const tier = radarTierGroups[radarTierGroups.length - 1];
  if (!tier) return Promise.resolve();
  const glyphs = glyphIndexes(tier, rainByIndex);

  if (instant) {
    rainByIndex.forEach((hit, index) => addRainDot(tier, index, hit, !glyphs.has(index)));
    return Promise.resolve();
  }

  const sweepAngle = sweepAngleNow();
  rainByIndex.forEach((hit, index) => {
    const point = tier.points[index];
    if (!point) return;
    const degreesAhead = (point.bearing - sweepAngle + 360) % 360;
    setTimeout(() => addRainDot(tier, index, hit, !glyphs.has(index)), (degreesAhead / 360) * RADAR_SWEEP_MS);
  });
  return new Promise(resolve => setTimeout(resolve, RADAR_SWEEP_MS));
}


// ---- Fő logika ----

// Ha két run() futna egyszerre (pl. a percenkénti automatikus frissítés
// pont akkor indulna, amikor egy korábbi keresés még nem ért véget), a
// kettő versenyhelyzetbe kerülne: az első befejeződő "finally"-ja elrejtené
// a radart a másik alól. Ezért csak egy run() futhat egyszerre - a többi
// hívás egyszerűen kimarad, amíg az aktuális be nem fejeződik.
let runInProgress = false;
let runToken = 0;

// A "silent" futás a percenkénti háttérfrissítés: ilyenkor NEM játsszuk újra
// a teljes koreográfiát (nem tűnik el a válasz, nem ugrik vissza a radar a
// kiinduló helyére), csak az adatok és a radar pontjai frissülnek a helyükön.
async function run(userLoc, { silent = false } = {}) {
  // A percenkénti háttérfrissítés nem szólhat bele egy futó keresésbe. Egy új
  // KÉRT keresés viszont mindig felülírja a folyamatban lévőt: a régi futás a
  // következő await után csendben kilép. Enélkül a helyszín módosítása után az
  // új keresés némán kimaradt volna, és a régi település válasza íródott volna
  // ki az új helyszín neve alá.
  if (silent && runInProgress) return;
  const token = ++runToken;
  const superseded = () => token !== runToken;
  runInProgress = true;
  if (silent) {
    radarReset();
  } else {
    beginSearchUI();
  }
  try {
    // Régebbi mentett helyzeteknél még hiányozhat az országkód (korábbi
    // verzióban nem tároltuk) - pótoljuk, hogy a külföldi találatoknál
    // helyesen tudjuk megjeleníteni az országot.
    if (!userLoc.countryCode) {
      try {
        const here = await reverseGeocode(userLoc.lat, userLoc.lon);
        userLoc.countryCode = here.countryCode;
        saveLocation(userLoc);
      } catch (err) {
        console.error(err);
      }
    }

    // A kicsi címke (#q1-question) és a keresés alatt látható nagy címsor
    // (#q1-big, aria-hidden másolat) ugyanazt a szöveget kapja.
    const q1Text = SNOW_MODE
      ? `Havazik-e ${userLoc.name} környékén?`
      : `Esik-e ${userLoc.name} környékén?`;
    document.getElementById("q1-question").textContent = q1Text;
    const q1Big = document.getElementById("q1-big");
    if (q1Big) q1Big.textContent = q1Text;

    // === 1. FÁZIS: esik-e a környéken? ===
    // Csak ezt keressük: a saját hely részletes előrejelzését és a legelső,
    // 60 km-es gyűrűt (ez a "környék"). A radar kört a hívás ELŐTT rajzoljuk
    // fel üresen, hogy a pásztázó vonal a várakozás alatt is fusson, és a
    // válasz megérkezésekor legyen mit felfestenie.
    const firstBatch = SEARCH_RINGS[0];
    const firstMaxRadius = firstBatch[firstBatch.length - 1][0];
    const firstGrid = generateSearchGrid(userLoc, firstBatch);
    radarAddTier(firstGrid, firstMaxRadius, userLoc);
    const [userForecast, firstGridForecasts] = await Promise.all([
      fetchUserForecast(userLoc),
      fetchPrecipitation(firstGrid),
    ]);
    if (superseded()) return;
    const firstRain = rainHits(firstGrid, firstGridForecasts);
    let raining = sortRaining(firstGrid, firstGridForecasts);

    // A helynév-lekérést már a felfestés ALATT elindítjuk. Enélkül a radar a
    // kész kép fölött pörögne tovább, amíg a geokódoló válaszol: a pontok
    // mind kint vannak, mégsem történik semmi.
    // A lookup-ot csak az isRainingNow ág hagyja figyelmen kívül (az korábban
    // tér vissza, mielőtt idáig érne) - az isRainingSoon ág UX-audit U01/U02
    // óta NEM tér vissza korán, tehát ennek a kezdő lookup-nak IS futnia kell,
    // különben a lenti "if (raining.length > 0) { const { refined } = await
    // lookup; }" null-on bukna el, ha már az 1. gyűrűben volt találat.
    let lookup = !isRainingNow(userForecast) && raining.length > 0 ? startLookup(userLoc, raining[0]) : null;

    await radarRevealTier(firstRain, { instant: silent });
    if (superseded()) return;

    // Ha nálad esik (vagy hamarosan fog), a "de hol esik pontosan?" kérdés
    // értelmetlen: a válasz az, hogy itt. Ilyenkor nincs 2. fázis.
    if (isRainingNow(userForecast)) {
      const mm = currentPrecipRate(userForecast);
      const band = intensityBand(mm);
      const kind = precipKind(userForecast);
      const duration = rainDurationHours(userForecast);
      // Ha van 15 perces adat, az pontosabb, mint az órás "még kb. N óráig".
      const outlook = minutelyOutlook(userForecast, true, kind);
      const lines = [mm >= RAIN_THRESHOLD_MM ? `${band.adv}, ${formatMm(mm)} mm/óra` : band.adv];
      lines.push(outlook || (duration === null ? null : duration <= 0 ? "hamarosan eláll" : `még kb. ${duration} óráig tart`));
      setHero(SNOW_MODE ? "Havazik" : nowHeroText(kind), lines);
      hideQ2();
      return;
    }
    // "Hamarosan" korábban ÖNÁLLÓ válaszként, saját időablak és a
    // legközelebbi eső keresése NÉLKÜL jelent meg (UX-audit U01/U02): a
    // jelen állapotot (most nem esik) és az előrejelzést (lehet, hogy
    // hamarosan fog) egybemosta, ráadásul teljesen elrejtette a #q2-block-ot.
    // Itt csak egy KIEGÉSZÍTŐ kontextus-sort készítünk elő - a tényleges
    // választ és a 2. fázisú keresést lent, a "Nem"-mel KÖZÖS ágban kapja
    // meg, így a legközelebbi eső innentől ebben az állapotban is látszik.
    // A 3 órás ablak nem kitalált szám: pontosan az, amit soonRainIndex
    // ténylegesen átvizsgál - nem mondunk többet, mint amit tudunk.
    let soonContext = null;
    if (!SNOW_MODE && isRainingSoon(userForecast)) {
      const idx = soonRainIndex(userForecast);
      const mm = userForecast.hourly.precipitation[idx];
      const prob = userForecast.hourly.precipitation_probability?.[idx];
      const band = intensityBand(mm);
      const hoursAhead = idx - currentHourIndex(userForecast);
      const probText = typeof prob === "number" ? `${Math.round(prob)}% eséllyel ` : "";
      const etaText = hoursAhead <= 0
        ? "akár ezen az órán belül"
        : hoursAhead === 1 ? "becslés szerint kb. 1 óra múlva" : `becslés szerint kb. ${hoursAhead} óra múlva`;
      soonContext = [
        `A következő 3 órában ${probText}${band.adj} eső várható`,
        etaText,
      ];
    }

    // A 15 perces kitekintés ("Kb. 30 perc múlva ideérhet.") a fő válasz alatti
    // első sor; ha van, a durvább órás becslés-sor (etaText) helyett áll.
    const arrival = minutelyOutlook(userForecast, false);
    if (arrival) soonContext = [soonContext ? soonContext[0] : null, arrival];
    const answer = soonContext ? "Most nem esik" : (raining.length > 0 ? "Igen" : "Nem");
    if (SNOW_MODE && !soonContext) soonContext = ["Nálad nem havazik."];

    // Csendes háttérfrissítésnél csak akkor megyünk tovább a távoli
    // keresésre, ha a környék helyzete meg is változott. A "hol esik
    // pontosan" válasz néhány perc alatt nem avul el annyira, hogy megérné
    // érte minden frissítéskor újra végigjárni az összes távoli gyűrűt is:
    // úgy egy nyitva hagyott lap napi több tízezer pontot kérne le.
    const unchanged = silent &&
      document.getElementById("q1-answer").textContent === answer;
    setHero(answer, soonContext);
    showQ2(whereQuestion(raining.length > 0 ? raining[0].kind : "rain"));
    if (unchanged) return;

    // Az 1. fázis vége: a radar lecsúszik eggyel, megjelenik a válasz és a
    // következő kérdés, és a keresés alatta folytatódik. Itt nincs külön
    // várakozás, mert a pontok felfestése már kitöltött egy teljes fordulatot.
    if (!silent) await revealPhase(PHASE_WHERE, 0);
    if (superseded()) return;

    // === 2. FÁZIS: de hol esik pontosan? ===
    for (let i = 1; i < SEARCH_RINGS.length && raining.length === 0; i++) {
      const batch = SEARCH_RINGS[i];
      const maxRadius = batch[batch.length - 1][0];
      const grid = generateSearchGrid(userLoc, batch);
      radarAddTier(grid, maxRadius, userLoc);
      const forecasts = await fetchPrecipitation(grid);
      if (superseded()) return;
      const rainByIndex = rainHits(grid, forecasts);
      raining = sortRaining(grid, forecasts);
      if (raining.length > 0) lookup = startLookup(userLoc, raining[0]);
      await radarRevealTier(rainByIndex, { instant: silent });
      if (superseded()) return;
    }

    if (raining.length > 0) {
      const { refined, place } = await lookup;
      if (superseded()) return;
      // A finomító pontokat ugyanazon a léptéken mutatjuk, mint az aktuális
      // kört (azonos maxRadius mellett a radarAddTier nem zoomol át semmit).
      if (!silent && refined.points.length > 0) {
        radarAddTier(refined.points, radarMaxRadiusKm, userLoc);
        await radarRevealTier(refined.rain);
        if (superseded()) return;
      }
      showNearestRain(refined.nearest, place, userLoc);
    } else {
      const maxKm = SEARCH_RINGS[SEARCH_RINGS.length - 1].at(-1)[0];
      setQ2Answer(`<p class="place-line">Sehol</p>
        <p class="context">${maxKm} km-en belül sem találtunk ${SNOW_MODE ? "havazást" : "esőt"}</p>`);
    }
  } catch (err) {
    console.error(err);
    // Csendes háttérfrissítésnél NEM írjuk felül a meglévő, jó választ egy
    // hibaüzenettel: egy átmeneti hálózati hiba vagy 429 ilyenkor azonnal
    // letörölné a képernyőn álló érvényes eredményt.
    if (!silent && !superseded()) {
      setHero("Hiba", "Nem sikerült lekérni az adatokat. Próbáld újra kicsit később.");
      hideQ2();
    }
  } finally {
    if (!superseded()) {
      if (!silent) scheduleReveal();
      runInProgress = false;
    }
  }
}

// Lefuttatja a finomító hálót, és megkeresi benne a hozzánk legközelebbi esős
// pontot. Ha a finomítás nem talál esőt (előfordul: kis cella, amit a durva
// háló épp eltalált), marad az eredeti találat.
async function refineNearest(userLoc, hit) {
  const points = refinementGrid(userLoc, hit);
  if (points.length === 0) return { points, rain: new Map(), nearest: hit };
  const forecasts = await fetchPrecipitation(points);
  const rain = rainHits(points, forecasts);
  const closest = sortRaining(points, forecasts)[0];
  return {
    points,
    rain,
    nearest: closest && closest.distance < hit.distance ? closest : hit,
  };
}

// A finomítást és a rá épülő helynév-keresést EGYBEN indítjuk, még a kör
// felfestése előtt. Így mindkettő a pásztázás alatt fut le, és mire az utolsó
// pötty a helyére kerül, a végleges válasz általában készen van.
function startLookup(userLoc, hit) {
  return refineNearest(userLoc, hit).then(async refined => ({
    refined,
    place: await findNearbyName(refined.nearest),
  }));
}

function showNearestRain(nearest, place, userLoc) {
  // A kiírt kártya a MEGNEVEZETT helyről szól, ezért annak saját
  // koordinátáihoz kell számolni a távolságot/irányt - a névadó
  // pont a keresés során eltolódhatott az esős ponttól, így a kettő nem
  // feltétlenül ugyanaz.
  const isForeign = place.countryCode && userLoc.countryCode && place.countryCode !== userLoc.countryCode;
  const placeLabel = place.name
    ? (isForeign ? `${place.name}, ${place.countryName}` : place.name)
    : "egy közeli térségben";

  const displayDistance = place.name
    ? distanceKm(userLoc.lat, userLoc.lon, place.lat, place.lon)
    : nearest.distance;
  const displayBearing = place.name
    ? bearingBetween(userLoc.lat, userLoc.lon, place.lat, place.lon)
    : nearest.bearing;

  const direction = compassLabel(displayBearing);
  // A kérdés a VÉGLEGES találat típusához igazodik (a távolabbi körökben
  // talált, vagy a finomítás után közelebbi pont típusa eltérhetett az elsőtől).
  document.getElementById("q2-question").textContent = whereQuestion(nearest.kind);
  // Az erősség a megtalált esős PONTRA vonatkozik, nem a névadó településre:
  // a kettő eltérhet, ha a legközelebbi esős pontnak nem volt neve.
  const band = typeof nearest.mm === "number" ? intensityBand(nearest.mm) : null;
  const lead = SNOW_MODE || nearest.kind === "snow" ? "Havazik" : nearest.kind === "ice" ? "Ónos eső esik" : null;
  const mmText = nearest.mm >= RAIN_THRESHOLD_MM ? `, ${formatMm(nearest.mm)} mm/óra` : "";
  const intensity = band
    ? `<p class="context">${lead ? `${lead}${mmText}` : `${band.adv} esik, ${formatMm(nearest.mm)} mm/óra`}</p>`
    : "";
  setQ2Answer(
    `<p class="place-line">${placeLabel}</p>
     <p class="context">${Math.round(displayDistance)} km innen
     <span class="direction-arrow" style="transform: rotate(${displayBearing}deg)" title="${direction} irányban" aria-label="${direction} irányban">↑</span></p>
     ${intensity}`
  );
}

// A context egy string vagy stringek tömbje lehet: a "Most esik" állapotnál
// (erősség, időtartam) néha több sorra van szükség.
//
// Ezek a függvények CSAK a tartalmat írják. Hogy a tartalom mikor válik
// láthatóvá, azt egyedül a keresés koreográfiája dönti el (a #result
// data-phase attribútuma, lásd lent) - így nem tud két hely egymás ellen
// dolgozni, és a layout sem ugrik meg keresés közben.
function setHero(answer, context) {
  document.getElementById("q1-answer").textContent = answer;
  const lines = Array.isArray(context) ? context : [context];
  document.getElementById("q1-context").innerHTML = lines
    .filter(Boolean)
    .map(line => `<p class="context">${line}</p>`)
    .join("");
}

function showQ2(question) {
  delete document.getElementById("q2-block").dataset.none;
  document.getElementById("q2-question").textContent = question;
}

function setQ2Answer(html) {
  document.getElementById("q2-answer").innerHTML = html;
}

// A blokk helyét a CSS a végleges fázisig fenntartja (data-none), hogy a radar
// layout-doboza ne ugorjon; lásd style.css és positionRadar.
function hideQ2() {
  document.getElementById("q2-block").dataset.none = "1";
  document.getElementById("q2-answer").innerHTML = "";
}

// ---- "Részletek és statisztika" panel ----
// A panel mindig látható; adatait a radar végleges betöltésekor (PHASE_DONE)
// kéri le, keresésenként egyszer - nem fut bele az 5 percenkénti automatikus
// frissítésbe, mert jóval nehezebb lekérdezés (31+ napos história, több évnyi
// archív összehasonlítás), mint amire a fő keresés épül. Nincs cache:
// egyetlen pontra vonatkozó hívásokról van szó, ez megengedhető egyszerűsítés.
let statsLoading = false;
let statsRunId = 0; // elavult válasz (új keresés közben) nem írhat felül újat

async function buildStatsPanel(point) {
  const runId = ++statsRunId;
  statsLoading = true;
  // Egyértelművé tesszük, hogy minden alábbi adat a KERESETT helyre szól,
  // nem arra a településre, ahol a radar esőt talált.
  document.getElementById("stats-place").textContent =
    `Az adatok helye: ${point.name || "a keresett helyszín"}`;
  const statusEl = document.getElementById("stats-status");
  statusEl.hidden = false;
  statusEl.textContent = "töltés…";
  try {
    const [stats, usual] = await Promise.all([
      fetchUserStats(point),
      fetchUsualPrecipitation(point).catch(err => { console.error(err); return null; }),
    ]);
    if (runId !== statsRunId) return;
    const todayIdx = stats.daily.time.indexOf(stats.current.time.slice(0, 10));
    fillPrecipStats(stats, usual, todayIdx);
    fillForecastStats(stats, todayIdx);
    fillTempStats(stats, todayIdx);
    fillNext12hStats(stats);
    statusEl.hidden = true;
  } catch (err) {
    console.error(err);
    if (runId === statsRunId) statusEl.textContent = "Nem sikerült lekérni a statisztikát. Próbáld újra kicsit később.";
  } finally {
    if (runId === statsRunId) statsLoading = false;
  }
}

// A "szokásos"-hoz képesti eltérés csak akkor értelmes, ha a bázis-érték nem
// elhanyagolhatóan kicsi - egy majdnem száraz időszakhoz képest 1 mm is
// "+300%" lenne, ami félrevezető, nem informatív.
function formatUsualDiff(actual, usual) {
  if (!(usual > 0.5)) return null;
  const diff = Math.round(((actual - usual) / usual) * 100);
  if (diff === 0) return "kb. annyi, mint szokott";
  return `${Math.abs(diff)}%-kal ${diff > 0 ? "több" : "kevesebb"}, mint szokott`;
}

// Egy nagy szám a "szokásoshoz képest" sávval: a kitöltés a tényleges érték,
// a függőleges jel a szokásos (3 éves átlag). Ha nincs szokásos érték, vagy
// az elhanyagolható (ld. formatUsualDiff), csak a szám marad.
function statsFigureHtml(label, mm, usualMm) {
  let html = `<span class="stats-figure-value">${formatMm(mm)}<small> mm</small></span>` +
    `<span class="stats-figure-label">${label}</span>`;
  if (typeof usualMm === "number" && usualMm > 0.5) {
    const top = Math.max(mm, usualMm, 0.1);
    const diff = formatUsualDiff(mm, usualMm);
    html += `<span class="stats-usual" role="img" aria-label="${diff}">` +
      `<span class="stats-usual-fill" style="width:${(mm / top * 100).toFixed(1)}%"></span>` +
      `<span class="stats-usual-mark" style="left:${(usualMm / top * 100).toFixed(1)}%"></span></span>` +
      `<span class="stats-usual-text">szokásos: ${formatMm(usualMm)} mm</span>`;
  }
  return html;
}

function fillPrecipStats(stats, usual, todayIdx) {
  const idx = currentHourIndex(stats);
  const hourly = stats.hourly.precipitation;

  const eventEl = document.getElementById("stats-precip-event");
  const eventStart = idx === -1 ? null : rainEventStartIndex(stats);
  if (eventStart === null) {
    eventEl.hidden = true;
  } else {
    const eventSum = hourly.slice(eventStart, idx + 1).reduce((a, b) => a + b, 0);
    const hours = idx - eventStart + 1;
    eventEl.hidden = false;
    eventEl.textContent = `Ez alatt az esőzés alatt (${hours} órája tart): ${formatMm(eventSum)} mm`;
  }

  const sum24h = idx === -1 ? null : hourly.slice(Math.max(0, idx - 23), idx + 1).reduce((a, b) => a + b, 0);
  const daily = stats.daily.precipitation_sum;
  const sum7d = daily.slice(Math.max(0, todayIdx - 6), todayIdx + 1).reduce((a, b) => a + b, 0);
  const sum30d = daily.slice(Math.max(0, todayIdx - 29), todayIdx + 1).reduce((a, b) => a + b, 0);

  document.getElementById("stats-precip-24h").innerHTML =
    sum24h === null ? "" : statsFigureHtml("24 óra", sum24h, null);
  document.getElementById("stats-precip-7d").innerHTML =
    statsFigureHtml("7 nap", sum7d, usual ? usual.usual7d : null);
  document.getElementById("stats-precip-30d").innerHTML =
    statsFigureHtml("30 nap", sum30d, usual ? usual.usual30d : null);
  document.getElementById("stats-precip-note").textContent = usual
    ? `A szokásos érték az elmúlt ${USUAL_PRECIP_YEARS_BACK} év ilyenkori átlaga.`
    : "";

  const from = Math.max(0, todayIdx - 29);
  const dates = stats.daily.time.slice(from, todayIdx + 1);
  const snowDays = (stats.daily.snowfall_sum || []).slice(from, todayIdx + 1).map(v => v > 0);
  renderSparkline(document.getElementById("stats-precip-chart"), dates, daily.slice(from, todayIdx + 1), snowDays);
  document.getElementById("stats-precip-legend").hidden =
    !snowDays.some((isSnow, i) => isSnow && daily[from + i] > 0);
  // Dátumok a tengelyen: az első, a középső és az utolsó nap.
  const axis = document.getElementById("stats-precip-axis");
  axis.innerHTML = dates.length
    ? `<span>${formatStatsDate(dates[0])}</span><span>${formatStatsDate(dates[Math.floor(dates.length / 2)])}</span><span>${formatStatsDate(dates[dates.length - 1])}</span>`
    : "";
}

// Kézzel épített, monokróm mini oszlopdiagram a radar-rajzoláshoz hasonló
// stílusban (createElementNS, külön könyvtár nélkül). A száraz napok is
// kapnak egy halvány alapvonalat, hogy a diagram üresen ne tűnjön hibásnak.
// Minden oszlop kattintható/koppintható (touch screenen is - a "click"
// esemény mindkettőre lefut): megnyitja a buborékot az adott nap dátumával
// és csapadékával. A látható sáv keskeny (0,7*barWidth), ezért egy átlátszó,
// szélesebb körvonal adja a tényleges koppintási célterületet - ugyanaz a
// trükk, mint a radar-pöttyök "stroke: transparent; stroke-width" megoldása.
function renderSparkline(svgEl, dates, values, snow = []) {
  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
  hideSparklineTooltip();
  const svgNS = "http://www.w3.org/2000/svg";
  const max = Math.max(...values, 1);
  const barWidth = 300 / values.length;
  values.forEach((v, i) => {
    const h = Math.max((v / max) * 40, 1);
    const rect = document.createElementNS(svgNS, "rect");
    rect.setAttribute("x", i * barWidth + barWidth * 0.15);
    rect.setAttribute("y", 40 - h);
    rect.setAttribute("width", Math.max(barWidth * 0.7, 1));
    rect.setAttribute("height", h);
    if (snow[i] && v > 0) {
      // Havazásos nap: ugyanaz a sraffozás, mint a 12 órás kártyán (#snow-hatch).
      rect.setAttribute("fill", "url(#snow-hatch)");
      rect.style.stroke = "var(--accent)";
      rect.setAttribute("stroke-width", 1);
      rect.setAttribute("vector-effect", "non-scaling-stroke");
    } else {
      rect.setAttribute("fill", "var(--accent)");
      rect.setAttribute("opacity", v > 0 ? 0.85 : 0.15);
    }
    rect.classList.add("stats-bar");
    rect.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleSparklineTooltip(i, dates[i], v, values.length, snow[i] && v > 0);
    });
    svgEl.appendChild(rect);
  });
}

function formatStatsDate(dateIso) {
  return new Date(dateIso + "T00:00:00").toLocaleDateString("hu-HU", { month: "short", day: "numeric" });
}

let openTooltipBarIndex = null;

function toggleSparklineTooltip(index, dateIso, mm, barCount, isSnow = false) {
  if (openTooltipBarIndex === index) {
    hideSparklineTooltip();
    return;
  }
  hideSparklineTooltip();
  openTooltipBarIndex = index;
  const bars = document.getElementById("stats-precip-chart").querySelectorAll(".stats-bar");
  if (bars[index]) bars[index].classList.add("stats-bar-active");
  const tooltip = document.getElementById("stats-precip-tooltip");
  const leftPercent = ((index + 0.5) / barCount) * 100;
  tooltip.textContent = `${formatStatsDate(dateIso)}: ${formatMm(mm)} mm${isSnow ? " (hó)" : ""}`;
  tooltip.style.left = `${leftPercent}%`;
  tooltip.hidden = false;
}

function hideSparklineTooltip() {
  openTooltipBarIndex = null;
  const chart = document.getElementById("stats-precip-chart");
  if (chart) chart.querySelectorAll(".stats-bar-active").forEach(el => el.classList.remove("stats-bar-active"));
  const tooltip = document.getElementById("stats-precip-tooltip");
  if (tooltip) tooltip.hidden = true;
}

// Bárhova máshova kattintva (nem egy oszlopra) a buborék eltűnik - az
// oszlopok saját click-figyelője stopPropagation-nel előzi meg, hogy rögtön
// visszazáródjon, amikor épp megnyitjuk.
document.addEventListener("click", hideSparklineTooltip);

const FORECAST_DAY_LABELS = ["Ma", "Holnap", "Holnapután"];
const HU_WEEKDAYS = ["vasárnap", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat"];

function fillForecastStats(stats, todayIdx) {
  const list = document.getElementById("stats-forecast-days");
  list.innerHTML = "";
  let anySnow = false;
  for (let offset = 0; offset <= 3; offset++) {
    const dayIdx = todayIdx + offset;
    if (dayIdx >= stats.daily.time.length) break;
    const label = FORECAST_DAY_LABELS[offset] ||
      HU_WEEKDAYS[new Date(stats.daily.time[dayIdx]).getUTCDay()];
    const prob = stats.daily.precipitation_probability_max[dayIdx];
    const sum = stats.daily.precipitation_sum[dayIdx];
    const hasProb = typeof prob === "number";
    const snow = stats.daily.snowfall_sum?.[dayIdx] > 0;
    const rain = stats.daily.rain_sum?.[dayIdx] > 0;
    const icy = FREEZING_RAIN_CODES.includes(stats.daily.weather_code?.[dayIdx]);
    const kindLabel = icy ? "ónos eső" : snow && rain ? "eső és hó" : "";
    if (snow) anySnow = true;
    const li = document.createElement("li");
    li.innerHTML =
      `<span class="stats-day-name">${label}</span>` +
      `<span class="stats-day-bar" role="img" aria-label="${hasProb ? `${Math.round(prob)}% eséllyel` : "az esély nem ismert"}">` +
      (hasProb ? `<i${snow ? ` class="stats-hatch"` : ""} style="height:${Math.max(0, Math.min(100, prob))}%"></i>` : "") + `</span>` +
      `<span class="stats-day-prob">${hasProb ? `${Math.round(prob)}%` : "?"}</span>` +
      `<span class="stats-day-mm">kb. ${formatMm(sum)} mm</span>` +
      (kindLabel ? `<span class="stats-day-kind">${kindLabel}</span>` : "");
    list.appendChild(li);
  }
  document.getElementById("stats-forecast-legend").hidden = !anySnow;
}

// Mai és holnapi min-max egy közös hőmérséklet-skálán, a fagypont
// (0 °C) jelölt vonalával. Az SVG szövegei 1 egység = ~1 képpont méretűek
// (a kártya kb. 300 px széles), ezért a betűméret nem torzul.
function renderTempBars(container, rows) {
  const valid = rows.filter(r => typeof r.min === "number" && typeof r.max === "number");
  if (!valid.length) {
    container.innerHTML = "";
    return;
  }
  const lo = Math.min(...valid.map(r => r.min)), hi = Math.max(...valid.map(r => r.max));
  const showZero = lo <= 1 && hi >= -1;
  const scaleLo = (showZero ? Math.min(lo, 0) : lo) - 1;
  const scaleMax = (showZero ? Math.max(hi, 0) : hi) + 1;
  const trackX0 = 62, trackX1 = 238, W = 300, rowH = 30, topPad = 14;
  const H = topPad + valid.length * rowH + 4;
  const xFor = t => trackX0 + ((t - scaleLo) / (scaleMax - scaleLo)) * (trackX1 - trackX0);
  let body = "";
  valid.forEach((r, i) => {
    const y = topPad + i * rowH + rowH / 2;
    const x0 = xFor(r.min), x1 = Math.max(xFor(r.max), x0 + 2);
    body += `<text class="stats-svg-text" x="0" y="${(y + 4).toFixed(1)}">${r.label}</text>` +
      `<line x1="${trackX0}" y1="${y}" x2="${trackX1}" y2="${y}" stroke="var(--border)" stroke-width="1"></line>` +
      `<rect x="${x0.toFixed(1)}" y="${y - 4}" width="${(x1 - x0).toFixed(1)}" height="8" fill="var(--accent)"></rect>` +
      `<text class="stats-svg-text stats-svg-text-strong" x="${(x0 - 5).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="end">${formatC(r.min)}°</text>` +
      `<text class="stats-svg-text stats-svg-text-strong" x="${(x1 + 5).toFixed(1)}" y="${(y + 4).toFixed(1)}">${formatC(r.max)}°</text>`;
  });
  let zero = "";
  if (showZero) {
    const zx = xFor(0);
    zero = `<line x1="${zx.toFixed(1)}" y1="${topPad - 4}" x2="${zx.toFixed(1)}" y2="${H - 2}" stroke="var(--fg)" stroke-width="1" stroke-dasharray="2 2"></line>` +
      `<text class="stats-svg-text" x="${zx.toFixed(1)}" y="9" text-anchor="middle">0° fagypont</text>`;
  }
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${valid.map(r => `${r.label}: ${formatC(r.min)} és ${formatC(r.max)} °C között`).join(", ")}">${zero}${body}</svg>`;
}

function fillTempStats(stats, todayIdx) {
  document.getElementById("stats-temp-now").textContent =
    `${formatC(stats.current.temperature_2m)} °C`;

  const todayMin = stats.daily.temperature_2m_min[todayIdx];
  const todayMax = stats.daily.temperature_2m_max[todayIdx];
  const tomorrowIdx = todayIdx + 1;
  const tomorrowMin = stats.daily.temperature_2m_min[tomorrowIdx];
  const tomorrowMax = stats.daily.temperature_2m_max[tomorrowIdx];
  renderTempBars(document.getElementById("stats-temp-bars"), [
    { label: "Ma", min: todayMin, max: todayMax },
    { label: "Holnap", min: tomorrowMin, max: tomorrowMax },
  ]);

  const frostToday = todayMin <= 0;
  const frostTomorrow = tomorrowMin !== undefined && tomorrowMin <= 0;
  const snowingNow = stats.current.snowfall > 0;
  const snowSoon = (stats.daily.snowfall_sum[todayIdx] > 0) ||
    (stats.daily.snowfall_sum[tomorrowIdx] > 0);

  const frostEl = document.getElementById("stats-temp-frost");
  const notes = [];
  if (snowingNow) notes.push("most havazik");
  else if (snowSoon) notes.push("havazás várható");
  if (frostToday && frostTomorrow) notes.push("fagyveszély ma és holnap éjjel is");
  else if (frostToday) notes.push("fagyveszély ma éjjel");
  else if (frostTomorrow) notes.push("fagyveszély holnap éjjel");
  frostEl.hidden = notes.length === 0;
  frostEl.textContent = notes.join(", ");
}

// "Következő 12 óra": a keresett hely órás csapadéka kis oszlopdiagramon, a
// jelenlegi órától kezdve (a fetchUserStats már lekért órás csapadékot,
// esélyt és havat, külön kérés nem kell). Az oszlop fölött az mm, alatta az
// óra (háromóránként) és az esély; a havazásos órák sraffozott, körvonalas
// oszlopot kapnak (a hó vízegyenértéke ugyanabban a precipitation mezőben van,
// a snowfall csak a típust adja). Ha mindegyik nulla, egy mondat és a lapos
// diagram áll.
const NEXT_HOURS = 12;

function fillNext12hStats(stats) {
  const lineEl = document.getElementById("stats-next12-line");
  const chartEl = document.getElementById("stats-next12-chart");
  const legendEl = document.getElementById("stats-next12-legend");
  const idx = currentHourIndex(stats);
  if (idx === -1) {
    lineEl.hidden = true;
    legendEl.hidden = true;
    chartEl.innerHTML = "";
    return;
  }
  const hours = [];
  for (let i = idx; i < idx + NEXT_HOURS && i < stats.hourly.time.length; i++) {
    const prob = stats.hourly.precipitation_probability?.[i];
    hours.push({
      label: i === idx ? "most" : stats.hourly.time[i].slice(11, 16),
      mm: stats.hourly.precipitation[i] || 0,
      prob: typeof prob === "number" ? Math.round(prob) : null,
      snow: stats.hourly.snowfall?.[i] > 0,
    });
  }
  const wet = hours.filter(h => h.mm >= RAIN_THRESHOLD_MM);
  lineEl.hidden = wet.length > 0;
  lineEl.textContent = wet.length ? "" : `A következő ${NEXT_HOURS} órában nem várható csapadék.`;
  legendEl.hidden = !hours.some(h => h.snow && h.mm >= RAIN_THRESHOLD_MM);
  renderNext12hChart(chartEl, hours);
}

function renderNext12hChart(container, hours) {
  const W = 300, baseY = 60, plotH = 44;
  const pitch = W / hours.length;
  const max = Math.max(...hours.map(h => h.mm), 1);
  let body = `<line x1="0" y1="${baseY + 0.5}" x2="${W}" y2="${baseY + 0.5}" stroke="var(--border)" stroke-width="1"></line>`;
  hours.forEach((h, i) => {
    const wet = h.mm >= RAIN_THRESHOLD_MM;
    const bh = wet ? Math.max((h.mm / max) * plotH, 2) : 1;
    const x = i * pitch + pitch * 0.15, w = pitch * 0.7, cx = i * pitch + pitch / 2;
    if (wet && h.snow) {
      body += `<rect x="${x.toFixed(1)}" y="${(baseY - bh).toFixed(1)}" width="${w.toFixed(1)}" height="${bh.toFixed(1)}" fill="url(#snow-hatch)" stroke="var(--accent)" stroke-width="1"></rect>`;
    } else {
      body += `<rect x="${x.toFixed(1)}" y="${(baseY - bh).toFixed(1)}" width="${w.toFixed(1)}" height="${bh.toFixed(1)}" fill="var(--accent)" opacity="${wet ? 0.9 : 0.15}"></rect>`;
    }
    if (wet) {
      body += `<text class="stats-svg-text stats-svg-text-strong stats-next12-mm" x="${cx.toFixed(1)}" y="${(baseY - bh - 3).toFixed(1)}" text-anchor="middle">${formatMm(h.mm)}</text>`;
      if (h.prob !== null) {
        body += `<text class="stats-svg-text stats-next12-prob" x="${cx.toFixed(1)}" y="${baseY + 25}" text-anchor="middle">${h.prob}%</text>`;
      }
    }
    if (i % 3 === 0) {
      body += `<text class="stats-svg-text" x="${(i === 0 ? x : cx).toFixed(1)}" y="${baseY + 13}" text-anchor="${i === 0 ? "start" : "middle"}">${h.label}</text>`;
    }
  });
  const desc = hours.map(h => `${h.label}: ${h.mm >= RAIN_THRESHOLD_MM ? `${formatMm(h.mm)} mm${h.snow ? " hó" : ""}${h.prob !== null ? `, ${h.prob}% esély` : ""}` : "száraz"}`).join("; ");
  container.innerHTML = `<svg viewBox="0 0 ${W} ${baseY + 29}" role="img" aria-label="Csapadék a következő ${NEXT_HOURS} órában. ${desc}">${body}</svg>`;
}

// ---- UI-vezérlés ----

// Telepített (standalone) módban nincs böngésző-frissítés gomb, ezért amíg az
// app látható és van kiválasztott helyszín, magunktól frissítünk. Háttérben
// (nem látható lapon) nem, hogy ne fogyjon feleslegesen az akkumulátor.
//
// Az ütem szándékosan 5 perc, nem 1: az Open-Meteo napi és órás kvótája
// pontban méri a használatot (lásd SEARCH_RINGS), és a percenkénti frissítés
// egy nyitva hagyott lapon egymagában felélte volna az órás keret felét.
// Időjáráshoz 5 perc bőven elég sűrű.
const AUTO_REFRESH_MS = 5 * 60 * 1000;
let currentLoc = null;

function runAndTrack(loc) {
  currentLoc = loc;
  run(loc);
}

function shouldAutoRefresh() {
  return (
    currentLoc &&
    document.visibilityState === "visible" &&
    !document.getElementById("result").hidden
  );
}

setInterval(() => {
  if (shouldAutoRefresh()) run(currentLoc, { silent: true });
}, AUTO_REFRESH_MS);

document.addEventListener("visibilitychange", () => {
  if (shouldAutoRefresh()) run(currentLoc, { silent: true });
});

// ---- A keresés koreográfiája ----
//
// A keresés két kérdésre válaszol, egymás után, és a radar mindkettő után
// lejjebb csúszik egy lépéssel. A #result data-phase attribútuma mondja meg,
// mi látszik éppen; a többit a CSS intézi.
//
// PHASE_LOCAL ("esik-e a környéken?"): csak a kérdés és a radar látszik.
//   A válasz és a második blokk ilyenkor a LAYOUTBAN SINCS benne, így a radar
//   a keresés teljes ideje alatt egy helyben marad. (Korábban itt volt egy
//   hiba: a válaszblokk már keresés közben helyet foglalt, és lelökte.)
// PHASE_WHERE ("de hol esik pontosan?"): az első válasz és a második kérdés
//   már látszik, a második válasz még nem. A radar egy lépéssel lejjebb
//   csúszott, és alatta folytatódik a keresés.
// PHASE_DONE: minden látszik, a radar a végleges helyén marad.
//
// Az első válasz ("Igen"/"Nem") nem várakozik külön: mire idáig érünk, a
// pásztázó vonal már körbeért egyszer, hiszen a pontokat pont ő festette fel
// (radarRevealTier egy teljes fordulat alatt végez). Ez önmagában elég idő a
// kör leolvasásához. A VÉGSŐ válasz előtt is csak egy rövid szünet van: a
// pontok addigra mind kint vannak, és a helynév-lekérés is a felfestéssel
// párhuzamosan futott, tehát a radar nem pörög üresen a kész kép fölött.
const PHASE_LOCAL = "local";
const PHASE_WHERE = "where";
const PHASE_DONE = "done";
const REVEAL_DELAY_MS = 1200;
const REVEAL_SLIDE_MS = 600;
let revealTimer = null;
let revealResolve = null;

// A függőben lévő felfedés-ígéretet fel KELL oldani, amikor megszakítjuk,
// különben az await-elő run() örökre ott áll, a finally sosem fut le, és
// onnantól minden további keresés némán kimarad (az app újratöltésig halott).
function cancelReveal() {
  clearTimeout(revealTimer);
  revealTimer = null;
  if (revealResolve) {
    revealResolve();
    revealResolve = null;
  }
}

// A statisztika-panel az előző keresés eredményéhez tartozott: új keresés
// (új helyszín, vagy ugyanannak újraindítása) kezdetén el kell rejteni és be
// kell csukni, különben a radar alatt egy másik hely elavult adatai
// lógnának, amíg az új válasz meg nem érkezik.
function resetStatsPanel() {
  const panel = document.getElementById("stats-panel");
  panel.hidden = true;
  statsRunId++; // a még úton lévő válasz elavult
  hideSparklineTooltip();
}

function beginSearchUI() {
  cancelReveal();
  const loading = document.getElementById("loading");
  document.getElementById("result").dataset.phase = PHASE_LOCAL;
  document.getElementById("loading-text").textContent = "töltés…";
  loading.classList.remove("settled", "locating");
  loading.hidden = false;
  loading.style.transition = "none";
  loading.style.transform = "";
  positionRadar(false);
  resetStatsPanel();
  resetWaterPanel();
  radarReset();
  radarRestartSweep();
  document.getElementById("radar-image").removeAttribute("href");
  loadBorders();     // lusta betöltés, a választ sosem várakoztatja
  loadWaterGeo();    // ugyanúgy lusta, ugyanúgy nem várakoztat
  loadPlaces();      // a radar városfeliratai, ugyanígy
  // A radarkép 10 percenként frissül, ezért keresésenként újrakérjük a
  // katalógust. Ha nem jön meg, a radar egyszerűen kép nélkül működik tovább.
  radarFrameLoading = null;
  loadRadarFrame();
}

// Vár a megadott ideig, majd átlép a megadott fázisba. A hívó await-elheti,
// hogy a keresés következő szakasza csak a lecsúszás után induljon el.
function revealPhase(phase, delayMs) {
  cancelReveal();
  return new Promise(resolve => {
    revealResolve = resolve;
    revealTimer = setTimeout(() => {
      revealTimer = null;
      revealResolve = null;
      slideRadar(() => {
        document.getElementById("result").dataset.phase = phase;
        if (phase === PHASE_DONE) document.getElementById("loading").classList.add("settled");
      });
      if (phase === PHASE_DONE) {
        // A nagyítás alapsugara a végleges kép sugara.
        radarBaseRadiusKm = radarMaxRadiusKm;
        radarZoomLevel = 0;
        updateRadarScale();
        updateRadarZoomButtons();
        // Az alaptérkép a keresés eleje óta látszik; ez csak akkor rajzol újra,
        // ha a sugár időközben változott.
        radarDrawBase();
        // A statisztika-panel is csak most, hogy a radar véglegesen betöltött:
        // megjelenik (mindig látható, nincs nyitógomb), és ekkor tölt be.
        document.getElementById("stats-panel").hidden = false;
        const statsDone = currentLoc ? buildStatsPanel(currentLoc) : null;
        // A vízadat-panel viszont NEM gombra nyílik: a radar után rögtön
        // megjelenik, nyitva, mert a felhasználó szerint ez folytatja az
        // oldalt, nem egy elrejtendő mellékes részlet.
        // Csak magyarországi helyszínnél: minden adata (hydroinfo.hu mércék,
        // országos vízmérleg, Balaton) Magyarországra vonatkozik, külföldi
        // helynél félrevezető lenne. Ismeretlen országkódnál sem jelenik meg
        // (a run() addigra már megpróbálta pótolni reverse geocodinggal).
        if (currentLoc && currentLoc.countryCode === "HU") {
          document.getElementById("water-panel").hidden = false;
          // A lusta betöltő csak azután figyeli a panelt, hogy a statisztika-panel
          // felépült (vagy 6 mp eltelt): addig a panel még a képernyő közelében
          // lenne, és a statisztika kinövése csak utána tolná lejjebb.
          const waitStats = Promise.race([
            Promise.resolve(statsDone).catch(() => {}),
            new Promise(r => setTimeout(r, 6000)),
          ]);
          const token = waterBuildToken;
          const point = currentLoc;
          waitStats.then(() => { if (token === waterBuildToken) requestWaterPanel(point); });
        }
      }
      resolve();
    }, delayMs);
  });
}

function scheduleReveal() {
  revealPhase(PHASE_DONE, REVEAL_DELAY_MS);
}

// A radar layout-doboza (#loading) a keresés elejétől a VÉGLEGES helyén áll:
// a válasz-blokkok helyét a CSS lefoglalja (visibility: hidden), a padding
// sem változik. A korábbi "lejjebb, középen" megjelenést (local: a kérdés
// alatt 8rem, where: a második kérdés alatt) egy translateY adja vissza a
// #loading-on, amit a fázisváltás 0-ra animál. Korábban a layout maga ugrott
// (válasz-szöveg a radar fölött, padding-top 8rem -> --sp-3), és a slideRadar
// FLIP-je csak a festést simította el; a Layout Instability API viszont a
// layout-dobozt nézi (a transformot nem), ezért a CLS ~0,15 maradt. Most a
// layout nem mozdul, csak a transform: a metrika is, a szem is nyugodt.
//
// A kívánt eltolást nem becsüljük: a html.radar-old-layout osztállyal egy
// pillanatra (festés nélkül, ugyanabban a feladatban) visszakapcsoljuk a
// régi elrendezést, megmérjük a radar helyét, majd a mostanit, és a kettő
// különbsége a translateY. Így a régi megjelenés pixelre ugyanaz marad,
// bármilyen hosszú a szöveg.
let radarPositionPhase = null;

function radarLayoutTop(loading) {
  const ty = new DOMMatrix(getComputedStyle(loading).transform).m42;
  // A radar-svg tetejét mérjük (nem a #loading-ét): a régi és az új
  // elrendezés a padding-top-ban is eltér. Helymeghatározás közben még nincs
  // radar (display: none), ott a töltésjelző szöveg a mérőpont.
  const el = document.getElementById(loading.classList.contains("locating") ? "loading-text" : "radar-svg");
  return el.getBoundingClientRect().top - ty;
}

function radarOffsetPx() {
  const loading = document.getElementById("loading");
  const phase = document.getElementById("result").dataset.phase;
  const locating = loading.classList.contains("locating");
  if (!locating && (phase === PHASE_DONE || loading.classList.contains("settled"))) return 0;
  const now = radarLayoutTop(loading);
  document.documentElement.classList.add("radar-old-layout");
  const old = radarLayoutTop(loading);
  document.documentElement.classList.remove("radar-old-layout");
  return old - now;
}

// animate = true: a REVEAL_SLIDE_MS-es csúszás az új eltolásra (a CSS
// transition az éppen látható állásból indul, megszakított animációnál is).
function positionRadar(animate) {
  const loading = document.getElementById("loading");
  if (loading.hidden) return;
  const ty = radarOffsetPx();
  loading.style.transition = animate ? `transform ${REVEAL_SLIDE_MS}ms ease` : "none";
  loading.style.transform = ty ? `translateY(${ty}px)` : "";
}

// A fázisváltás utáni csúszás. A layout-változást (a data-phase átállítását)
// a hívó adja; a radar innen már csak a transformjával mozdul.
function slideRadar(applyLayoutChange) {
  applyLayoutChange();
  positionRadar(true);
}

// Ha a lefoglalt blokkok magassága a keresés közben változik (a tartalom
// hosszabb a foglalásnál, forgatás, átméretezés), a radar vizuális helye ne
// csússzon el: újramérjük, animáció nélkül. A végső fázisban nincs eltolás.
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => {
    if (document.getElementById("result").dataset.phase !== PHASE_DONE) positionRadar(false);
  }).observe(document.getElementById("result"));
}

// Csak a helymeghatározás fázisához kell: radar nélküli, egyszerű szöveges
// töltésjelző, még mielőtt bármit tudnánk arról, hol keressünk.
function showLoading(on, text = "töltés…") {
  const loading = document.getElementById("loading");
  if (!on) {
    loading.hidden = true;
    return;
  }
  cancelReveal();
  loading.classList.remove("settled");
  loading.classList.add("locating");
  document.getElementById("loading-text").textContent = text;
  loading.hidden = false;
  // A #result helye a helymeghatározás alatt is le van foglalva (láthatatlanul),
  // különben a keresés indulásakor a megjelenő fejléc/kérdés/válasz-hely
  // lejjebb lökné a #loading-ot (CLS). A szöveg látható helyét a positionRadar
  // translateY-ja őrzi.
  const result = document.getElementById("result");
  if (result.hidden) {
    result.hidden = false;
    result.classList.add("pending");
  }
  positionRadar(false);
}

// Helyszín-módosításkor a lemaradt (settled) radart is el kell tüntetni,
// különben ott lógna a helyszín-kereső form alatt. FONTOS: NEM hívja a
// cancelReveal()-t és NEM nulláz a statisztika-/vízadat-panelt (ahogy
// korábban tette) - azt a TÉNYLEGES új keresés kezdete (beginSearchUI) már
// amúgy is elvégzi. Ha itt megszakítanánk egy még folyamatban lévő
// revealPhase(PHASE_DONE)-t, a hozzá tartozó buildWaterPanel hívás NÉMÁN
// elveszne - ez csak akkor derült ki, amikor a "Mégse" (UX-audit U04) a
// korábbi eredményhez térhet vissza anélkül, hogy új keresés indulna, és
// ami emiatt soha nem épülne újra. A #loading elrejtése önmagában elég a
// "ne lógjon a form alatt" célhoz - a radar ÉPPEN emiatt (hidden) nem
// villan fel újra, a benne futó setTimeout-nak viszont hagyni kell lefutni.
function hideLoadingImmediately() {
  const loading = document.getElementById("loading");
  loading.hidden = true;
  loading.classList.remove("settled", "locating");
}

function showError(msg) {
  const el = document.getElementById("location-error");
  // Előbb látszódjon, utána kapjon szöveget: a role="alert" régiót csak a
  // MÁR látható elemen történő szövegváltozásra jelzik megbízhatóan a
  // képernyőolvasók, nem a hidden->látható váltásra magára.
  el.hidden = false;
  el.textContent = msg;
  document.getElementById("location-input").setAttribute("aria-invalid", "true");
}

function clearLocationError() {
  const el = document.getElementById("location-error");
  el.hidden = true;
  el.textContent = "";
  document.getElementById("location-input").setAttribute("aria-invalid", "false");
}

function showResult() {
  document.getElementById("location-picker").hidden = true;
  const result = document.getElementById("result");
  result.hidden = false;
  result.classList.remove("pending");
}

function renderRecentLocations() {
  const wrap = document.getElementById("recent-locations");
  const list = document.getElementById("recent-locations-list");
  list.innerHTML = "";
  // A JELENLEGI helyszínt nem ajánljuk fel újra - úgyis az van elöl.
  const items = loadRecentLocations().filter(loc => !currentLoc || loc.name !== currentLoc.name);
  if (!items.length) {
    wrap.hidden = true;
    return;
  }
  for (const loc of items) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = loc.name;
    btn.addEventListener("click", () => {
      clearLocationError();
      saveLocation(loc);
      showResult();
      runAndTrack(loc);
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
  wrap.hidden = false;
}

function showPicker() {
  document.getElementById("result").classList.remove("pending");
  document.getElementById("result").hidden = true;
  document.getElementById("location-picker").hidden = false;
  hideLoadingImmediately();
  renderRecentLocations();
}

// Automatikus helymeghatározás: ez az alapértelmezett út. Ha a felhasználó
// megtagadja vagy nem támogatott, a kézi keresőre esünk vissza.
async function tryAutoLocate() {
  showLoading(true, "helymeghatározás…");
  try {
    const coords = await detectLocation();
    let place = { name: null, countryCode: null, countryName: null };
    try {
      place = await reverseGeocode(coords.lat, coords.lon);
    } catch (err) {
      console.error(err);
    }
    const loc = {
      name: place.name || "a jelenlegi helyzeted",
      lat: coords.lat,
      lon: coords.lon,
      countryCode: place.countryCode,
    };
    saveLocation(loc);
    showLoading(false);
    showResult();
    runAndTrack(loc);
  } catch (err) {
    console.error(err);
    // Ha a böngésző helymeghatározása nem elérhető/engedélyezett, ne
    // kényszerítsük a felhasználót azonnal kézi keresésre - Budapest
    // ésszerű alapértelmezett, azonnali választ ad, a "másik hely"
    // (#change-location) linkkel bármikor átválthat a kézi keresőre.
    // Szándékosan NEM mentjük el mentett helyként (saveLocation) - legközelebb
    // újra megpróbálja az automatikus helymeghatározást, nem ragad be
    // Budapestnél, ha az csak egyszeri hiba volt.
    showLoading(false);
    const loc = { name: "Budapest", lat: 47.4979, lon: 19.0402, countryCode: "HU" };
    showResult();
    runAndTrack(loc);
  }
}

document.getElementById("location-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("location-input");
  clearLocationError();

  let loc;
  try {
    loc = await geocode(input.value.trim());
  } catch (err) {
    console.error(err);
    showError("Nem sikerült elérni a helykereső szolgáltatást. Próbáld újra.");
    return;
  }
  if (!loc) {
    showError("Nem találtunk ilyen települést, próbáld pontosabban.");
    return;
  }
  saveLocation(loc);
  showResult();
  runAndTrack(loc);
});

// ---- Push-értesítés ----

const VAPID_PUBLIC_KEY = "BFDUfuycSz_U5WPPqthX4BsMFh_knI7mkH8DDz9R3BAhMtESzx-SxD_H_kmMST46v388RUMSGQjgc80vbgJ4Ryc";
const PUSH_WORKER_URL = "https://holazeso-push-worker.kovizozi.workers.dev";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

function updateNotifyButton() {
  const btn = document.getElementById("notify-toggle");
  const enabled = localStorage.getItem("holazeso_notify_enabled") === "1";
  const label = enabled ? "értesítés kikapcsolása" : "értesíts, ha esni kezd";
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.setAttribute("aria-pressed", enabled ? "true" : "false");
  btn.classList.toggle("icon-btn-on", enabled);
}

async function enableNotifications(userLoc) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    alert("A böngésződ nem támogatja az értesítéseket.");
    return;
  }
  // UX-audit U05: korábban egy nem "granted" engedély-válasz (megtagadva
  // vagy csak bezárva, választás nélkül) teljesen csendben tért vissza - a
  // gomb szövege nem változott, semmi nem jelezte, mi történt (vagy nem
  // történt). Minden kimenetnek legyen látható visszajelzése.
  const btn = document.getElementById("notify-toggle");
  const prevText = btn.textContent;
  btn.textContent = "engedély kérése…";
  let permission;
  try {
    permission = await Notification.requestPermission();
  } finally {
    btn.textContent = prevText;
  }
  if (permission === "denied") {
    alert("Az értesítések ebben a böngészőben nem engedélyezhetők.");
    return;
  }
  if (permission !== "granted") {
    alert("Az értesítések bekapcsolásához engedélyezned kell a böngésző kérését.");
    return;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    await fetch(PUSH_WORKER_URL + "/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: subscription.toJSON(),
        lat: userLoc.lat,
        lon: userLoc.lon,
        name: userLoc.name,
      }),
    });

    localStorage.setItem("holazeso_notify_enabled", "1");
  } catch (err) {
    console.error(err);
    alert("Nem sikerült bekapcsolni az értesítéseket. Próbáld újra.");
  }
  updateNotifyButton();
}

async function disableNotifications() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await fetch(PUSH_WORKER_URL + "/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      await subscription.unsubscribe();
    }
  } catch (err) {
    console.error(err);
  }
  localStorage.removeItem("holazeso_notify_enabled");
  updateNotifyButton();
}

document.getElementById("notify-toggle").addEventListener("click", async () => {
  const enabled = localStorage.getItem("holazeso_notify_enabled") === "1";
  if (enabled) {
    await disableNotifications();
    return;
  }
  const loc = currentLoc || loadSavedLocation();
  if (!loc) {
    alert("Előbb válassz egy helyszínt.");
    return;
  }
  await enableNotifications(loc);
});

document.getElementById("change-location").addEventListener("click", () => {
  showPicker();
});

// A megosztott link: ha a hely 3 km-en belül egy listás település (places-hu.json),
// a generált, indexelhető /eso/<slug>/ oldalt adjuk, különben a ?lat=&lon=&name= linket.
const SHARE_TOWN_RADIUS_KM = 3;

async function buildShareUrl(loc) {
  await loadPlaces();
  let best = null, bestDist = SHARE_TOWN_RADIUS_KM;
  for (const p of placesList) {
    if (!p.slug) continue;
    const d = distanceKm(loc.lat, loc.lon, p.lat, p.lon);
    if (d <= bestDist) { bestDist = d; best = p; }
  }
  if (best) return `${location.origin}/eso/${best.slug}/`;
  const params = new URLSearchParams({
    lat: loc.lat.toFixed(5),
    lon: loc.lon.toFixed(5),
    name: loc.name,
  });
  if (loc.countryCode) params.set("cc", loc.countryCode);
  return `${location.origin}/?${params.toString()}`;
}

document.getElementById("share-location").addEventListener("click", async () => {
  if (!currentLoc) return;
  const url = await buildShareUrl(currentLoc);
  const confirmEl = document.getElementById("share-confirm");
  try {
    await navigator.clipboard.writeText(url);
    confirmEl.textContent = "link másolva";
  } catch (err) {
    console.error(err);
    alert(`Nem sikerült a vágólapra másolni, másold ki kézzel: ${url}`);
  }
  setTimeout(() => { confirmEl.textContent = ""; }, 3000);
});

// A water-panel már nem <details>, nincs toggle esemény: megjelenését és
// feltöltését a revealPhase(PHASE_DONE) ág intézi.

document.getElementById("retry-geo").addEventListener("click", () => {
  clearLocationError();
  tryAutoLocate();
});

// Mégse/Escape: a #location-picker EGYETLEN megnyitási útja a #change-location
// gomb (ld. showPicker hívásai), tehát mindig van érvényes korábbi eredmény,
// amihez vissza lehet térni - nem kell külön esetet kezelni "nincs korábbi
// eredmény" helyzetre.
function cancelLocationPicker() {
  clearLocationError();
  showResult();
  document.getElementById("change-location").focus();
}
document.getElementById("cancel-location").addEventListener("click", cancelLocationPicker);
document.getElementById("location-picker").addEventListener("keydown", (e) => {
  if (e.key === "Escape") cancelLocationPicker();
});

// ============================================================================
// Vízadat-panel lusta betöltése
//
// A panel kódja (folyók, tavak, talaj, csatornák, Cigánd, ~60% a régi
// script.js-ből) a /water.js-ben van, ami KLASSZIKUS script: a script.js
// legfelső szintű const/let/function nevei közvetlenül láthatók benne (közös
// globális lexikális környezet), ezért nincs külön névtér. A water.js csak
// akkor töltődik be (és a vízadat-pillanatképek csak akkor kérődnek le), ha a
// #water-panel 600 px-en belülre ér a látható területhez, vagy ha egy
// tartalomjegyzék-link / #water-... hash kéri. Kereséskor a panel azonnal
// megjelenik (a helyfoglaló vázzal), a kód viszont csak később jön.
// ============================================================================

const WATER_JS_URL = "/water.js?v=3";
// A generált oldalakon (/eso/<slug>/, /ho/) a panel markupja nincs a HTML-ben
// (üres #water-panel[data-fragment]): a generátor egyszer, ebbe a fájlba írja
// az index.html sablonból. A főoldalon inline marad. A ?v= együtt emelendő a
// fragment tartalmának változásakor (CLAUDE.md 3. szabály).
const WATER_PANEL_URL = "/water-panel.html?v=2";
let waterFragmentLoading = null;
let waterJsLoading = null;
let waterPendingPoint = null;
let waterLazyObserver = null;
let waterBuildToken = 0;

function loadWaterJs() {
  if (waterJsLoading) return waterJsLoading;
  waterJsLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = WATER_JS_URL;
    s.onload = resolve;
    s.onerror = () => { waterJsLoading = null; reject(new Error("water.js nem töltődött be")); };
    document.head.appendChild(s);
  });
  return waterJsLoading;
}

// Üres panelnél (generált oldalak) betölti és beszúrja a markupot; különben nem csinál semmit.
function ensureWaterFragment() {
  const panel = document.getElementById("water-panel");
  if (!panel.hasAttribute("data-fragment") || panel.firstElementChild) return Promise.resolve();
  if (waterFragmentLoading) return waterFragmentLoading;
  waterFragmentLoading = fetch(WATER_PANEL_URL)
    .then(r => { if (!r.ok) throw new Error("water-panel.html: " + r.status); return r.text(); })
    .then(html => { panel.innerHTML = html; })
    .catch(err => { waterFragmentLoading = null; throw err; });
  return waterFragmentLoading;
}

function waterHashWanted() {
  return /^#water-/.test(location.hash);
}

// A keresés végén hívja a revealPhase: a panel már látható, a felépítés (a
// water.js betöltése és a buildWaterPanel) viszont a panel közelébe érkezésig vár.
function requestWaterPanel(point) {
  waterPendingPoint = point;
  if (waterLazyObserver) waterLazyObserver.disconnect();
  waterLazyObserver = null;
  if (!("IntersectionObserver" in window) || waterHashWanted()) {
    startWaterPanel();
    return;
  }
  waterLazyObserver = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) startWaterPanel();
  }, { rootMargin: "600px 0px" });
  waterLazyObserver.observe(document.getElementById("water-panel"));
}

async function startWaterPanel() {
  if (waterLazyObserver) waterLazyObserver.disconnect();
  waterLazyObserver = null;
  const point = waterPendingPoint;
  if (!point) return;
  waterPendingPoint = null;
  const token = ++waterBuildToken;
  try {
    await ensureWaterFragment();
    await loadWaterJs();
  } catch (err) {
    console.error(err);
    if (token === waterBuildToken) {
      const st = document.getElementById("water-status"), sk = document.getElementById("water-skeleton");
      if (st) st.textContent = "a vízadatok most nem érhetők el";
      if (sk) sk.hidden = true;
    }
    return;
  }
  if (token !== waterBuildToken) return; // közben új keresés indult
  await buildWaterPanel(point);
  if (token === waterBuildToken && waterHashWanted()) {
    const target = document.querySelector(location.hash);
    if (target && !target.hidden) target.scrollIntoView();
  }
}

function resetWaterPanel() {
  waterBuildToken++;
  waterPendingPoint = null;
  if (waterLazyObserver) waterLazyObserver.disconnect();
  waterLazyObserver = null;
  // Ha a water.js még nem töltődött be, a szakaszok eleve rejtettek.
  if (typeof resetWaterPanelNow === "function") resetWaterPanelNow();
  else document.getElementById("water-panel").hidden = true;
}

// Tartalomjegyzék-link vagy hash-váltás: ne várjunk a görgetésre.
document.addEventListener("click", e => {
  if (e.target.closest && e.target.closest('a[href^="#water-"]')) startWaterPanel();
});
window.addEventListener("hashchange", () => { if (waterHashWanted()) startWaterPanel(); });

// ---- Indítás ----

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(err => console.error(err));
}

updateNotifyButton();

// UX-audit "megosztható (település-specifikus) link" (PROGRESS.md, Later
// roadmap): ?lat=&lon=&name=&cc= - ez EXPLICIT felhasználói szándék, a
// mentett/automatikus helynél is előrébb való. Elmentjük (hogy egy
// következő, paraméter nélküli látogatás is ezt találja, mint egy kézi
// keresés után), majd kitakarítjuk az URL-t, hogy egy frissítés ne fusson
// le kétszer ugyanarra.
function parseSharedLocationFromURL() {
  const params = new URLSearchParams(location.search);
  const lat = parseFloat(params.get("lat"));
  const lon = parseFloat(params.get("lon"));
  const name = params.get("name");
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { name, lat, lon, countryCode: params.get("cc") || null };
}

// A generált /eso/<slug>/ oldalak a script.js előtt beállítják a
// window.HOLAZESO_PLACE = {name, lat, lon, countryCode} objektumot. Ez az
// oldal "témája", ezért a mentett és az automatikus helynél is előrébb való,
// de NEM mentjük el (nem írja át a felhasználó saját helyét), és az URL-t sem
// piszkáljuk. A helyszín-váltó (#change-location) ettől függetlenül működik.
// A főoldalon novembertől márciusig kis szöveges link mutat a /ho/ oldalra.
// Kliensoldali dátum-ellenőrzés, hogy a (statikus) főoldal nyáron ne ajánlgassa.
{
  const snowLink = document.getElementById("snow-link");
  const month = new Date().getMonth() + 1; // 1..12
  if (snowLink && !SNOW_MODE && (month >= 11 || month <= 3)) snowLink.hidden = false;
}

const pagePlace = window.HOLAZESO_PLACE;
const sharedLoc = pagePlace ? null : parseSharedLocationFromURL();
if (pagePlace) {
  showResult();
  runAndTrack({ name: pagePlace.name, lat: pagePlace.lat, lon: pagePlace.lon, countryCode: pagePlace.countryCode || "HU" });
} else if (sharedLoc) {
  saveLocation(sharedLoc);
  showResult();
  runAndTrack(sharedLoc);
  history.replaceState(null, "", location.pathname);
} else {
  const saved = loadSavedLocation();
  if (saved) {
    showResult();
    runAndTrack(saved);
  } else {
    tryAutoLocate();
  }
}
