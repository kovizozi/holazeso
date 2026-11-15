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
// Ezt a radarEnsureMinRadius() érvényesíti, MINDEN keresés végén (ld.
// revealPhase PHASE_DONE ága), nem csak egy adott fázisban: nem keresünk
// újra, csak egy tisztán vizuális, radarAddTier hívással kijjebb húzzuk a
// kört.
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

function formatC(celsius) {
  return celsius.toFixed(1).replace(".", ",");
}

// A talajnedvesség (soil_moisture_0_to_1cm, m³/m³) talajtípustól függ, nincs
// egyetlen "helyes" skála - ez egy durva, laikusnak szóló közelítés, nem
// kalibrált érték.
const SOIL_MOISTURE_BANDS = [
  { max: 0.15, label: "száraz" },
  { max: 0.35, label: "nedves" },
  { max: Infinity, label: "vizes" },
];

function soilMoistureLabel(value) {
  return SOIL_MOISTURE_BANDS.find(b => value <= b.max).label;
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
  return openMeteo(`${API_BASE}?latitude=${lats}&longitude=${lons}&current=precipitation`);
}

// forecast_days=2, hogy a "hamarosan" (következő 3 óra) ablak éjfél körül is
// átnyúlhasson a következő napra, ne csak az aktuális nap 23:00-jánál vágja le.
async function fetchUserForecast(point) {
  return openMeteo(
    `${API_BASE}?latitude=${coord(point.lat)}&longitude=${coord(point.lon)}` +
    `&current=precipitation&hourly=precipitation,precipitation_probability` +
    `&forecast_days=2&timezone=auto`
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
    `&daily=precipitation_sum,precipitation_probability_max,temperature_2m_max,temperature_2m_min,snowfall_sum` +
    `&hourly=precipitation,precipitation_probability,soil_moisture_0_to_1cm` +
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

// Folyó-vízhozam (m³/s) a felhasználó helyéhez legközelebbi modellezett
// folyószakaszra. A flood-api rácsa ritka: kisebb patakoknál a legközelebbi
// pont messze lehet, vagy zajszintű (nulla közeli) értéket ad. Ezért a hívó
// félnek külön ellenőriznie kell a visszaadott rács-pont távolságát és a
// vízhozam nagyságát, mielőtt megjelenítené - lásd buildStatsPanel.
const FLOOD_API_BASE = "https://flood-api.open-meteo.com/v1/flood";

async function fetchRiverDischarge(point) {
  return openMeteo(
    `${FLOOD_API_BASE}?latitude=${coord(point.lat)}&longitude=${coord(point.lon)}&daily=river_discharge&forecast_days=2`
  );
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
    .map(({ point, forecast }) => ({ ...point, mm: currentPrecipRate(forecast) }))
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
  return currentPrecipRate(forecast) >= RAIN_THRESHOLD_MM;
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
const BORDERS_URL = "borders.json?v=1";
let borderRings = null;
let bordersLoading = null;
let radarOrigin = null;
let radarMaxRadiusKm = 0;
// A határok (és ugyanígy a folyók/Balaton, ld. radarDrawWaterGeo) csak a
// keresés legvégén, a végleges válasszal együtt jelennek meg: keresés közben
// a radar maradjon tiszta, csak a pontokkal.
let bordersVisible = false;

// Delta-kódolt egészek 0,01 fokos egységekben, gyűrűnként/vonalanként
// halmozva. Ez a felére csökkenti a fájlt a nyers koordinátalistához képest.
// Közös a borders.json és a water-geo.json formátuma, csak a tartalmuk más.
function decodeDeltaRings(encoded) {
  return encoded.map(flat => {
    const ring = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i < flat.length; i += 2) {
      x += flat[i];
      y += flat[i + 1];
      ring.push([x / 100, y / 100]);
    }
    return ring;
  });
}

function loadBorders() {
  if (bordersLoading) return bordersLoading;
  bordersLoading = fetch(BORDERS_URL)
    .then(res => res.json())
    .then(encoded => {
      borderRings = decodeDeltaRings(encoded);
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
// legnagyobb folyó (Duna, Tisza, Dráva) és a Balaton valódi körvonala van,
// Natural Earth 1:50m "rivers_lake_centerlines"/"lakes" adatból. A Fertő-tó
// és a Velencei-tó nem szerepel benne: ezen a felbontáson a Natural Earth nem
// tartja nyilván őket külön tóként (a Tavak-szakasz saját, kézzel rajzolt
// ábrája ettől függetlenül mutatja mindháromat).
const WATER_GEO_URL = "water-geo.json?v=1";
let waterGeo = null;
let waterGeoLoading = null;

function loadWaterGeo() {
  if (waterGeoLoading) return waterGeoLoading;
  waterGeoLoading = fetch(WATER_GEO_URL)
    .then(res => res.json())
    .then(encoded => {
      waterGeo = {
        rivers: decodeDeltaRings(encoded.rivers),
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
  const value = getComputedStyle(document.documentElement).getPropertyValue("--fg").trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (!hex) return [17, 17, 17];
  const n = parseInt(hex[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

async function drawRadarImage() {
  const el = document.getElementById("radar-image");
  el.removeAttribute("href");
  if (!bordersVisible || !radarFrame || !radarOrigin || !radarMaxRadiusKm) return;

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
  if (!bordersVisible) return; // közben új keresés indulhatott

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
  if (!bordersVisible || !borderRings || !radarOrigin || !radarMaxRadiusKm) return;

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
  if (!bordersVisible || !waterGeo || !radarOrigin || !radarMaxRadiusKm) return;

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

function radarReset() {
  document.getElementById("radar-tiers").innerHTML = "";
  radarTierGroups = [];
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
    x: RADAR_CENTER_X + (Number(dot.getAttribute("cx")) - RADAR_CENTER_X) * scale,
    y: RADAR_CENTER_Y + (Number(dot.getAttribute("cy")) - RADAR_CENTER_Y) * scale,
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
  radarOrigin = userLoc;
  radarMaxRadiusKm = maxRadiusKm;
  radarDrawBorders();
  radarDrawWaterGeo();
  drawRadarImage().catch(err => console.error(err));
  radarTierGroups.forEach(tier => {
    tier.scale = tier.maxRadiusKm / maxRadiusKm;
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

// Lásd RADAR_MIN_VISUAL_RADIUS_KM: minden keresés legvégén, mielőtt az
// országhatár/folyók/Balaton megjelenne, ezzel húzzuk ki a kört, ha a
// találat ennél közelebb volt. Üres ponttömbbel hívja a radarAddTier-t: nem
// keresünk újra és nem rajzolunk új esőpöttyöt, csak a léptéket (és vele a
// korábbi köröket) igazítjuk át.
function radarEnsureMinRadius() {
  if (radarMaxRadiusKm > 0 && radarMaxRadiusKm < RADAR_MIN_VISUAL_RADIUS_KM) {
    radarAddTier([], RADAR_MIN_VISUAL_RADIUS_KM, radarOrigin);
  }
}

// Egyetlen esős pötty létrehozása. A mérete és árnyalata az intenzitás-sávot
// követi, és rákoppintva megmutatja a helynevet (lásd showRadarPlace).
function addRainDot(tier, index, mm) {
  const point = tier.points[index];
  if (!point) return;
  const band = intensityBand(mm);
  const { x, y } = radarPolarPoint(point.bearing, point.distance, tier.maxRadiusKm);
  const svgNS = "http://www.w3.org/2000/svg";

  const dot = document.createElementNS(svgNS, "circle");
  dot.classList.add("radar-dot", `rain-${band.key}`);
  dot.setAttribute("cx", x);
  dot.setAttribute("cy", y);
  dot.setAttribute("r", band.dotRadius);
  dot.dataset.lat = point.lat;
  dot.dataset.lon = point.lon;
  tier.el.appendChild(dot);

  const pulse = document.createElementNS(svgNS, "circle");
  pulse.setAttribute("cx", x);
  pulse.setAttribute("cy", y);
  pulse.setAttribute("r", band.dotRadius);
  pulse.classList.add("radar-pulse", "pulsing");
  tier.el.appendChild(pulse);
}

// A rainByIndex egy Map: rácspont indexe -> csapadék mm/órában. Minden pötty
// akkor jelenik meg, amikor a pásztázó vonal az ő irányához ér, tehát a vonal
// "festi fel" őket. Az ígéret egy teljes fordulat után teljesül, akkor is, ha
// ebben a körben nem volt eső: így a vonal láthatóan végigpásztázza a kört,
// mielőtt a keresés kijjebb lép.
function radarRevealTier(rainByIndex, { instant = false } = {}) {
  const tier = radarTierGroups[radarTierGroups.length - 1];
  if (!tier) return Promise.resolve();

  if (instant) {
    rainByIndex.forEach((mm, index) => addRainDot(tier, index, mm));
    return Promise.resolve();
  }

  const sweepAngle = sweepAngleNow();
  rainByIndex.forEach((mm, index) => {
    const point = tier.points[index];
    if (!point) return;
    const degreesAhead = (point.bearing - sweepAngle + 360) % 360;
    setTimeout(() => addRainDot(tier, index, mm), (degreesAhead / 360) * RADAR_SWEEP_MS);
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

    document.getElementById("q1-question").textContent =
      `Esik-e ${userLoc.name} környékén?`;

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
    const firstRain = new Map(firstGrid
      .map((_, i) => i)
      .filter(i => isRainingNow(firstGridForecasts[i]))
      .map(i => [i, currentPrecipRate(firstGridForecasts[i])]));
    let raining = sortRaining(firstGrid, firstGridForecasts);

    // A helynév-lekérést már a felfestés ALATT elindítjuk. Enélkül a radar a
    // kész kép fölött pörögne tovább, amíg a geokódoló válaszol: a pontok
    // mind kint vannak, mégsem történik semmi.
    const rainsAtUser = isRainingNow(userForecast) || isRainingSoon(userForecast);
    let lookup = !rainsAtUser && raining.length > 0 ? startLookup(userLoc, raining[0]) : null;

    await radarRevealTier(firstRain, { instant: silent });
    if (superseded()) return;

    // Ha nálad esik (vagy hamarosan fog), a "de hol esik pontosan?" kérdés
    // értelmetlen: a válasz az, hogy itt. Ilyenkor nincs 2. fázis.
    if (isRainingNow(userForecast)) {
      const mm = currentPrecipRate(userForecast);
      const band = intensityBand(mm);
      const duration = rainDurationHours(userForecast);
      const lines = [`${band.adv}, ${formatMm(mm)} mm/óra`];
      lines.push(duration === null ? null : duration <= 0 ? "hamarosan eláll" : `még kb. ${duration} óráig tart`);
      setHero("Most esik", lines);
      hideQ2();
      return;
    }
    if (isRainingSoon(userForecast)) {
      const idx = soonRainIndex(userForecast);
      const mm = userForecast.hourly.precipitation[idx];
      const prob = userForecast.hourly.precipitation_probability?.[idx];
      const band = intensityBand(mm);
      const probText = typeof prob === "number" ? `${Math.round(prob)}% eséllyel, ` : "";
      setHero("Hamarosan", `${probText}${band.adj} eső várható`);
      hideQ2();
      return;
    }

    const answer = raining.length > 0 ? "Igen" : "Nem";

    // Csendes háttérfrissítésnél csak akkor megyünk tovább a távoli
    // keresésre, ha a környék helyzete meg is változott. A "hol esik
    // pontosan" válasz néhány perc alatt nem avul el annyira, hogy megérné
    // érte minden frissítéskor újra végigjárni az összes távoli gyűrűt is:
    // úgy egy nyitva hagyott lap napi több tízezer pontot kérne le.
    const unchanged = silent &&
      document.getElementById("q1-answer").textContent === answer;
    setHero(answer, null);
    showQ2("de hol esik pontosan?");
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
      const rainByIndex = new Map(grid
        .map((_, idx) => idx)
        .filter(idx => isRainingNow(forecasts[idx]))
        .map(idx => [idx, currentPrecipRate(forecasts[idx])]));
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
        <p class="context">${maxKm} km-en belül sem találtunk esőt</p>`);
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
  const rain = new Map(points
    .map((_, i) => i)
    .filter(i => isRainingNow(forecasts[i]))
    .map(i => [i, currentPrecipRate(forecasts[i])]));
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
  // koordinátáihoz kell számolni a távolságot/irányt/útvonalat - a névadó
  // pont a keresés során eltolódhatott az esős ponttól, így a kettő nem
  // feltétlenül ugyanaz.
  const isForeign = place.countryCode && userLoc.countryCode && place.countryCode !== userLoc.countryCode;
  const placeLabel = place.name
    ? (isForeign ? `${place.name}, ${place.countryName}` : place.name)
    : "egy közeli térségben";

  const targetLat = place.name ? place.lat : nearest.lat;
  const targetLon = place.name ? place.lon : nearest.lon;
  const displayDistance = place.name
    ? distanceKm(userLoc.lat, userLoc.lon, place.lat, place.lon)
    : nearest.distance;
  const displayBearing = place.name
    ? bearingBetween(userLoc.lat, userLoc.lon, place.lat, place.lon)
    : nearest.bearing;

  const direction = compassLabel(displayBearing);
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&origin=${userLoc.lat},${userLoc.lon}&destination=${targetLat},${targetLon}`;
  // Az erősség a megtalált esős PONTRA vonatkozik, nem a névadó településre:
  // a kettő eltérhet, ha a legközelebbi esős pontnak nem volt neve.
  const band = typeof nearest.mm === "number" ? intensityBand(nearest.mm) : null;
  const intensity = band
    ? `<p class="context">${band.adv} esik, ${formatMm(nearest.mm)} mm/óra</p>`
    : "";
  setQ2Answer(
    `<p class="place-line">${placeLabel}</p>
     <p class="context">${Math.round(displayDistance)} km innen
     <span class="direction-arrow" style="transform: rotate(${displayBearing}deg)" title="${direction} irányban" aria-label="${direction} irányban">↑</span></p>
     ${intensity}
     <a class="map-link" href="${mapsUrl}" target="_blank" rel="noopener">útvonal</a>`
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
  document.getElementById("q2-block").hidden = false;
  document.getElementById("q2-question").textContent = question;
}

function setQ2Answer(html) {
  document.getElementById("q2-answer").innerHTML = html;
}

function hideQ2() {
  document.getElementById("q2-block").hidden = true;
  document.getElementById("q2-answer").innerHTML = "";
}

// ---- "Részletek és statisztika" panel ----
// Ez a panel csak kinyitva tölt be (lásd a #stats-panel "toggle" figyelőt
// lent) - nem fut bele az 5 percenkénti automatikus frissítésbe, mert jóval
// nehezebb lekérdezés (31+ napos história, több évnyi archív összehasonlítás),
// mint amire a fő keresés épül. Minden nyitásnál újra lekér, nincs cache:
// egyetlen pontra vonatkozó hívásokról van szó, ez megengedhető egyszerűsítés.
let statsLoading = false;

async function buildStatsPanel(point) {
  if (statsLoading) return;
  statsLoading = true;
  const statusEl = document.getElementById("stats-status");
  statusEl.hidden = false;
  statusEl.textContent = "töltés…";
  try {
    const [stats, usual, flood] = await Promise.all([
      fetchUserStats(point),
      fetchUsualPrecipitation(point).catch(err => { console.error(err); return null; }),
      fetchRiverDischarge(point).catch(err => { console.error(err); return null; }),
    ]);
    const todayIdx = stats.daily.time.indexOf(stats.current.time.slice(0, 10));
    fillPrecipStats(stats, usual, todayIdx);
    fillForecastStats(stats, todayIdx);
    fillTempStats(stats, todayIdx);
    fillWaterStats(stats, flood, point);
    statusEl.hidden = true;
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Nem sikerült lekérni a statisztikát. Próbáld újra kicsit később.";
  } finally {
    statsLoading = false;
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
  document.getElementById("stats-precip-24h").textContent =
    sum24h === null ? "" : `Elmúlt 24 órában: ${formatMm(sum24h)} mm`;

  const daily = stats.daily.precipitation_sum;
  const sum7d = daily.slice(Math.max(0, todayIdx - 6), todayIdx + 1).reduce((a, b) => a + b, 0);
  const sum30d = daily.slice(Math.max(0, todayIdx - 29), todayIdx + 1).reduce((a, b) => a + b, 0);
  const diff7 = usual && formatUsualDiff(sum7d, usual.usual7d);
  const diff30 = usual && formatUsualDiff(sum30d, usual.usual30d);

  document.getElementById("stats-precip-7d").textContent =
    `Elmúlt 7 napban: ${formatMm(sum7d)} mm${diff7 ? ` (${diff7})` : ""}`;
  document.getElementById("stats-precip-30d").textContent =
    `Elmúlt 30 napban: ${formatMm(sum30d)} mm${diff30 ? ` (${diff30}, az elmúlt ${USUAL_PRECIP_YEARS_BACK} év ilyenkor átlagához képest)` : ""}`;

  const from = Math.max(0, todayIdx - 29);
  renderSparkline(
    document.getElementById("stats-precip-chart"),
    stats.daily.time.slice(from, todayIdx + 1),
    daily.slice(from, todayIdx + 1)
  );
}

// Kézzel épített, monokróm mini oszlopdiagram a radar-rajzoláshoz hasonló
// stílusban (createElementNS, külön könyvtár nélkül). A száraz napok is
// kapnak egy halvány alapvonalat, hogy a diagram üresen ne tűnjön hibásnak.
// Minden oszlop kattintható/koppintható (touch screenen is - a "click"
// esemény mindkettőre lefut): megnyitja a buborékot az adott nap dátumával
// és csapadékával. A látható sáv keskeny (0,7*barWidth), ezért egy átlátszó,
// szélesebb körvonal adja a tényleges koppintási célterületet - ugyanaz a
// trükk, mint a radar-pöttyök "stroke: transparent; stroke-width" megoldása.
function renderSparkline(svgEl, dates, values) {
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
    rect.setAttribute("fill", "var(--fg)");
    rect.setAttribute("opacity", v > 0 ? 0.85 : 0.15);
    rect.classList.add("stats-bar");
    rect.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleSparklineTooltip(i, dates[i], v, values.length);
    });
    svgEl.appendChild(rect);
  });
}

function formatStatsDate(dateIso) {
  return new Date(dateIso + "T00:00:00").toLocaleDateString("hu-HU", { month: "short", day: "numeric" });
}

let openTooltipBarIndex = null;

function toggleSparklineTooltip(index, dateIso, mm, barCount) {
  if (openTooltipBarIndex === index) {
    hideSparklineTooltip();
    return;
  }
  openTooltipBarIndex = index;
  const tooltip = document.getElementById("stats-precip-tooltip");
  const wrap = document.getElementById("stats-precip-chart").parentElement;
  const leftPercent = ((index + 0.5) / barCount) * 100;
  tooltip.textContent = `${formatStatsDate(dateIso)}: ${formatMm(mm)} mm`;
  tooltip.style.left = `${leftPercent}%`;
  tooltip.hidden = false;
}

function hideSparklineTooltip() {
  openTooltipBarIndex = null;
  const tooltip = document.getElementById("stats-precip-tooltip");
  if (tooltip) tooltip.hidden = true;
}

// Bárhova máshova kattintva (nem egy oszlopra) a buborék eltűnik - az
// oszlopok saját click-figyelője stopPropagation-nel előzi meg, hogy rögtön
// visszazáródjon, amikor épp megnyitjuk.
document.addEventListener("click", hideSparklineTooltip);

const FORECAST_DAY_LABELS = ["Holnap", "Holnapután"];
const HU_WEEKDAYS = ["vasárnap", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat"];

function fillForecastStats(stats, todayIdx) {
  const list = document.getElementById("stats-forecast-days");
  list.innerHTML = "";
  for (let offset = 1; offset <= 3; offset++) {
    const dayIdx = todayIdx + offset;
    if (dayIdx >= stats.daily.time.length) break;
    const label = FORECAST_DAY_LABELS[offset - 1] ||
      HU_WEEKDAYS[new Date(stats.daily.time[dayIdx]).getUTCDay()];
    const prob = stats.daily.precipitation_probability_max[dayIdx];
    const sum = stats.daily.precipitation_sum[dayIdx];
    const probText = typeof prob === "number" ? `${Math.round(prob)}% eséllyel, ` : "";
    const li = document.createElement("li");
    li.textContent = `${label}: ${probText}kb. ${formatMm(sum)} mm`;
    list.appendChild(li);
  }
}

function fillTempStats(stats, todayIdx) {
  document.getElementById("stats-temp-now").textContent =
    `Most: ${formatC(stats.current.temperature_2m)} °C`;

  const todayMin = stats.daily.temperature_2m_min[todayIdx];
  const todayMax = stats.daily.temperature_2m_max[todayIdx];
  const tomorrowIdx = todayIdx + 1;
  const tomorrowMin = stats.daily.temperature_2m_min[tomorrowIdx];
  const tomorrowMax = stats.daily.temperature_2m_max[tomorrowIdx];
  const tomorrowText = tomorrowMax === undefined
    ? ""
    : `, holnap: ${formatC(tomorrowMin)}–${formatC(tomorrowMax)} °C`;
  document.getElementById("stats-temp-minmax").textContent =
    `Ma: ${formatC(todayMin)}–${formatC(todayMax)} °C${tomorrowText}`;

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

// A folyó-vízhozamot csak akkor mutatjuk, ha a flood-api által visszaadott
// legközelebbi modellezett folyószakasz valóban közel van ÉS a vízhozam nem
// zajszintű - lásd a fetchRiverDischarge komment je fenti, és a PROGRESS/terv
// dokumentált mérései (Budapest/Szeged ad értelmes számot, több kisváros nem).
const RIVER_MAX_DISTANCE_KM = 15;
const RIVER_MIN_DISCHARGE = 2;

function fillWaterStats(stats, flood, point) {
  const idx = currentHourIndex(stats);
  const soil = idx === -1 ? undefined : stats.hourly.soil_moisture_0_to_1cm[idx];
  const soilEl = document.getElementById("stats-water-soil");
  if (typeof soil !== "number") {
    soilEl.hidden = true;
  } else {
    const prevSoil = idx >= 24 ? stats.hourly.soil_moisture_0_to_1cm[idx - 24] : null;
    let trend = "";
    if (typeof prevSoil === "number") {
      const delta = soil - prevSoil;
      trend = delta > 0.02 ? ", nő" : delta < -0.02 ? ", csökken" : ", stabil";
    }
    soilEl.hidden = false;
    soilEl.textContent = `A talaj felső rétege most ${soilMoistureLabel(soil)}${trend}`;
  }

  const riverEl = document.getElementById("stats-water-river");
  if (!flood || !flood.daily || !flood.daily.river_discharge) {
    riverEl.hidden = true;
    return;
  }
  const dist = distanceKm(point.lat, point.lon, flood.latitude, flood.longitude);
  const [todayDischarge, tomorrowDischarge] = flood.daily.river_discharge;
  if (dist > RIVER_MAX_DISTANCE_KM || !(todayDischarge >= RIVER_MIN_DISCHARGE)) {
    riverEl.hidden = true;
    return;
  }
  let trend = "stabil";
  if (typeof tomorrowDischarge === "number") {
    const relChange = (tomorrowDischarge - todayDischarge) / todayDischarge;
    trend = relChange > 0.05 ? "emelkedő" : relChange < -0.05 ? "csökkenő" : "stabil";
  }
  riverEl.hidden = false;
  riverEl.textContent = `A legközelebbi folyó vízhozama: ${Math.round(todayDischarge)} m³/s, ${trend}`;
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
  panel.open = false;
  hideSparklineTooltip();
}

function beginSearchUI() {
  cancelReveal();
  const loading = document.getElementById("loading");
  const svg = document.getElementById("radar-svg");
  document.getElementById("result").dataset.phase = PHASE_LOCAL;
  document.getElementById("loading-text").textContent = "töltés…";
  loading.classList.remove("settled", "locating");
  loading.hidden = false;
  svg.style.transition = "";
  svg.style.transform = "";
  bordersVisible = false; // keresés közben tiszta radar, csak a pontokkal
  resetStatsPanel();
  resetWaterPanel();
  radarReset();
  radarRestartSweep();
  document.getElementById("radar-image").removeAttribute("href");
  loadBorders();     // lusta betöltés, a választ sosem várakoztatja
  loadWaterGeo();    // ugyanúgy lusta, ugyanúgy nem várakoztat
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
        // A határok és a radarkép csak most, a végleges válasszal együtt
        // jelennek meg. A radarkép hálózatról jön, ezért nem várjuk meg.
        radarEnsureMinRadius();
        bordersVisible = true;
        radarDrawBorders();
        radarDrawWaterGeo();
        drawRadarImage().catch(err => console.error(err));
        // A statisztika-panel is csak most, hogy a radar véglegesen betöltött:
        // zárva marad (a felhasználó nyitja ki), csak a láthatósága nyílik meg.
        document.getElementById("stats-panel").hidden = false;
        // A vízadat-panel viszont NEM gombra nyílik: a radar után rögtön
        // megjelenik, nyitva, mert a felhasználó szerint ez folytatja az
        // oldalt, nem egy elrejtendő mellékes részlet.
        document.getElementById("water-panel").hidden = false;
        if (currentLoc) buildWaterPanel(currentLoc);
      }
      resolve();
    }, delayMs);
  });
}

function scheduleReveal() {
  revealPhase(PHASE_DONE, REVEAL_DELAY_MS);
}

// A fázisváltáskor megjelenő szöveg egy ugrással lökné lejjebb a radart.
// Ezért FLIP-technikát használunk: megmérjük a radar helyét a változtatás
// ELŐTT és UTÁN, a különbséggel visszatoljuk oda, ahol volt, majd onnan
// animáljuk az új helyére. Így ugrás helyett szépen lecsúszik, miközben a
// szöveg beúszik fölötte.
function slideRadar(applyLayoutChange) {
  const svg = document.getElementById("radar-svg");
  const first = svg.getBoundingClientRect();

  applyLayoutChange();

  const last = svg.getBoundingClientRect();
  const scale = last.width ? first.width / last.width : 1;

  svg.style.transition = "none";
  svg.style.transformOrigin = "top left";
  svg.style.transform =
    `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${scale})`;
  svg.getBoundingClientRect(); // kényszerített újraszámolás, hogy legyen mihez animálni
  svg.style.transition = `transform ${REVEAL_SLIDE_MS}ms ease`;
  svg.style.transform = "translate(0, 0) scale(1)";
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
}

// Helyszín-módosításkor a lemaradt (settled) radart is el kell tüntetni,
// különben ott lógna a helyszín-kereső form alatt.
function hideLoadingImmediately() {
  cancelReveal();
  const loading = document.getElementById("loading");
  loading.hidden = true;
  loading.classList.remove("settled", "locating");
  resetStatsPanel();
  resetWaterPanel();
}

function showError(msg) {
  const el = document.getElementById("location-error");
  el.textContent = msg;
  el.hidden = false;
}

function showResult() {
  document.getElementById("location-picker").hidden = true;
  document.getElementById("result").hidden = false;
}

function showPicker() {
  document.getElementById("result").hidden = true;
  document.getElementById("location-picker").hidden = false;
  hideLoadingImmediately();
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
    showLoading(false);
    showPicker();
    showError("Nem sikerült automatikusan meghatározni a helyzeted. Add meg kézzel:");
  }
}

document.getElementById("location-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("location-input");
  const errorEl = document.getElementById("location-error");
  errorEl.hidden = true;

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
  btn.textContent = enabled ? "értesítés kikapcsolása" : "értesíts, ha esni kezd";
}

async function enableNotifications(userLoc) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    alert("A böngésződ nem támogatja az értesítéseket.");
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return;

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
  const loc = loadSavedLocation();
  if (loc) await enableNotifications(loc);
});

document.getElementById("change-location").addEventListener("click", () => {
  showPicker();
});

document.getElementById("stats-panel").addEventListener("toggle", (event) => {
  if (event.target.open && currentLoc) buildStatsPanel(currentLoc);
});
// A water-panel már nem <details>, nincs toggle esemény: megjelenését és
// feltöltését a revealPhase(PHASE_DONE) ág intézi.

document.getElementById("retry-geo").addEventListener("click", () => {
  document.getElementById("location-error").hidden = true;
  tryAutoLocate();
});

// ============================================================================
// Vízadatok: talaj, folyók, tavak, vízmérleg
//
// Három, otthoni gépen (soil-moisture-mapper, külön repó) óránként frissített
// pillanatkép a push-worker KV-jéből: GET /soil-snapshot, /rivers-snapshot,
// /lakes-snapshot (ugyanaz a PUSH_WORKER_URL, ami a push-értesítésekhez is
// kell, ld. fentebb). A panel csak megnyitáskor tölt, és minden megnyitáskor
// újra - mint a #stats-panel (lásd a toggle-wiringot a fájl végén).
// ============================================================================

const BALATON_LITERS = 1.9e12; // ~1,9 km³, több forrásból is megerősített érték
const WATER_DEPTH_BANDS = [[0, 1, 0.01], [1, 3, 0.02], [3, 9, 0.06], [9, 27, 0.18], [27, 81, 0.54]];

// Az EGYETLEN Balaton-ikon path (a design-canvasból), amit minden
// Balaton-ábra használ: a waterBalatonTilesSvg (vízmérleg "hány Balaton"),
// a renderBalatonStack (talajvíz-rétegek) apró csempeként, és a
// renderBalatonFill (tavak) felskálázva, mint a nagy tó-alak.
const BALATON_TILE_ICON_PATH = "M47.3 21.7 L45.5 23.5 L24 32.7 L22.7 33.7 L21.6 35.1 L18.5 37.4 L17.2 38 L14 38.3 L8 37.2 L4.7 37.1 L2.1 38 L0.8 37.9 L0 36.4 L1.1 32.4 L4.2 32.3 L7.4 33.4 L8.9 33 L9.4 31.5 L10.5 30.2 L12 29.1 L13.3 28.7 L16.2 29 L17.6 29.4 L18.9 30.3 L22.8 27.4 L24.9 26.2 L28.9 25.6 L29.8 25.1 L31.3 22.8 L32.3 21.5 L33.1 21.1 L34.1 20.9 L43.6 17.1 L44.9 15.5 L45.4 15.8 L48 18.1 L49.1 18.2 L49.8 17 L49.3 15.5 L48.2 14.3 L47 13.6 L47 12.9 L54.5 8.6 L56.9 6.8 L57.9 5.6 L59 4 L59.8 2.2 L60.1 0.4 L60.8 0 L62.4 0.3 L65.8 1.5 L67.1 2.3 L68.8 3.6 L70.1 5.2 L70.1 6.4 L69 8.3 L67.6 11.6 L66.3 12.9 L63.2 14.7 L52.6 18.4 L52.1 18.5 L51.1 18.2 L50.7 18.7 L49.6 20.4 L47.3 21.7Z";

// A nagy tó-feltöltés ábra (renderBalatonFill) KORÁBBAN egy külön, részletes
// (Natural Earth-ből vágott) körvonalat használt - ez a design-canvastól
// eltérő, erősen átlós kontúr volt, aminek vízszintes "vízszint-vágása"
// (clipPath) a tó jobb/északi végét teljesen üresen hagyta még magas
// vízállásnál is ("a Balaton vízszintje furcsán néz ki" - felhasználói
// visszajelzés, élő screenshoton ellenőrizve). A design-canvas maga a kis,
// egyszerűsített ikon-körvonalat (BALATON_TILE_ICON_PATH) skálázza fel a
// nagy ábrához is (translate(7,2) scale(5.5) egy 400x228-as rajzterületen) -
// ugyanezt tesszük itt, csak a mi 640-es rajzterületünkre igazítva.
const BALATON_FILL_TRANSFORM = "translate(130,150) scale(5.1)";
const BALATON_BBOX = { x: 130, y: 150, width: 357.5, height: 195.3 };
// A tó hossztengelye átlósan dől (DNy-ÉK), nem vízszintes - egy sima
// vízszintes vágás ezért a tó ÉK-i végét MINDIG üresen hagyná, bármekkora
// a vízszint (élő screenshoton ellenőrizve: "Balaton vízszintje furcsán
// néz ki"). A feltöltő téglalapot ezért a tó dőlésszögével forgatjuk el,
// hogy a vízszint-vonal a hossztengelyre MERŐLEGESEN haladjon végig a
// tavon, a DNy-i végtől (Keszthely) az ÉK-i végig (Siófok/Balatonkenese).
const BALATON_TILT_DEG = 66;
const BALATON_TILT_PIVOT = { x: 308.8, y: 256.1 };
const BALATON_TILT_HALF_SPAN = 196;

// Kis, azonos-léptékű körvonalak (ugyanabból a design-canvasból) a "többi
// nagy tó" összevető ábrájához: Balaton, Fertő, Tisza-tó, egy 400x140-es
// rajzterületen.
const LAKE_COMPARE_PATHS = {
  balaton: { d: "M142 65.2 L136.5 70.4 L72 98.1 L68.2 101.2 L64.8 105.2 L55.4 112.1 L51.7 113.9 L41.9 114.9 L24.1 111.5 L14.2 111.3 L6.2 114 L2.4 113.6 L0 109.1 L3.4 97.1 L12.6 96.9 L22.2 100.3 L26.7 98.9 L28.1 94.5 L31.6 90.5 L35.9 87.4 L40 86.2 L48.6 86.9 L52.8 88.3 L56.6 90.9 L68.3 82.1 L74.8 78.7 L86.8 76.9 L89.4 75.4 L93.9 68.4 L96.8 64.6 L99.3 63.2 L102.2 62.7 L130.9 51.2 L134.7 46.6 L136.2 47.5 L143.9 54.2 L147.2 54.7 L149.3 50.9 L147.8 46.5 L144.5 42.8 L140.9 40.9 L140.9 38.7 L163.6 25.9 L170.7 20.3 L173.8 16.7 L176.9 11.9 L179.4 6.5 L180.2 1.2 L182.4 0 L187.3 0.9 L197.3 4.5 L201.4 6.9 L206.4 10.9 L210.2 15.5 L210.4 19.3 L207.1 24.9 L202.8 34.7 L198.9 38.7 L189.6 44.1 L157.8 55.2 L156.2 55.4 L153.4 54.7 L152.1 56.1 L148.8 61.3 L142 65.2Z", transform: "" },
  ferto: { d: "M24.6 31.9 L17.6 43.9 L13.9 51.7 L12.5 55.4 L10.5 65.6 L11.4 74.7 L16 74.5 L20.5 72.5 L24.8 77.1 L26 82.4 L24.7 85.7 L23.2 87.2 L20.2 84.5 L17.3 83.8 L12.1 81.7 L8.8 73.4 L6.1 65.8 L3.3 64.6 L3.7 70.3 L2.4 74.2 L0 70.2 L1 64.1 L3.8 61.9 L4.6 59.6 L2.8 57.2 L2.6 49.1 L5.2 39.5 L7.6 33.2 L8.6 23.3 L9.7 17.5 L12.7 11.4 L18.4 4.8 L26.2 1.6 L32.9 0 L36 2.4 L35.7 9.6 L33.4 18.6 L29.9 25.1 L27.9 27.9 L24.6 31.9Z", transform: "translate(250,10)" },
  tiszato: { d: "M0 25.5 L3.9 13.1 L7.6 5.2 L10.2 2.9 L14.7 0.1 L19.6 0 L20.6 4.1 L20.7 7.1 L18 11.4 L14.7 15.7 L11.9 20.8 L8.6 25 L2.1 27.4 L0 25.5Z", transform: "translate(330,70)" },
};

function waterNum(n, maxDecimals = 1) {
  return n.toLocaleString("hu-HU", { maximumFractionDigits: maxDecimals });
}

function waterBalatonCount(liters, decimals = 1) {
  return waterNum(liters / BALATON_LITERS, decimals);
}

// Vonalkázás-sűrűség = "mennyire nedves": minél kisebb a mintaegység, annál
// sűrűbb a vonal. 5 fokozat, a már meglévő SOIL_MOISTURE_BANDS szellemében,
// csak finomabb bontásban (ez egy ábrához kell, nem egy szöveges címkéhez).
const WATER_HATCH_TILE_PX = [12, 8, 6, 4.5, 3.5];

function waterHatchIndex(fraction0to1) {
  const pct = fraction0to1 * 100;
  if (pct < 15) return 0;
  if (pct < 25) return 1;
  if (pct < 32) return 2;
  if (pct < 40) return 3;
  return 4;
}

function waterHatchDefs() {
  return WATER_HATCH_TILE_PX.map((tile, i) => `
    <pattern id="wh${i}" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="${tile}" height="${tile}" fill="var(--bg)"></rect>
      <line x1="${tile / 2}" y1="0" x2="${tile / 2}" y2="${tile}" stroke="var(--fg)" stroke-width="1.2"></line>
    </pattern>`).join("");
}

// ---- 1. Talajvíz: Balaton-alakú rétegek ----
//
// Minden mélységi sáv egy VÍZSZINTES CSÍKJA a Balaton körvonalának, a sáv
// liter-arányos magasságú (clipPath-tel vágva, nem a path újrarajzolásával -
// ez garantálja, hogy minden csík pontosan a megfelelő, torzítatlan darabja
// a tó alakjának). A legmélyebb sáv alul, a legfelső (0-1cm) felül, mint egy
// talajszelvény.
// A korábbi "egy közös Balaton-körvonal, vízszintesen clipPath-elt sávokra
// osztva" próbálkozás élőben (Playwright-tesztelve, mobil és asztali nézetben
// is) vagy levágta a feliratot a jobb szélen, vagy a két legkisebb sáv
// felirata egymásra csúszott - a pontos koordináta-matek bármekkora
// minimum-magasság mellett törékeny maradt. Az azóta frissített terv-canvas
// megoldása ezt elkerüli: NINCS pozicionált SVG-szöveg. Minden sáv egy
// SIMA HTML sor (böngésző intézi a sorközt, nem mi), alatta egy kis,
// apró Balaton-ikonokkal mintázott sáv, aminek a SZÉLESSÉGE arányos a
// liter-mennyiséggel - ugyanaz a minta-csempe trükk, mint a vízmérleg
// "hány Balaton" ábráján (ld. waterBalatonTilesSvg).
function renderBalatonStack(containerEl, depthBandsCm, litersByDepth, moistureByDepth) {
  const counts = litersByDepth.map(l => l / BALATON_LITERS);
  const maxCount = Math.max(...counts, 0.01);
  const BAR_UNITS_PER_BALATON = 46; // ~ a design mintájából (327.5 egység / 7.1 Balaton)

  containerEl.innerHTML = "";
  const list = document.createElement("div");
  list.className = "water-balaton-stack-list";

  for (let i = 0; i < depthBandsCm.length; i++) {
    const [lo, hi] = depthBandsCm[i];
    const pct = Math.round(moistureByDepth[i] * 100);
    const widthUnits = Math.max(2, counts[i] * BAR_UNITS_PER_BALATON);
    const row = document.createElement("div");
    row.innerHTML = `
      <div class="water-balaton-stack-row-head">
        <span style="font-weight: 600;">${lo}–${hi} cm</span>
        <span style="color: var(--muted);">${waterBalatonCount(litersByDepth[i], 2)} Balaton · ${pct}% víz</span>
      </div>
      <svg viewBox="0 0 400 26" class="water-balaton-stack-bar" aria-hidden="true">
        <defs><pattern id="mbal-${i}" width="46" height="26" patternUnits="userSpaceOnUse">
          <path transform="translate(1.5,1.5) scale(0.6)" fill="var(--fg)" d="${BALATON_TILE_ICON_PATH}"></path>
        </pattern></defs>
        <rect x="0" y="0" width="${widthUnits.toFixed(1)}" height="26" fill="url(#mbal-${i})"></rect>
      </svg>`;
    list.appendChild(row);
  }
  containerEl.appendChild(list);
}

// ---- 2. Országtérkép: talajnedvesség-dombormű + folyók + tavak ----
//
// Lapos rács, EGYENES felülnézetben (nem axonometrikus/ferde - korábban
// kipróbáltuk izometrikus kockákkal is, majd ferde-vetítésű lapos cellákkal,
// de a felhasználó szerint ez még mindig túl "térképészeti makett"-szerű
// volt; sima, torzítatlan felülnézet kell, mint egy valódi térkép). Minden
// Magyarországon belüli talaj-cella egy sima, tömör színű téglalap, az 5
// fokozatú --t0..--t4 szürkeskálával. A folyó- és tó-mérőállomások, a
// legnagyobb folyók VALÓDI vonala (water-geo.json, ld. a radar-szakaszt) és
// a Balaton VALÓDI körvonala UGYANAZZAL a lat/lon -> rács -> képernyő
// vetítéssel kerül a térképre, tehát mind pontosan a megfelelő helyre esik.
// A puffer/szomszéd-pontok (ld. soil-moisture-mapper in_hungary=false) NEM
// jelennek meg ezen a térképen - túlzsúfolt lenne, és a jóváhagyott design
// sem különbözteti meg őket.
const WATER_CELL_W = 20;
const WATER_CELL_H = 16;

function waterProjectRowCol(row, col, originX, originY) {
  return { x: originX + col * WATER_CELL_W, y: originY + row * WATER_CELL_H };
}

function waterFlatCell(x, y, tierIndex) {
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${WATER_CELL_W}" height="${WATER_CELL_H}" fill="var(--t${tierIndex})" stroke="var(--bg)" stroke-width="0.5"></rect>`;
}

// Csak jelölők, FELIRAT NÉLKÜL: egy sűrű rácson (akár 12 folyó-állomás +
// 5 tó-mérce) a mindegyikhez kiírt név+érték élőben kipróbálva olvashatatlan
// tömeggé állt össze (egymást fedő feliratok). A név/érték a külön "és a
// folyók?" listában és a tavak szekcióban már úgyis megvan - a térképen csak
// a HELY számít. Folyó = üres gyűrű, tó = teli gyémánt alak - a kettő forma
// szerint megkülönböztethető szín/felirat nélkül is.
function waterRiverMarker(x, y) {
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="var(--bg)" stroke="var(--fg)" stroke-width="1.3"></circle>`;
}

function waterLakeMarker(x, y) {
  const r = 3.2;
  return `<path d="M${x.toFixed(1)} ${(y - r).toFixed(1)} L${(x + r).toFixed(1)} ${y.toFixed(1)} L${x.toFixed(1)} ${(y + r).toFixed(1)} L${(x - r).toFixed(1)} ${y.toFixed(1)} Z" fill="var(--fg)"></path>`;
}

function buildReliefMap(svgEl, legendEl, soilSnapshot, riverStations, lakeStations, highlightLoc, waterGeo) {
  const cells = soilSnapshot.points.filter(p => p.in_hungary);
  if (!cells.length) {
    svgEl.innerHTML = "";
    legendEl.textContent = "a dombormű-adat jelenleg nem érhető el";
    return;
  }

  const step = soilSnapshot.grid_step_deg;
  const lats = cells.map(p => p.lat), lons = cells.map(p => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons);
  const toRowCol = (lat, lon) => ({ row: (maxLat - lat) / step, col: (lon - minLon) / step });

  const litersValues = cells.map(p => p.liters_total);
  const minL = Math.min(...litersValues), maxL = Math.max(...litersValues);
  const tierFor = liters => {
    if (maxL <= minL) return 2;
    return Math.min(4, Math.floor(((liters - minL) / (maxL - minL)) * 5));
  };

  // A rács befoglaló méretéből skálát és origót számolunk, hogy a teljes
  // dombormű beleférjen a viewBox-ba, a tetején elég hellyel a folyó-/
  // tó-jelölőknek.
  const rowsAll = cells.map(p => toRowCol(p.lat, p.lon).row);
  const colsAll = cells.map(p => toRowCol(p.lat, p.lon).col);
  const maxRow = Math.max(...rowsAll), maxCol = Math.max(...colsAll);
  const gridPixelWidth = (maxCol + 1) * WATER_CELL_W;
  const originX = Math.max(20, (640 - gridPixelWidth) / 2);
  const originY = 40;

  let cellsMarkup = "";
  let maxCell = cells[0], minCell = cells[0];
  for (const cell of cells) {
    if (cell.liters_total > maxCell.liters_total) maxCell = cell;
    if (cell.liters_total < minCell.liters_total) minCell = cell;
    const { row, col } = toRowCol(cell.lat, cell.lon);
    const { x, y } = waterProjectRowCol(Math.round(row), Math.round(col), originX, originY);
    cellsMarkup += waterFlatCell(x, y, tierFor(cell.liters_total));
  }

  const projectLatLon = (lat, lon) => {
    const { row, col } = toRowCol(lat, lon);
    const p = waterProjectRowCol(row, col, originX, originY);
    return { x: p.x + WATER_CELL_W / 2, y: p.y + WATER_CELL_H / 2 }; // cella közepére, nem a sarkára
  };

  // A legnagyobb folyók és a Balaton VALÓDI vonala/körvonala, ugyanazzal a
  // projectLatLon-nal, mint a mérőállomások - ugyanaz a water-geo.json,
  // amit a radar is használ (ld. loadWaterGeo), csak most a rács fölé
  // vetítve, nem azimutálisan. A cellák UTÁN kell rajzolni, különben a
  // tömör cella-téglalapok eltakarnák.
  //
  // A water-geo.json SZÁNDÉKOSAN túlnyúlik Magyarország határán (a Duna/
  // Tisza/Dráva külföldi szakaszai is benne vannak, a radar-vetítéshez
  // kellenek). Itt viszont a rács egyenes, lineáris vetület - egy messze
  // kívül eső pont (pl. a Duna romániai torkolata) egyenes szakasszal
  // kötné össze a magyarországi résszel, ami a teljes vásznon átszelő,
  // hamis vonalként jelenne meg. Ezért a rács-tartományon kívül eső
  // pontoknál megszakítjuk a vonalat, nem a peremre lapítjuk.
  const BOUNDS_MARGIN = 3;
  const inGridBounds = (row, col) =>
    row >= -BOUNDS_MARGIN && row <= maxRow + BOUNDS_MARGIN &&
    col >= -BOUNDS_MARGIN && col <= maxCol + BOUNDS_MARGIN;
  const waterGeoPath = rings => {
    let d = "";
    for (const ring of rings) {
      let connected = false;
      for (const [lon, lat] of ring) {
        const { row, col } = toRowCol(lat, lon);
        if (!inGridBounds(row, col)) {
          connected = false;
          continue;
        }
        const { x, y } = projectLatLon(lat, lon);
        d += `${connected ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
        connected = true;
      }
    }
    return d;
  };
  let geoMarkup = "";
  if (waterGeo) {
    const riverD = waterGeoPath(waterGeo.rivers);
    if (riverD) geoMarkup += `<path class="water-map-river" d="${riverD}"></path>`;
    const lakeD = waterGeoPath(waterGeo.lakes);
    if (lakeD) geoMarkup += `<path class="water-map-lake" d="${lakeD}"></path>`;
  }

  let markersMarkup = "";
  for (const station of riverStations) {
    const { x, y } = projectLatLon(station.lat, station.lon);
    markersMarkup += waterRiverMarker(x, y);
  }
  for (const station of lakeStations) {
    if (station.station === "Balaton average") continue; // a 3 mérce elég, az átlag külön szekcióban van
    const { x, y } = projectLatLon(station.lat, station.lon);
    markersMarkup += waterLakeMarker(x, y);
  }

  if (highlightLoc) {
    const { x, y } = projectLatLon(highlightLoc.lat, highlightLoc.lon);
    markersMarkup += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="none" stroke="var(--fg)" stroke-width="1.5"></circle>`;
  }

  svgEl.innerHTML = `<defs></defs>${cellsMarkup}${geoMarkup}${markersMarkup}`;

  // A legenda ugyanazt az 5 fokozatú --t0..--t4 szürkeskálát rajzolja ki,
  // amit a cellák - a két nézet (térkép és legenda) garantáltan összhangban
  // marad, nem két külön színskála.
  const tierBoundaries = [0, 1, 2, 3, 4, 5].map(k => minL + (k / 5) * (maxL - minL));
  const tierLabel = i => {
    const lo = Math.round(tierBoundaries[i] / 1e9);
    const hi = Math.round(tierBoundaries[i + 1] / 1e9);
    if (i === 0) return `${hi} alatt`;
    if (i === 4) return `${lo} felett`;
    return `${lo}–${hi}`;
  };
  const legendSwatches = [0, 1, 2, 3, 4].map(i =>
    `<span style="display:flex;align-items:center;gap:6px;"><svg width="13" height="13" aria-hidden="true"><rect width="13" height="13" fill="var(--t${i})" stroke="var(--fg)" stroke-width="0.75"></rect></svg>${tierLabel(i)}</span>`
  ).join("");

  legendEl.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:8px 16px;font-size:13px;color:var(--muted);">${legendSwatches}</div>
    <p style="margin: var(--sp-2) 0 0;">Minden cella kb. ${Math.round(step * 111)} × ${Math.round(step * 111)} km, a szín erőssége jelzi, mennyi víz van alatta (milliárd liter). A vonal a legnagyobb folyók, a szaggatott körvonal a Balaton valódi futása. Az üres gyűrű folyó-mérőállomás, a teli gyémánt tó - a pontos vízállásuk lent, a listákban.</p>`;
}

// ---- 2c. Folyóhálózat: teljes vonalhálózat, vastagság = vízhozam ----
//
// Ez MÁS, mint a fenti dombormű: ott a talajnedvesség-rács kap folyó-/tó-
// JELÖLŐKET (pontok, cm-es élő adattal), itt viszont maga a folyók VALÓDI
// FUTÁSA van megrajzolva, a vonalvastagság a sokéves átlagos vízhozammal
// (m³/s) arányos - ez egy külön, statikus "melyik folyóban folyik a
// legtöbb víz" áttekintő, nem napi adat, és szándékosan nem ugyanaz a
// vizualizáció, mint a talaj-dombormű.
const WATER_RIVER_NET_SVG = `
  <path fill="none" stroke="var(--border)" stroke-width="1.5" stroke-linejoin="round" d="M393.1 58.5 L390.7 62.2 L386.6 64.5 L386 68.4 L383.2 69.3 L379.5 73.1 L375.2 74.3 L369.1 71.8 L367.3 72.2 L365.8 76.1 L358.8 77.1 L355.1 81.2 L352.5 88.5 L348.9 89.8 L343.7 94.2 L342.7 96.3 L343.4 104.5 L342.2 106.8 L338.7 108.2 L335.5 112.5 L333.3 119.4 L333.1 122.9 L330.8 125.6 L329.9 128.5 L322.5 135.4 L324.6 137.8 L323.3 142 L320 144.9 L319.7 149.9 L317 151 L315.1 153.5 L313.2 158.7 L315.2 160.3 L315 161.9 L311.3 164.4 L309 168.4 L303.6 170.2 L303.1 175 L300.5 180.8 L302.5 185.8 L297.6 187.4 L296.1 190.3 L294.7 196.9 L292.2 197.5 L289.5 200.8 L276.3 197.9 L271.8 200.7 L272.1 204.5 L270.1 204.8 L269.5 207.5 L267.5 209 L263.9 209.7 L256.4 206 L255 208.3 L245.9 208.5 L243.6 211.5 L240.5 208.8 L237.6 209.1 L235.4 207.6 L231.8 208.6 L225.8 206.9 L217.9 209.7 L211 206.1 L204.3 206.8 L200.7 209.3 L201.4 211.4 L198.8 214 L194.6 217.7 L190.5 218.3 L188 222 L181.5 221.8 L178.1 218.9 L175.9 221.1 L175.8 223.5 L172 224.6 L172 227 L166.6 226.3 L163.3 228.3 L162 227.7 L160.3 230.2 L153.5 228.2 L148.9 235.7 L146.4 237.9 L143.7 237.8 L139.3 242 L137.2 240.6 L134.3 241.5 L128.3 238.3 L120.9 239.5 L110.1 237.8 L108.3 239.5 L105.5 235.9 L96.8 233.3 L96.2 229.5 L93.1 225.8 L88.6 224.3 L83.8 224.1 L82.6 225.2 L81.7 223.6 L79.2 224.2 L78.8 221.8 L78.1 222.8 L76 221.8 L77.6 220.7 L75.2 219.5 L73.7 213.8 L71.4 210.8 L65.3 209.8 L58.2 203 L53.3 196.2 L52.5 192 L50.4 188.7 L46.5 187.5 L45.7 188.7 L40.2 181.9 L36.6 180.3 L35.6 181.3 L32.1 178.7 L31.3 175.2 L23.7 167 L26.1 164.9 L25.8 163.3 L23.1 162.3 L23.1 160.9 L20.7 158.6 L19.8 155.9 L21.3 150.6 L18.3 148.6 L8.2 148.7 L15.5 142.2 L18.4 136.9 L26.4 138.2 L30.4 137.4 L29.4 135.7 L26.9 135.3 L30.8 133.2 L28.6 130.5 L31.7 125.8 L31.1 124.8 L27.4 125.2 L27.9 122.5 L26.3 121.7 L26.7 117.1 L29.7 114.2 L26.9 108.6 L27.5 104.3 L28.7 103 L30.2 104.6 L39.2 99.6 L39 96.2 L41.3 94.9 L41.9 92.5 L39.8 90.1 L40.1 88.5 L38.6 85.5 L26 82.3 L27.8 79.8 L28.6 80.6 L31.9 78.5 L33 75.5 L35.1 74.5 L42 76.6 L44.3 80.2 L48.1 81.1 L51.1 78 L51.9 80.1 L54.1 80.5 L63.9 78.3 L62.4 76.5 L61.9 70.6 L62.7 69.7 L59.8 65.5 L63.4 63.9 L64.5 60.5 L63.8 59.7 L65 57.8 L64.4 56.6 L70.1 52.4 L78.8 54.2 L86.4 63.3 L89.5 64.7 L92.1 68.3 L93.9 67.9 L98 71.6 L106.4 74.9 L129.7 74.6 L147.7 71.3 L155.6 72.6 L159.9 68.9 L162.6 68 L158.8 64.8 L159.1 58.1 L158.5 56.5 L161.4 54.7 L163.9 50.8 L172.9 48.6 L185.7 49 L189.7 46.8 L197.4 46.9 L200.4 44.8 L202.2 37.1 L208.4 35.2 L212 37.7 L216 37.4 L217 38.6 L217.1 41.6 L219.7 40.9 L223.2 43.3 L225.8 43.3 L235.8 37.2 L237.4 33.6 L239.5 33.8 L242.8 31.5 L245.3 33.1 L248.2 30.8 L253.7 18.4 L257.1 14.2 L257.1 10.3 L275.2 6.7 L283.5 10.9 L288.6 11.3 L292.8 13.4 L299 10.9 L301.4 12.2 L304.8 8.5 L310.6 7.4 L314.9 9.6 L316.2 12.5 L320.1 13.1 L321.4 17.4 L325 23.1 L329.6 26.3 L339.3 23.1 L347.7 22.8 L354.8 19.3 L358.7 20.5 L357.9 24.4 L360.2 25 L360.8 29.6 L363.6 33.9 L370.6 33.9 L374.8 39.3 L377.6 46 L385.6 44.4 L388.8 46.5 L391.8 50.1 L392.2 51.7 L390.5 55.8 L393.1 58.5Z"></path>

  <!-- határon túli szakaszok -->
  <g fill="none" stroke="var(--muted)" stroke-width="0.75" stroke-linecap="round" stroke-linejoin="round">
  <path d="M165.1 232.7 L165.3 234.4 L164.8 235.7 L164.7 237.5 L166.2 238.7 L167.5 241.3 L167.6 244.3 L168 245.4 L171 247.6 L171.2 248.2 L170.6 250M163.6 229.9 L164 231.4 L165.1 231.8 L165.1 232.7M67.4 42.7 L68.1 43.5 L67.9 45.5 L69.3 48.2 L73.4 51.5M84.7 58.9 L85.3 59.1 L85.5 60M85.8 60.4 L86 60.6M25.9 34.4 L31.5 40.1 L35 42.4 L38 43.2 L42 43.6 L45.5 43 L48.9 44.3 L53.4 43 L55.2 41.9 L56.2 42 L58.4 40 L62.3 42.5 L67.4 42.7M0 25.9 L3.9 25.4 L5.3 26 L8.6 25.9 L14.8 24.7 L20.3 24.9 L21.8 25.9 L22.7 27.9 L22.5 28.7 L25.9 34.4"></path>
  <path d="M270.6 207.8 L273.2 207.8 L276.2 212.2 L277.5 213.2 L278.4 212.8 L281.4 214.3 L282 213.9 L282 213.1 L282.9 212.3 L284.1 210 L285.1 209.7 L284.8 209.3 L286.1 209.9 L286.6 209.5 L285.5 208.7 L285.9 208.4 L286.9 208.9 L287.2 208.3 L286.9 207.9 L291.6 207.6 L292.3 207.9 L293 209.1 L296.3 209.2 L299.2 207.7 L301.4 208.1 L303.2 207.2 L304.8 206.9 L304.9 206 L305.6 205.7 L306.7 207.1 L306.7 208.1 L308.1 208.6 L308.8 209.7 L310.2 210.2 L311.3 209.7 L311.3 209 L314.9 209 L316.9 211 L321.8 211.7 L322.2 212.5 L323.3 212.6 L322.8 213.5 L324.1 212.8 L324.4 214.1 L326 212.5 L327.7 212 L329.6 212 L330.9 212.6 L330.9 213.2 L333.2 213.7 L334.2 213.5 L335.8 212 L337.2 212.4 L337.3 213.3 L338.6 212.5 L339.6 212.6 L339.7 213.3 L340.6 212.7 L342.6 213.6 L343.9 213 L344.6 213.2 L344.5 213.7 L345.6 214.9 L345.5 216 L346.2 216.3 L346.9 217.9 L347.5 217.8 L347.9 219 L349.1 219.2 L349.3 219.7 L350.2 219.3 L350.8 219.8 L350.3 221.4 L351.6 220.3 L353.9 220.8 L355.3 220.1 L358.8 220.4 L360.9 221.5 L361.3 220.8 L365 220.9 L365.9 219.7 L366.7 219.9 L367.2 219.3 L367.9 219.5 L367.6 222.3 L369.5 223 L371.7 225.4 L373.1 225.7 L373.9 227.3 L374.3 226.3 L375.6 226.5 L375.9 225.7 L376.5 225.6 L376.2 227 L376.8 227 L377.4 225.7 L378.2 225.7 L379.2 227.2 L380 226 L380.9 227 L381.6 226.2 L383.8 227.1 L386 226.7 L387.3 228.3 L392 226.6 L393.5 228.2 L394.8 228.3 L396.2 230 L398 230 L400 231.7"></path>
  <path d="M400 46.7 L399 46.6 L397.4 48.1 L396.4 48.1 L395.4 47.3 L393.1 46.9 L392.9 46 L390.9 46.1 L390.9 45.6M390.9 45.6 L390.4 44.4 L389.9 44.4 L389.6 45.3M389.2 45 L389.3 44.1 L387.7 44.1M234.2 209.7 L234.4 210.5M234.4 210.5 L232.2 212.8 L233.9 214.1M233.9 214.1 L234.9 215.4 L234.7 216.9 L233.5 218.7 L232 219 L234 220.9 L235.7 221.1 L235.8 221.5 L235.3 223.5 L235.3 224.8 L235.9 225.7M235.9 225.7 L236.3 227.3 L237.6 228.8 L237.4 229.4 L235 232 L235.4 232.7 L238.1 234.4 L238.6 236 L238.6 239.9M238.6 239.9 L239.6 241.7 L239.2 242.8 L237.3 244.3 L235.6 244.3 L235.9 245.6 L235.4 246.5 L236.5 248.3 L236 250"></path>
  <path d="M0 189.9 L0.3 190.3 L1.2 190.2 L5.4 187.6 L5.9 187.6 L7.5 189.1 L9.2 188.6 L11 186.9 L12.6 188M12.6 188 L13.7 189.1 L17.2 188.7 L19.9 189.8 L20.2 189.1 L21.7 191 L22 192.7 L25.2 194.5 L29.6 194.7 L31.8 195.6 L32.4 194.6 L34.5 194.6 L35.8 193.8 L37.6 194.5 L39.5 194.1 L40.2 195.1 L41.5 195 L41.7 194.3 L43.5 193.8 L44.5 193.9 L46.3 195.7 L51.7 195.2M135 243 L135.9 243.4 L136.2 244.2 L137.6 243.9 L138.3 245 L139.4 245.2 L140.9 246.8 L142.1 246 L142.6 246.7 L144.7 246.8 L144.9 247.3 L144.4 248.3 L145.8 250"></path>
  <path d="M0 162.4 L0.9 162.6 L2.3 164M21.7 176.9 L22.1 176.8 L22.5 175.7 L24.5 176.6 L25 175.7 L25.9 176.7 L27.3 177.1 L27.9 178 L29.1 177.6 L30.9 178.7M2.3 164 L6.1 167 L8.3 169.5 L10 170.3 L10.7 170.1 L10.9 169.6 L11.8 169.9 L13.3 172 L14.5 172.5 L14.9 173.5 L18.3 176.2 L21.7 176.9"></path>
  <path d="M0 141.4 L5.2 141.8 L9.8 143.2 L11.5 143.1"></path>
  <path d="M249.4 13.5 L249.3 15.4 L247.7 17.6 L247.6 19.8 L246.9 20.9 L246.5 22.8 L248.4 26.3 L247.7 29.1M259.3 0 L257.2 3.8 L257 5.2 L256 7.1 L252.3 8.5 L251.3 11 L251.7 12.2 L249.4 13.5"></path>
  <path d="M386.5 69.9 L387.5 69.8 L388.8 70.7 L391.4 70.9 L393.2 71.8 L396.8 72.6 L400 72.5"></path>
  </g>

  <!-- tavak -->
  <g fill="var(--fg)">
  <path d="M108.9 148.6 L107.6 149.9 L91.5 156.9 L90.6 157.6 L89.7 158.6 L87.4 160.4 L86.5 160.8 L84 161.1 L79.6 160.2 L77.2 160.2 L75.2 160.9 L74.2 160.7 L73.6 159.6 L74.5 156.6 L76.8 156.5 L79.2 157.4 L80.3 157.1 L80.6 156 L81.5 155 L82.6 154.2 L83.6 153.9 L85.7 154.1 L86.8 154.4 L87.7 155.1 L90.6 152.9 L92.2 152 L95.2 151.6 L95.9 151.2 L97 149.4 L97.7 148.5 L98.3 148.1 L99 148 L106.2 145.1 L107.1 143.9 L107.5 144.2 L109.4 145.8 L110.2 146 L110.8 145 L110.4 143.9 L109.6 143 L108.7 142.5 L108.7 142 L114.3 138.7 L116.1 137.3 L116.8 136.4 L117.6 135.2 L118.2 133.9 L118.4 132.5 L119 132.3 L120.2 132.5 L122.7 133.4 L123.7 134 L125 135 L125.9 136.1 L125.9 137.1 L125.1 138.5 L124 140.9 L123.1 142 L120.8 143.3 L112.9 146.1 L112.5 146.1 L111.8 146 L111.5 146.3 L110.6 147.6 L108.9 148.6Z"></path>
  <path d="M48.2 67.4 L46.5 70.3 L45.5 72.3 L45.2 73.2 L44.7 75.8 L44.9 78.1 L46.1 78 L47.2 77.5 L48.3 78.7 L48.6 80 L48.3 80.8 L47.9 81.2 L47.1 80.5 L46.4 80.4 L45.1 79.8 L44.2 77.8 L43.6 75.9 L42.8 75.6 L42.9 77 L42.6 78 L42 77 L42.3 75.4 L43 74.9 L43.2 74.3 L42.7 73.7 L42.7 71.7 L43.3 69.3 L43.9 67.7 L44.2 65.2 L44.5 63.7 L45.2 62.2 L46.7 60.6 L48.6 59.8 L50.3 59.4 L51.1 60 L51 61.8 L50.5 64 L49.6 65.6 L49.1 66.4 L48.2 67.4Z"></path>
  <path d="M263.7 90 L264.6 86.8 L265.6 84.9 L266.2 84.3 L267.4 83.6 L268.6 83.6 L268.8 84.6 L268.9 85.3 L268.2 86.4 L267.4 87.5 L266.7 88.8 L265.8 89.8 L264.2 90.4 L263.7 90Z"></path>
  </g>

  <!-- folyók az országban, vastagság = vízhozam -->
  <g fill="none" stroke="var(--fg)" stroke-linecap="round" stroke-linejoin="round">
  <path stroke-width="1" d="M222.6 42.7 L221.7 42.7 L221.7 43.3 L223.7 49.5 L224.3 50.3 L226.9 50.8 L227 53.4 L221.8 54.5 L220 53.8 L219.2 55.9 L216.8 56.5 L212.2 60.1 L212 61.3 L212.9 63.4 L211.9 64.8 L211.7 69.4 L212 77 L211.6 81.8 L212.4 83.6 L213.1 90 L213.6 91.3 L216.4 93.5 L216.7 94.8 L218.5 94.8 L221.4 96.5 L223.2 96.6 L223.1 95.7 L224.6 94.3 L226.1 94.5 L227.9 94 L228.3 94.8 L228.1 96.1 L229.9 97.7 L229.3 99.6 L229.3 101.3 L231.8 102.2 L232.9 104.2 L233.1 105.6 L234.8 106.1 L234.9 107.9 L234.4 108.1 L234.1 109.3 L234.3 110.8 L234.9 111.1 L234.5 112.3 L235.1 113.6 L236.2 113.8 L236.2 114.5 L237 114.2 L237.4 115.3 L237 116.1 L237.2 116.3 L236.5 117 L237.2 117.6 L236.8 118.1 L237.5 118.2 L237.7 119.2 L240.2 120.2 L241.6 119.5 L242.3 120.4 L241.1 120.7 L241.3 122.7 L240.9 123.2"></path>
  <path stroke-width="1" d="M305 7.4 L304.6 7.4 L304.5 7.8 L305 8 L304.4 8.3 L304.7 8.5 L304.2 9.2 L304.4 9.6 L303.2 11.4 L302.4 11.6 L302.4 12 L302 11.6 L301.8 12.3 L299.1 12.8 L298.4 14.3 L298.6 15.2 L298.1 15.5 L297.7 16.6 L298.1 17.1 L297.7 18.3 L298.2 18.3 L298 18.9 L298.5 19 L298.3 21.9 L297.3 22.8 L296.9 24.5 L295.8 25.4 L296.2 26.5 L295.9 26.6 L296.1 26.8 L295.8 27.8 L290.5 32.9 L287.9 34.4 L288.4 35.1 L287.7 35.3 L287.8 35.8 L286.6 37.6 L286 37.5 L285.8 39.4 L284.8 39.9 L285 40.3 L284.3 42.8 L284.5 44.6 L283.6 47.2 L284.6 48 L284.1 48.5 L284.7 48.8 L285.1 50 L284.8 50.7 L283.9 50.7 L283.5 51.4 L283.9 51.8 L283.4 51.6 L283.2 52 L283.4 52.4 L282.9 52.3 L283.3 52.7 L283.3 54.3 L282.6 55"></path>
  <path stroke-width="1" d="M335.3 116.5 L333.5 116 L332.8 114.6 L331.8 114.1 L330.3 114.4 L330 115.3 L327.1 115.9 L324.9 118.5 L324.3 118 L323.6 118.6 L320.7 118.7 L319.8 119.7 L318.1 120.3 L317.1 120.1 L314.7 121.3 L311.9 121.6 L305.2 127.6 L302.6 130.6 L298.9 133 L297.3 134.5 L296.6 136.2 L292.4 139.1 L290.6 141.5 L289 142.5 L285.2 143.7 L281.8 142.8 L279.8 143 L276.9 141.3 L272.2 143.2 L266.3 142.1 L265 142.3 L262.9 144.5 L261 144.3 L260.5 145.4 L257.7 146.3 L254.3 144.4 L249.6 143.8 L247.9 147.2 L246.9 147.3 L245.5 149.5 L245.9 150.9 L245.6 151.3 L244.9 152.2 L243.2 152.4 L242.1 153.5 L241.7 155.8 L241.8 157 L240.7 158 L240.5 160.9"></path>
  <path stroke-width="1" d="M324 135.4 L319.8 136.5 L316.7 139.2 L306.6 139 L300.9 139.2 L300.3 139.8 L299.3 138.8 L298.3 139.1 L297.3 138.2 L293.5 138.6"></path>
  <path stroke-width="1" d="M312.2 165 L311.6 165 L310.9 162.7 L308.6 161 L304.3 162.2 L303.5 161.7 L302 162.3 L299 160 L294.9 156.5 L294.2 153.8 L293.1 152.6 L292.2 150.1 L290.8 149.4 L288.4 146.8 L288.1 145.9 L285.2 143.7"></path>
  <path stroke-width="1" d="M20.2 146.8 L23.3 148.4 L24.3 150.2 L26.3 150.2 L29.8 151.6 L33.1 150.5 L36.9 150.4 L45.1 147.7 L47.8 149.1 L51 149.8 L52.8 149.1 L53.2 147.6 L54 146.9 L56 147.1 L58.2 143.4 L59.6 142.3 L59.5 141.6 L60.7 140.4 L60.9 139.3 L62.8 139.2 L63.3 139.7 L64.1 143.4 L64.1 145.1 L65.8 150.7 L66.5 156.6 L66.6 161.6 L67.2 165.7 L69.4 167.6 L70.8 166.9 L70.9 166.1 L71.9 165.6 L73 163.8 L73.9 163.3 L74.4 161.7"></path>
  <path stroke-width="1" d="M71.8 52.5 L73.5 55.5 L73.4 57.8 L74.5 56.7 L75 56.8 L75.1 57.6 L75.6 58.4 L75.4 58.8 L74.2 58.8 L74.3 60.5 L74.7 61 L76.2 60.2 L76.4 61 L76 61.5 L76.1 62.1 L77.3 62.5 L77 63 L77.9 63.8 L77.3 64.5 L76.1 64.5 L75.7 65.3 L75.9 67.2 L77.3 66.1 L77.7 66.5 L77.7 67 L76.5 67.7 L76.6 68.1 L78.1 67.7 L78.3 66.8 L78.7 66.6 L79.5 67.6 L80.9 67.3 L80.9 68 L79.3 68.4 L78.8 69.1 L79.2 69.5 L80.1 69.3 L80.4 68.7 L82.4 68.6 L82.7 69.2 L82.8 70.9 L83.2 71.1 L83.8 70.9 L84.9 68.9 L85.5 69 L86 69.6 L86.1 70.5 L88.8 71.4 L88.7 72.1 L86.3 72.2 L86.1 73 L87.7 74.2 L89.9 73.7 L91.1 75 L90.1 75.5 L90.2 76.2 L92.3 76.1 L92.4 77 L91.8 78.1 L94.2 78.5 L95.1 78.1 L95.4 78.6 L95 79.8 L97.2 78.9 L98.1 76.9 L104.6 76"></path>
  <path stroke-width="1" d="M164.2 69.3 L164.7 68.4 L163.3 67.9 L163 66.5 L159.7 64.8 L159.3 60.5 L160.3 59.3 L160.1 58.1 L160.4 57.8 L159.2 56.1 L159.7 55.2 L161.9 55.1 L162.6 54.5 L162.7 52.1 L163.1 51.7 L162.8 50.9 L163.5 50 L165.9 50 L166.5 49.8 L166.7 49.1"></path>
  <path stroke-width="1.2" d="M18 141.7 L18.1 141.6M18.1 141.6 L20.8 141.1 L24.1 141.5 L25.5 141.2 L27.7 141.3 L27.8 141.8 L29.5 142.1 L31.6 141 L32 139.4 L33.3 138.3 L40.2 136 L42.4 133.1 L44 132.7 L44.6 131.8 L45.8 132 L46.8 130.9 L48.8 130.4 L49.3 129.6 L50.6 129.1 L51.5 126.6 L53 124.7 L53.5 123.2 L53.6 121.5 L54.4 119.7 L56 117.8 L57 117.5 L57.3 116.2 L58 115.4 L58.2 112.3 L61.3 107.3 L62.2 104.9 L63.5 103.7 L65.4 103.5 L67.2 102.5 L67.5 101.7 L68.5 101.1 L71.9 100.7 L73.3 101.4 L76.8 101.7 L78.2 101 L79.7 101.2 L81.7 98.9 L81.8 97.2 L82.7 94.8 L82.7 92M11.5 143.1 L18.1 141.6M82.7 92 L85 87.9 L86.9 86.3 L94 83.2 L95.8 80.2 L97.8 78.8 L98.4 77.1 L104.4 75.9"></path>
  <path stroke-width="1.2" d="M119.2 144.9 L120.3 146 L121.9 146.2 L124 147 L125.7 147.6 L127.5 147.7 L131.6 150.2 L131.8 151.4 L134.2 152.8 L134.6 154.6 L138.1 156.5 L139.4 157.8 L141.9 158.7 L143.2 159.1 L143.4 159.4 L147.5 158.1 L149.8 158.4 L150.9 160 L152 162.1 L151.8 164.6 L151 169.6 L150.5 171.9 L150 173.2 L150.5 178.2 L152.9 180.7 L153.5 181.4 L153.8 183.3 L153 185.1 L152 187.5 L153.1 188.4 L157.2 188.9 L159.4 190.5 L160.8 192 L162.7 192.5 L163.4 191.2 L163.9 191 L164.3 191.7 L164.4 193 L165.4 194 L165 194.9 L166.4 195.3 L167 196.3 L166.4 197.2 L166.6 197.6 L168.5 198.2"></path>
  <path stroke-width="1.4" d="M289.1 56.7 L289.3 55.6 L291 56.8 L290.7 57.6 L291.1 58.6 L292.6 58.6M282.7 54 L282.5 54.3 L283.4 56.6 L284.3 56.8 L284.5 57.5 L285.6 58 L286.9 57.5 L288.5 57.9 L287.9 57.2 L289 57.3 L289.1 56.7M278.3 46 L278.8 46.5 L278.6 47.2 L279.3 47.7 L279.1 48.1 L279.8 48.4 L280.8 51.1 L282.7 54M276.4 44.8 L278.3 46M266.1 31.8 L268.8 33.5 L269.5 35 L271.6 35.6 L273.8 37M247.7 29.1 L248 30.1M273.8 37 L275 39.2 L274.8 40.6 L276.2 41.9 L276 42.8 L276.4 44.8M248 30.1 L249.6 30.7 L250.4 30.3 L252.3 31.2 L254.4 31.2 L255.7 30.6 L258.7 30.9 L259 31.4 L263.1 30.8 L266.1 31.8"></path>
  <path stroke-width="1.6" d="M363.2 44.6 L363.3 45.4 L364.1 46.1 L363.4 46.8M363.4 46.8 L364.8 49.2 L365.6 49.6 L366.7 51.8 L373.8 59.9 L374.8 59.9 L380 63.2 L381.9 66 L382.9 66.1 L382.9 67.3 L383.8 68.5M383.8 68.5 L384.4 69.5 L386.5 69.9"></path>
  <path stroke-width="1.7" d="M30.9 178.7 L31 179.2M31 179.4 L32 179.7 L32.1 180.6M32.6 180.9 L35.3 181.9 L37.9 181.7M37.9 181.7 L41.2 182.7 L40.6 183.4 L41.6 183.7 L44.1 188.1 L45.1 187.2 L45.4 188.4 L46 188.4 L46.5 189.2 L46.8 188.6 L47.4 189.1 L48.4 188.5 L52.2 191.2 L52.1 191.9 L53.4 192.8 L52.9 193 L52.8 193.8 L53.3 196"></path>
  <path stroke-width="1.8" d="M241.1 199.2 L241.9 200.1 L243.4 200.4 L248.7 200.1 L249.8 201.4 L251 201.2 L251.6 202 L255.7 203.3M255.7 203.3 L261.7 205.9 L264.7 208.4M264.7 208.4 L265.7 209.2 L266.5 209.2 L267.4 207.9 L268.9 208 L270.1 206.7 L270.6 207.8"></path>
  <path stroke-width="2.5" d="M51.7 195.2 L53.3 196M53.3 196 L53.5 196.9 L55.3 199.1 L56.1 199.3 L56.3 200.7 L57.4 201.7 L57.8 203.6 L59.6 203.4 L60.3 205.4 L61.2 205.8 L62.2 207.9 L63.3 208.2 L64 209.5 L67.4 211.4 L68.2 211 L69.3 211.4 L71.3 210.5 L72.1 210.7 L72.6 212.9 L74.1 214.8 L75.7 220.2 L77.9 220 L77.7 220.9 L76.3 221.4 L76.2 221.9 L77.4 222.8 L77.6 223.7 L79.7 222.8 L79.1 224.9 L79.6 225.6 L82.1 224.5 L83 225.8 L84.8 224.4 L91.7 225.5 L94.7 227.7 L96.1 229.7 L96.9 232.9 L97.4 233.5 L102.1 234.7 L102.7 235.4 L104.8 235.8 L105.5 236.5 L106.5 236.1 L108.7 239.5 L110.6 237.6 L116.4 237.6 L117.4 238.9 L120.7 240.1 L122.3 239.9 L123.6 238.4 L125.1 238.3 L125.9 239.2 L127.5 238.5 L131.9 241.1 L134 243.1 L134.7 243.1 L135 243"></path>
  <path stroke-width="2.9" d="M241.1 199.2 L239.3 198.9 L238.5 199.4M241.1 199.2 L243.5 196.6 L243.9 195.3 L243.6 194.4 L242.6 193.7 L242.4 192.7M389.6 45.3 L389.2 45M387.7 44.1 L387.2 44.8 L386.1 44.2 L384.8 44.3 L381.8 46.4 L379.1 45.4 L378.1 46.4 L376.9 45.6 L376.5 46.3 L375.9 46.3 L375.8 47.6 L375.3 48.1 L372.7 49 L370.9 48.3 L370.4 49.1 L369.2 48 L367.1 48.2 L364.4 44.9 L364 44.4 L363.2 44.6 L362.7 43.4 L361.7 42.3 L362 39.3 L361.1 39.3 L359.4 37.9 L359.6 36.7 L359.2 36 L359.9 33.9 L359 33.2 L358.6 31.7 L357.4 32.3 L356.9 31.8 L358.1 30.2 L358.1 29 L357.4 27.8 L358.7 25.5 L357.4 24.4 L358.8 23.6 L357.4 21.6 L359.1 20 L356.2 18.9 L355.2 18.9 L353.1 20.2 L350.8 22.1 L349.7 23.7 L349.6 25 L348.2 26.8 L348.4 28.2 L347.5 27.5 L347.2 29 L346.3 28.1 L343.9 28.7 L340.5 32.8 L339.1 34.3 L338.1 33.9 L336.6 34.6 L335.3 34.3 L334.1 35.4 L332.8 35.5 L331.6 37.2 L330.7 36.9 L329.3 37.4 L328.1 38.8 L324.2 40.4 L321.1 38.4 L316.4 39.5 L314.2 39.4 L312.6 40.8 L311.8 41.4 L310.4 44.1 L310.6 44.9 L312.3 46.7 L311.3 47.2 L311.7 49.2 L311.5 50.5 L310.2 50.1 L310.2 51.4 L307.6 51.5 L305.7 52.2 L302.9 51.4 L301.6 50.3 L301.6 49.4 L299.7 50.7 L299.7 51.4 L299.3 52.1 L296.3 52.2 L294.5 53.8 L292.6 58.6 L292.5 59.3 L291.2 60.6 L289.7 61.9 L289.7 63.9 L289.8 64.7 L289.1 66.3 L289.6 67.7 L287.5 68.6 L287.3 69.2 L288.3 70.4 L288.5 71.9 L286.3 71.8 L285.7 72.7 L284.5 73.2 L285 75.3 L283.8 76.8 L282.4 79.2 L279 81 L275.9 81.1 L275.4 81 L273.2 83.9 L271.8 85 L270.4 86.3 L270.6 87.3 L270.1 89.7 L268.4 90.7 L267.4 92 L264.4 93.2 L263.8 94.4 L264.3 96 L263 97.4 L259.4 97 L257.7 98.7 L256 98.9 L255.4 99.8 L255.1 100.6 L253.8 101.8 L251.4 102.5 L251.2 104.1 L253.6 104 L254.2 104.5 L254.7 105.1 L254.5 106.3 L255.1 109.3 L256.8 111.1 L256.8 111.5 L256.2 114 L254.8 115.3 L252.2 115.9 L250.9 114.8 L250 114.9 L249.1 116.1 L246.9 117.6 L246.3 119 L246.4 121.3 L244.2 122.1 L243.8 122.7 L241.1 122.8 L240.3 123.5 L239.1 127.1 L240.2 126.9 L240.7 127.4 L240.8 128.9 L240.2 130.8 L241 132.1 L241.1 133.8 L242.1 134 L243 133.2 L244.1 133 L245.8 133.7 L246.1 134.8 L245.3 134.9 L243.2 135 L242.1 136.3 L237.3 138.3 L237.1 140.3 L236.4 140.5 L235.7 141.5 L235.9 141.9 L236.7 141.8 L238.2 141.9 L238.6 142.6 L238.6 143.8 L234.3 147.5 L233.8 146.7 L233 147 L232.1 149 L231.9 150.4 L233.1 152.5 L233.6 154.4 L234.5 155 L235.1 156.8 L236.1 158.4 L237.5 159.2 L237.8 160.2 L238.7 160.9 L240.5 160.6 L241.1 163 L242.4 164.4 L240.7 165.9 L239.1 171.3 L237.8 171.8 L237.9 173.4 L239.3 174.9 L239.2 176.3 L239.8 177.3 L241.5 181.7 L240.5 186.5 L241.4 187.3 L241.5 189.2 L240.9 190.8 L242.4 191.4 L242.4 192.7M238.5 199.4 L233.6 208 L233.5 209.2 L234.2 209.7"></path>
  <path stroke-width="4.2" d="M155.9 220.4 L160.2 224.2 L160.6 225.8 L163.4 228.5 L163.6 229.9M171.3 72.1 L171.8 70.6 L172.6 69.6 L174.6 68.7 L176 68.9 L178 69.6 L178.8 71.2 L179.7 71.9 L180.5 74.7 L180.5 78.2 L179.6 83.8 L177.2 88.9 L176.9 90.8 L175.5 94.6 L175.7 95.8 L177.1 98.6 L176.2 100.5 L175.2 104.5 L174.7 105 L171.5 105.7 L170.3 107.7 L170.6 109.2 L168.6 113.1 L168.8 114.6 L168.1 118.2 L166.6 120.9 L166.1 123.9 L166.4 126.7 L167.4 130.8 L171.1 134 L171.7 135.4 L171.9 136.7 L170.8 138.2 L171.7 141.7 L171.7 144.2 L169.3 149.6 L170.8 152.7 L171.5 155.4 L172.6 157 L172.7 159 L173.4 160 L173.8 162.4 L173.4 164.4 L171.3 167.1 L168.8 168 L166.9 168 L165.8 170.5 L165.9 171.4 L167.1 172.6 L167.4 173.7 L167.9 178.4 L168.9 180.4 L169.1 181.6 L168.5 184.6 L167.7 185.5 L167 187.6 L167.7 192.6 L169.2 195.3 L168.5 197.4 L168.3 202.5 L169.2 204.7 L169.1 205.5 L168.1 206.7 L165.4 206.7 L164.5 207.6 L164.8 207.9 L162.7 211 L160 213.3 L159.5 215.8 L156 218.3 L155.5 219.5 L155.9 220.4M73.4 51.5 L74.8 54.4 L77.5 54.9 L79.2 56.3 L79.7 55.9 L78.8 54.8 L79.2 54.9 L81.7 56.2 L83.3 58.3 L84.7 58.9M86 60.6 L86.9 62.5 L87.6 62.6 L87.6 63.3 L89.4 63.2 L89.4 64.7 L91.2 66.6 L91.5 68.1 L92.6 69.1 L94.6 69.1 L97.2 71.2 L99.2 72 L100.8 74.8 L104.4 75.9 L108.5 75.5 L110.9 75.9 L112 74.8 L114.4 74.3 L117 75.2 L118.1 74.5 L121.9 74.1 L126.4 75.7 L133.7 76.5 L140.2 74.8 L142.2 73.8 L143.5 73.9 L144.3 74.8 L146.1 74.6 L148.4 73.3 L150.2 73.5 L151.2 74.3 L154.1 74.2 L157.8 71.8 L158.1 70 L158.8 69.5 L158.5 69.3 L161.9 68.9 L167.9 70.5 L168.2 72.1 L169 73.5 L170 73.6 L171.3 72.1"></path>
  </g>

  <!-- nevek -->
  <g font-size="12" stroke="var(--bg)" stroke-width="3.5" stroke-linejoin="round" style="paint-order: stroke fill;">
  <text x="160" y="128" text-anchor="end" fill="var(--fg)" font-weight="700" font-size="14">Duna</text>
  <text x="233" y="188" text-anchor="end" fill="var(--fg)" font-weight="700" font-size="14">Tisza</text>
  <text x="100" y="250" text-anchor="middle" fill="var(--fg)" font-weight="600">Dráva</text>
  <text x="44" y="178" text-anchor="end" fill="var(--fg)">Mura</text>
  <text x="63" y="114" fill="var(--fg)">Rába</text>
  <text x="100" y="90" fill="var(--fg)">Mosoni-Duna</text>
  <text x="156" y="52" text-anchor="end" fill="var(--fg)">Ipoly</text>
  <text x="216" y="72" fill="var(--fg)">Zagyva</text>
  <text x="263" y="46" text-anchor="end" fill="var(--fg)">Sajó</text>
  <text x="300" y="24" fill="var(--fg)">Hernád</text>
  <text x="368" y="68" text-anchor="end" fill="var(--fg)">Szamos</text>
  <text x="262" y="136" fill="var(--fg)">Körösök</text>
  <text x="252" y="196" fill="var(--fg)">Maros</text>
  <text x="146" y="178" text-anchor="end" fill="var(--fg)">Sió</text>
  <text x="62" y="168" text-anchor="end" fill="var(--fg)">Zala</text>
  <text x="100" y="128" text-anchor="middle" fill="var(--muted)">Balaton</text>
  </g>
`;

// ---- 2b. Folyók: önálló lista, kattintható állomások ----
//
// Minden sor koppintásra nyit/csuk, és csak ELSŐ nyitáskor rajzolja fel a
// grafikonját (nem mindegyiket előre, ha a felhasználó sosem nyitja ki).
// A grafikon a hydroinfo.hu 6 napos előrejelzését (ingyen jön a már
// amúgy is lekért táblából) és a soil-moisture-mapper saját historikus
// naplójából visszaolvasott korábbi vízállást (history.jsonl, ld. a
// rivers-snapshot station.history mezőjét) köti össze egy közös
// grafikonon, "most" elválasztóval.
function buildRiverList(container, stations) {
  container.innerHTML = "";
  for (const station of stations) {
    const row = document.createElement("div");
    row.className = "water-river-row";
    const head = document.createElement("div");
    head.className = "water-river-row-head";
    head.innerHTML =
      `<span class="water-river-name">${station.river} · ${station.name}</span>` +
      `<span class="water-river-level">${waterNum(station.level_cm, 0)} cm</span>`;
    const chartWrap = document.createElement("div");
    chartWrap.className = "water-river-chart-wrap";
    const chartSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chartSvg.setAttribute("viewBox", "0 0 400 110");
    chartSvg.setAttribute("preserveAspectRatio", "none");
    chartWrap.appendChild(chartSvg);

    let built = false;
    head.addEventListener("click", () => {
      row.classList.toggle("open");
      if (row.classList.contains("open") && !built) {
        renderRiverChart(chartSvg, station);
        built = true;
      }
    });

    row.appendChild(head);
    row.appendChild(chartWrap);
    container.appendChild(row);
  }
}

function renderRiverChart(svgEl, station) {
  const historyVals = (station.history || []).map(h => h.level_cm);
  const forecastVals = station.forecast_cm || [];
  const series = [...historyVals, station.level_cm, ...forecastVals];
  const todayIdx = historyVals.length;

  if (series.length < 2) {
    svgEl.innerHTML = `<text x="10" y="55" font-size="12" fill="var(--muted)">még nincs elég adat a grafikonhoz</text>`;
    return;
  }

  const minV = Math.min(...series), maxV = Math.max(...series);
  const span = Math.max(maxV - minV, 1);
  const padX = 8, padY = 14, w = 400 - padX * 2, h = 110 - padY * 2 - 12;
  const xFor = i => padX + (i / (series.length - 1)) * w;
  const yFor = v => padY + h - ((v - minV) / span) * h;

  const pastPoints = series.slice(0, todayIdx + 1).map((v, i) => `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`);
  const futurePoints = series.slice(todayIdx).map((v, i) => `${xFor(todayIdx + i).toFixed(1)},${yFor(v).toFixed(1)}`);
  const todayX = xFor(todayIdx).toFixed(1);

  let dots = "";
  for (let i = 0; i < series.length; i++) {
    dots += `<circle cx="${xFor(i).toFixed(1)}" cy="${yFor(series[i]).toFixed(1)}" r="1.5" fill="var(--muted)"></circle>`;
  }

  svgEl.innerHTML = `
    <line x1="${todayX}" y1="${padY}" x2="${todayX}" y2="${(padY + h).toFixed(1)}" stroke="var(--border)" stroke-width="1"></line>
    <text x="${todayX}" y="${(padY - 3).toFixed(1)}" font-size="10" fill="var(--muted)" text-anchor="middle">most</text>
    <polyline points="${pastPoints.join(" ")}" fill="none" stroke="var(--fg)" stroke-width="1.5"></polyline>
    <polyline points="${futurePoints.join(" ")}" fill="none" stroke="var(--fg)" stroke-width="1.5" stroke-dasharray="3 3"></polyline>
    ${dots}
    <circle cx="${todayX}" cy="${yFor(station.level_cm).toFixed(1)}" r="2.5" fill="var(--fg)"></circle>
    <text x="${padX}" y="${(padY + h + 12).toFixed(1)}" font-size="10" fill="var(--muted)">${historyVals.length > 0 ? "múlt" : ""}</text>
    <text x="${(padX + w).toFixed(1)}" y="${(padY + h + 12).toFixed(1)}" font-size="10" fill="var(--muted)" text-anchor="end">6 napos előrejelzés</text>`;
}

// ---- 2d. Csatornák: önálló térkép (a felhasználó kérése szerint "külön" a
// dombormű-/folyóhálózat-térképektől), a nevesített csatornák, belvíz-
// elvezetők és árkok valódi futásával. A geometria a soil-moisture-mapper
// otthoni gépen futó app/channels.py-ból jön (ld. onnan a docstringet):
// Geofabrik OSM-kivonat, csak NEVESÍTETT vízfolyások (minden vízfolyás
// ~190KB gzipelve lenne egy háttér-rajzolathoz, a nevesítettek ~32KB) -
// a fejsoron és a hossz-táblán viszont a VALÓDI, minddel számolt
// darabszám/hossz szerepel, nem csak a berajzolt rész. Nem élő adat: a
// hálózat geometriája ritkán változik, a home-job alkalmanként, kézzel
// frissíti, nem az óránkénti ciklus része (ellentétben a talaj-/folyó-/
// tó-pillanatképekkel) - ezért ennek a lekérése is a többitől FÜGGETLEN
// try/catch-ben történik lent, hogy egy még hiányzó csatorna-pillanatkép
// ne dönthesse el a már működő szakaszokat.
function channelsProject(lon, lat, bounds, width, height) {
  return {
    x: ((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * width,
    y: ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * height,
  };
}

function channelsRingsToPath(rings, bounds, width, height) {
  let d = "";
  for (const ring of rings) {
    ring.forEach(([lon, lat], i) => {
      const { x, y } = channelsProject(lon, lat, bounds, width, height);
      d += `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    });
  }
  return d;
}

// borderRings tartalmazza a VILÁG összes országhatárát (a radar azimutális
// vetítése ezt sugár-korlátozva, magától "levágja" - ld. radarMaxRadiusKm),
// ezért itt, lapos vetítésnél, csak a bounds-on (+margó) BELÜLI pontokat
// vesszük figyelembe, és egy határon kívüli pontnál új "M"-mel kezdünk új
// darabot (ugyanaz a trükk, mint buildReliefMap waterGeoPath-jában) -
// különben egy másik ország határvonala az egész vásznat behálózná.
function channelsBorderPath(rings, bounds, width, height, marginDeg) {
  const inBounds = (lon, lat) =>
    lon >= bounds.minLon - marginDeg && lon <= bounds.maxLon + marginDeg &&
    lat >= bounds.minLat - marginDeg && lat <= bounds.maxLat + marginDeg;
  let d = "";
  for (const ring of rings) {
    let connected = false;
    for (const [lon, lat] of ring) {
      if (!inBounds(lon, lat)) { connected = false; continue; }
      const { x, y } = channelsProject(lon, lat, bounds, width, height);
      d += `${connected ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
      connected = true;
    }
  }
  return d;
}

function buildChannelsMap(svgEl, legendEl, channelsSnapshot) {
  const WIDTH = 400;
  const HEIGHT = 250;
  const PAD_DEG = 0.15;

  const canalRings = decodeDeltaRings(channelsSnapshot.geo.canal || []);
  const drainRings = decodeDeltaRings(channelsSnapshot.geo.drain || []);
  const ditchRings = decodeDeltaRings(channelsSnapshot.geo.ditch || []);

  // A méretarány-doboz MINDIG a csatornák saját kiterjedéséből jön (azok
  // garantáltan Magyarországon belül vannak) - a világ-körvonalakból
  // (borderRings) sosem, mert azok kiterjedése az egész Föld.
  const geoPoints = [...canalRings, ...drainRings, ...ditchRings].flat();
  if (!geoPoints.length) {
    svgEl.innerHTML = "";
    legendEl.textContent = "";
    return;
  }
  const lons = geoPoints.map(p => p[0]);
  const lats = geoPoints.map(p => p[1]);
  const bounds = {
    minLon: Math.min(...lons) - PAD_DEG,
    maxLon: Math.max(...lons) + PAD_DEG,
    minLat: Math.min(...lats) - PAD_DEG,
    maxLat: Math.max(...lats) + PAD_DEG,
  };

  let markup = "";
  if (borderRings && borderRings.length) {
    const borderD = channelsBorderPath(borderRings, bounds, WIDTH, HEIGHT, PAD_DEG);
    if (borderD) markup += `<path class="water-channel-border" d="${borderD}"></path>`;
  }
  // Legalul a legapróbb/legsűrűbb (árok), legfelül a csatorna, hogy a
  // ritkább, de "fontosabb" vízfolyások ne tűnjenek el a sűrű árokrajzban.
  if (ditchRings.length) markup += `<path class="water-channel-ditch" d="${channelsRingsToPath(ditchRings, bounds, WIDTH, HEIGHT)}"></path>`;
  if (drainRings.length) markup += `<path class="water-channel-drain" d="${channelsRingsToPath(drainRings, bounds, WIDTH, HEIGHT)}"></path>`;
  if (canalRings.length) markup += `<path class="water-channel-canal" d="${channelsRingsToPath(canalRings, bounds, WIDTH, HEIGHT)}"></path>`;

  svgEl.innerHTML = markup;
  legendEl.textContent = "Tömör vonal: csatorna. Vékony, halvány vonal: belvízelvezető. Pontozott vonal: árok. Csak a nevesített vízfolyások.";
}

// ---- 3. Személyes: a keresett helyszín talajminta-profilja ----
//
// Mélység-arányos (nem liter-arányos) talajminta-ábra: a sávok tényleges
// vastagsága (0-1, 1-3, 3-9, 9-27, 27-81 cm) adja a magasságot, a
// vonalkázás-sűrűség a víz%-ot. Nincs liter-összeg kiírva (az területhez
// kötött, egy tetszőleges ponthoz nincs értelmes "cella-terület"), csak a
// víztartalom-arány és egy országos átlaghoz mért összevetés.
async function fetchUserSoilProfile(point) {
  const vars = "soil_moisture_0_to_1cm,soil_moisture_1_to_3cm,soil_moisture_3_to_9cm,soil_moisture_9_to_27cm,soil_moisture_27_to_81cm";
  const data = await openMeteo(
    `${API_BASE}?latitude=${coord(point.lat)}&longitude=${coord(point.lon)}&hourly=${vars}&forecast_days=1&timezone=UTC`
  );
  const times = data.hourly.time;
  const now = Date.now();
  let bestIdx = 0, bestDiff = Infinity;
  times.forEach((t, i) => {
    const diff = Math.abs(new Date(`${t}:00Z`).getTime() - now);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  });
  return WATER_DEPTH_BANDS.map(([lo, hi], i) => {
    const key = `soil_moisture_${lo}_to_${hi}cm`;
    return data.hourly[key][bestIdx];
  });
}

function waterCountryAvgMoisture(soilSnapshot) {
  const areaM2 = soilSnapshot.country_area_km2 * 1e6;
  return soilSnapshot.country_total_by_depth.map((liters, i) => {
    const thicknessM = WATER_DEPTH_BANDS[i][2];
    return liters / (areaM2 * thicknessM * 1000);
  });
}

function waterWeightedAvg(moistureByDepth) {
  const thicknesses = WATER_DEPTH_BANDS.map(b => b[2]);
  const totalThickness = thicknesses.reduce((a, b) => a + b, 0);
  const weighted = moistureByDepth.reduce((sum, m, i) => sum + m * thicknesses[i], 0);
  return weighted / totalThickness;
}

function renderSoilCoreProfile(svgEl, moistureByDepth) {
  const totalDepth = 81;
  const plotTop = 16, plotHeight = 324;
  let y = plotTop;
  const boxes = WATER_DEPTH_BANDS.map(([lo, hi]) => {
    const h = ((hi - lo) / totalDepth) * plotHeight;
    const box = { lo, hi, y, h };
    y += h;
    return box;
  });

  const rects = boxes.map((box, i) => {
    const hatch = waterHatchIndex(moistureByDepth[i]);
    return `<rect x="60" y="${box.y.toFixed(1)}" width="55" height="${box.h.toFixed(1)}" fill="url(#wh${hatch})" stroke="var(--fg)" stroke-width="1"></rect>`;
  }).join("");

  const ticks = [0, 9, 27, 81].map(cm => {
    const yy = plotTop + (cm / totalDepth) * plotHeight;
    return `<line x1="52" y1="${yy.toFixed(1)}" x2="58" y2="${yy.toFixed(1)}" stroke="var(--muted)" stroke-width="1"></line>
      <text x="48" y="${(yy + 4).toFixed(1)}" font-size="13" fill="var(--muted)" text-anchor="end">${cm} cm</text>`;
  }).join("");

  // A felső rétegek (0-1, 1-3 cm) olyan vékonyak a valódi mélységarányos
  // rajzon, hogy a középpontjukhoz igazított két soros felirat (cím + %)
  // átlapolná egymást. A dobozok y-pozíciója marad valódi arányos, de a
  // feliratoké lentről-fentről eltolható, legalább MIN_LABEL_GAP távolságra
  // egymástól, vezetővonallal kötve vissza a doboz tényleges közepéhez.
  const MIN_LABEL_GAP = 36;
  let prevLabelY = -Infinity;
  const labelYs = boxes.map(box => {
    const trueMid = box.y + box.h / 2;
    const y = Math.max(trueMid, prevLabelY + MIN_LABEL_GAP);
    prevLabelY = y;
    return y;
  });

  const leaders = boxes.map((box, i) => {
    const trueMid = box.y + box.h / 2;
    const labelY = labelYs[i];
    return Math.abs(labelY - trueMid) < 0.5
      ? `<polyline points="130,${trueMid.toFixed(1)} 150,${trueMid.toFixed(1)}"></polyline>`
      : `<polyline points="130,${trueMid.toFixed(1)} 138,${trueMid.toFixed(1)} 150,${labelY.toFixed(1)}"></polyline>`;
  }).join("");

  const labels = boxes.map((box, i) => {
    const labelY = labelYs[i];
    const pct = Math.round(moistureByDepth[i] * 100);
    return `<text x="156" y="${(labelY - 3).toFixed(1)}" font-size="14" fill="var(--fg)" font-weight="600">${box.lo}–${box.hi} cm</text>
      <text x="156" y="${(labelY + 14).toFixed(1)}" font-size="14" fill="var(--muted)">${pct}% víz</text>`;
  }).join("");

  svgEl.innerHTML = `<defs>${waterHatchDefs()}</defs>${rects}${ticks}<g stroke="var(--fg)" stroke-width="0.75" fill="none">${leaders}</g>${labels}`;
}

// ---- 4. Vízmérleg (sokéves átlag) + "hány Balaton" ----
//
// A fő összegek ellenőrzött, sokéves országos átlagok (MEK, ICPDR, Vízügyi
// Közlemények - ld. a honlap "honnan vannak a számok?" szövegét), NEM napi
// adat - ez statikus marad, csak a "talajban most" szám él.
const WATER_SANKEY_SVG = `
  <defs>
    <pattern id="wsk-air" width="4.5" height="4.5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="4.5" height="4.5" fill="var(--bg)"></rect>
      <line x1="2.25" y1="0" x2="2.25" y2="4.5" stroke="var(--fg)" stroke-width="1.2" stroke-opacity="0.45"></line>
    </pattern>
  </defs>
  <g fill="var(--fg)" fill-opacity="0.24">
    <path d="M154 20C208 20 208 72.5 262 72.5V194.5C208 194.5 208 142 154 142Z"></path>
    <path d="M154 208.8C208 208.8 208 235.4 262 235.4V248.1C208 248.1 208 221.6 154 221.6Z"></path>
    <path d="M154 247.7C208 247.7 208 255.5 262 255.5V262.5C208 262.5 208 254.7 154 254.7Z"></path>
    <path d="M154 284.2C208 284.2 208 268.6 262 268.6V274.7C208 274.7 208 290.2 154 290.2Z"></path>
    <path d="M154 320.7C208 320.7 208 284.2 262 284.2V289.1C208 289.1 208 325.7 154 325.7Z"></path>
    <path d="M378 72.5C432 72.5 432 48.5 486 48.5V181.5C432 181.5 432 205.5 378 205.5Z"></path>
    <path d="M378 259.7C432 259.7 432 267.7 486 267.7V308.5C432 308.5 432 300.5 378 300.5Z"></path>
  </g>
  <g fill="var(--fg)" fill-opacity="0.14">
    <path d="M154 154C208 154 208 194.5 262 194.5V235.4C208 235.4 208 194.8 154 194.8Z"></path>
    <path d="M154 229.5C208 229.5 208 248.1 262 248.1V255.5C208 255.5 208 236.9 154 236.9Z"></path>
    <path d="M154 266.2C208 266.2 208 262.5 262 262.5V268.6C208 268.6 208 272.2 154 272.2Z"></path>
    <path d="M154 300.4C208 300.4 208 274.7 262 274.7V284.2C208 284.2 208 309.9 154 309.9Z"></path>
    <path d="M378 205.5C432 205.5 432 197.5 486 197.5V251.7C432 251.7 432 259.7 378 259.7Z"></path>
  </g>
  <path d="M154 341.7C208 341.7 208 289.1 262 289.1V399.3C208 399.3 208 451.9 154 451.9Z" fill="url(#wsk-air)"></path>
  <path d="M378 300.5C432 300.5 432 324.5 486 324.5V423.3C432 423.3 432 399.3 378 399.3Z" fill="url(#wsk-air)"></path>
  <g fill="var(--fg)">
    <rect x="148" y="20" width="6" height="122"></rect>
    <rect x="148" y="154" width="6" height="40.9"></rect>
    <rect x="148" y="208.8" width="6" height="12.7"></rect>
    <rect x="148" y="229.5" width="6" height="7.4"></rect>
    <rect x="148" y="247.7" width="6" height="7"></rect>
    <rect x="148" y="266.2" width="6" height="6.1"></rect>
    <rect x="148" y="284.2" width="6" height="6.1"></rect>
    <rect x="148" y="300.4" width="6" height="9.5"></rect>
    <rect x="148" y="320.7" width="6" height="4.9"></rect>
    <rect x="486" y="48.5" width="6" height="133"></rect>
    <rect x="486" y="197.5" width="6" height="54.1"></rect>
    <rect x="486" y="267.7" width="6" height="40.9"></rect>
  </g>
  <g stroke="var(--fg)" stroke-width="1">
    <rect x="148.5" y="342.2" width="5" height="109.2" fill="url(#wsk-air)"></rect>
    <rect x="486.5" y="325" width="5" height="97.8" fill="url(#wsk-air)"></rect>
  </g>
  <rect x="262" y="72.5" width="116" height="326.8" rx="4" fill="var(--bg)" stroke="var(--fg)" stroke-width="1"></rect>
  <g text-anchor="middle">
    <text x="320" y="200" font-size="13" fill="var(--muted)">Magyarország</text>
    <text x="320" y="224" font-size="20" font-weight="700" fill="var(--fg)">172 km³</text>
    <text x="320" y="242" font-size="13" fill="var(--muted)">egy év alatt</text>
    <text x="320" y="278" font-size="12" fill="var(--muted)">a talajban most</text>
    <text x="320" y="294" font-size="13" font-weight="600" fill="var(--fg)" id="water-sankey-soil-now">…</text>
  </g>
  <g font-size="13" text-anchor="end">
    <text x="140" y="77" fill="var(--fg)" font-weight="600">64,2 km³</text>
    <text x="140" y="93" fill="var(--muted)">Duna</text>
    <text x="140" y="171" fill="var(--fg)" font-weight="600">21,5 km³</text>
    <text x="140" y="187" fill="var(--muted)">Dráva, a Murával</text>
    <text x="140" y="219" fill="var(--muted)">Tisza, Tiszabecs · 6,7</text>
    <text x="140" y="237" fill="var(--muted)">Szamos · 3,9</text>
    <text x="140" y="255" fill="var(--muted)">Bodrog · 3,7</text>
    <text x="140" y="273" fill="var(--muted)">Sajó és Hernád · 3,2</text>
    <text x="140" y="291" fill="var(--muted)">Körösök · 3,2</text>
    <text x="140" y="309" fill="var(--muted)">Maros · 5,0</text>
    <text x="140" y="327" fill="var(--muted)">többi folyó · 2,6</text>
    <text x="140" y="393" fill="var(--fg)" font-weight="600">58,0 km³</text>
    <text x="140" y="409" fill="var(--muted)">eső és hó</text>
  </g>
  <g font-size="13">
    <text x="500" y="111" fill="var(--fg)" font-weight="600">70,0 km³</text>
    <text x="500" y="127" fill="var(--muted)">Duna, Mohácsnál</text>
    <text x="500" y="221" fill="var(--fg)" font-weight="600">28,5 km³</text>
    <text x="500" y="237" fill="var(--muted)">Tisza, Szegednél</text>
    <text x="500" y="284" fill="var(--fg)" font-weight="600">21,5 km³</text>
    <text x="500" y="300" fill="var(--muted)">Dráva, a határon</text>
    <text x="500" y="370" fill="var(--fg)" font-weight="600">52,0 km³</text>
    <text x="500" y="386" fill="var(--muted)">párolgás</text>
    <text x="500" y="402" fill="var(--muted)">talaj, növények, tavak</text>
  </g>
  <g font-size="12" fill="var(--muted)">
    <text x="148" y="466">be: 172 km³</text>
    <text x="492" y="466" text-anchor="end">ki: 172 km³</text>
  </g>`;

function waterBalatonTilesSvg(count) {
  const tileW = 40, tileH = 24, rowCount = 600 / tileW; // 15 csempe/sor
  const fullRows = Math.floor(count / rowCount);
  const remainder = count - fullRows * rowCount;
  const fullHeight = fullRows * tileH;
  const remWidth = remainder * tileW;
  let markup = `<defs><pattern id="wbal-tile" width="${tileW}" height="${tileH}" patternUnits="userSpaceOnUse"><path transform="translate(2.5,2.5) scale(0.5)" fill="var(--fg)" d="${BALATON_TILE_ICON_PATH}"></path></pattern></defs>`;
  markup += `<rect x="0" y="0" width="600" height="${fullHeight}" fill="url(#wbal-tile)"></rect>`;
  if (remWidth > 0) markup += `<rect x="0" y="${fullHeight}" width="${remWidth.toFixed(1)}" height="${tileH}" fill="url(#wbal-tile)"></rect>`;
  return markup;
}

// ---- 5. Tavak részletesen ----

function renderBalatonFill(svgEl, levelCm) {
  // A feltöltő téglalap a BALATON_TILT_DEG szöggel elforgatva, a tó
  // tengelye mentén tölt fel (ld. a BALATON_TILT_* konstansok fenti
  // kommentjét) - 0 cm-nél a DNy-i végén kívül, 120 cm-nél a teljes tavat
  // lefedi. A jobb oldali olvasó-skála viszont EGYENES marad (nem forog),
  // az a sima cm-tengely, nem a tó alakja.
  const fillSpanCm = BALATON_TILT_HALF_SPAN * 2;
  const pxPerCmTilted = fillSpanCm / 120;
  const zeroYTilted = BALATON_TILT_PIVOT.y + BALATON_TILT_HALF_SPAN;
  const fillTopY = zeroYTilted - levelCm * pxPerCmTilted;
  const summerLimitY = zeroYTilted - 120 * pxPerCmTilted;
  const winterLimitY = zeroYTilted - 110 * pxPerCmTilted;
  const rotate = `rotate(${BALATON_TILT_DEG} ${BALATON_TILT_PIVOT.x} ${BALATON_TILT_PIVOT.y})`;

  const axisX = BALATON_BBOX.x + BALATON_BBOX.width + 75;
  const axisYFor0cm = BALATON_BBOX.y + BALATON_BBOX.height;
  const axisPxPerCm = BALATON_BBOX.height / 120;
  const tickY = cm => (axisYFor0cm - cm * axisPxPerCm).toFixed(1);

  svgEl.innerHTML = `
    <defs><clipPath id="wbfill-outline"><path transform="${BALATON_FILL_TRANSFORM}" d="${BALATON_TILE_ICON_PATH}"></path></clipPath></defs>
    <path transform="${BALATON_FILL_TRANSFORM}" d="${BALATON_TILE_ICON_PATH}" fill="none" stroke="var(--muted)" stroke-width="1" vector-effect="non-scaling-stroke" stroke-dasharray="3 3" stroke-linejoin="round"></path>
    <g clip-path="url(#wbfill-outline)">
      <g transform="${rotate}">
        <rect x="${(BALATON_TILT_PIVOT.x - 1000).toFixed(1)}" y="${fillTopY.toFixed(1)}" width="2000" height="2000" fill="var(--fg)"></rect>
      </g>
    </g>
    <g transform="${rotate}" stroke="var(--muted)" stroke-width="1">
      <line x1="${(BALATON_TILT_PIVOT.x - 250).toFixed(1)}" y1="${summerLimitY.toFixed(1)}" x2="${(BALATON_TILT_PIVOT.x + 250).toFixed(1)}" y2="${summerLimitY.toFixed(1)}" stroke-dasharray="3 3"></line>
      <line x1="${(BALATON_TILT_PIVOT.x - 250).toFixed(1)}" y1="${winterLimitY.toFixed(1)}" x2="${(BALATON_TILT_PIVOT.x + 250).toFixed(1)}" y2="${winterLimitY.toFixed(1)}" stroke-dasharray="1 3"></line>
    </g>
    <g stroke="var(--fg)" stroke-width="1">
      <line x1="${axisX}" y1="${tickY(0)}" x2="${axisX}" y2="${tickY(120)}"></line>
      <line x1="${axisX - 4}" y1="${tickY(0)}" x2="${axisX + 4}" y2="${tickY(0)}"></line>
      <line x1="${axisX - 4}" y1="${tickY(40)}" x2="${axisX + 4}" y2="${tickY(40)}"></line>
      <line x1="${axisX - 4}" y1="${tickY(110)}" x2="${axisX + 4}" y2="${tickY(110)}"></line>
      <line x1="${axisX - 4}" y1="${tickY(120)}" x2="${axisX + 4}" y2="${tickY(120)}"></line>
    </g>
    <g font-size="12" fill="var(--muted)">
      <text x="${axisX + 10}" y="${(+tickY(0) + 4).toFixed(1)}">0</text>
      <text x="${axisX + 10}" y="${(+tickY(40) + 4).toFixed(1)}">40</text>
      <text x="${axisX + 10}" y="${(+tickY(120) + 4).toFixed(1)}">120 nyár</text>
      <text x="${axisX + 10}" y="${(+tickY(110) + 4).toFixed(1)}">110 tél</text>
    </g>
    <text x="${axisX + 10}" y="${(+tickY(levelCm) + 4).toFixed(1)}" font-size="13" font-weight="600" fill="var(--fg)">${waterNum(levelCm, 0)} cm</text>`;
}

// A Tisza-tónak NINCS itt sávja: a "Kisköre alsó" folyó-mérce (amiből a
// vízállása jön) saját, a hivatalos 735±5 cm-es üzemvízszint-skálától
// FÜGGETLEN 0-ponttal rendelkezik - élőben látott érték: -352 cm, miközben
// a tényleges tározó közel volt az üzemvízszinthez. A két skálát egy
// sávban mutatni félrevezető lenne, ezért csak a nyers mérceadat + egy
// erre figyelmeztető szöveg marad (ld. a hívás noteExtra paramétere).
const WATER_LAKE_BANDS = {
  "Velencei-tó": { lowCm: 140, highCm: 170, axisMin: 0, axisMax: 200 },
  "Tisza-tó": { lowCm: null, highCm: null, axisMin: 0, axisMax: 0 },
  "Fertő": { lowCm: null, highCm: null, axisMin: -50, axisMax: 50 },
};

function renderLakeGauge(container, name, levelCm, noteExtra) {
  const band = WATER_LAKE_BANDS[name];
  const wrap = document.createElement("div");
  const valueText = levelCm === null ? "jelenleg nem elérhető" : `${waterNum(levelCm, 0)} cm`;
  let gaugeSvg = "";
  if (band.lowCm !== null && levelCm !== null) {
    const span = band.axisMax - band.axisMin;
    const toX = cm => ((cm - band.axisMin) / span) * 400;
    const bandX = toX(band.lowCm), bandW = toX(band.highCm) - bandX;
    const fillW = Math.max(0, Math.min(400, toX(levelCm)));
    gaugeSvg = `<svg viewBox="0 0 400 44" style="display:block;width:100%;height:auto;margin-top:var(--sp-2)" role="img" aria-label="${name}: ${valueText}">
      <rect x="${bandX.toFixed(1)}" y="4" width="${bandW.toFixed(1)}" height="16" fill="var(--bg)" stroke="var(--fg)" stroke-width="0.75" stroke-dasharray="2 2"></rect>
      <rect x="0" y="8" width="${fillW.toFixed(1)}" height="8" fill="var(--fg)"></rect>
      <line x1="0" y1="20" x2="400" y2="20" stroke="var(--muted)" stroke-width="1"></line>
      <g font-size="12" fill="var(--muted)">
        <text x="0" y="38">${band.axisMin}</text>
        <text x="${bandX.toFixed(1)}" y="38" text-anchor="middle">${band.lowCm}</text>
        <text x="${(bandX + bandW).toFixed(1)}" y="38" text-anchor="middle">${band.highCm}</text>
      </g>
    </svg>`;
  } else {
    gaugeSvg = `<svg viewBox="0 0 400 44" style="display:block;width:100%;height:auto;margin-top:var(--sp-2)" role="img" aria-label="${name}: nincs megadva szabályozási sáv">
      <line x1="0" y1="20" x2="400" y2="20" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"></line>
    </svg>`;
  }
  const valueClass = levelCm === null ? "water-lake-gauge-value water-lake-gauge-value-missing" : "water-lake-gauge-value";
  wrap.innerHTML = `
    <p class="water-lake-gauge-label">${name}</p>
    <p class="${valueClass}">${valueText}</p>
    ${gaugeSvg}
    <p class="water-lake-gauge-note">${noteExtra}</p>`;
  container.appendChild(wrap);
}

// ---- Fő összerakó: lekéri a három snapshotot, feltölti a szekciókat ----

async function fetchWaterSnapshot(name) {
  const res = await fetch(`${PUSH_WORKER_URL}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

function findRiverStation(stations, river, name) {
  return stations.find(s => s.river === river && s.name === name);
}

function findLakeStation(stations, lake, station) {
  return stations.find(s => s.lake === lake && s.station === station);
}

async function buildWaterPanel(point) {
  const statusEl = document.getElementById("water-status");
  statusEl.hidden = false;
  statusEl.textContent = "töltés…";

  try {
    const [soil, rivers, lakes] = await Promise.all([
      fetchWaterSnapshot("soil-snapshot"),
      fetchWaterSnapshot("rivers-snapshot"),
      fetchWaterSnapshot("lakes-snapshot"),
      loadWaterGeo(), // a legnagyobb folyók/Balaton valódi vonala a dombormű-térképhez (globális `waterGeo`)
    ]);

    // 1. Talajvíz: országos
    const totalCount = waterBalatonCount(soil.country_total_liters, 1);
    document.getElementById("water-soil-balaton-count").textContent = totalCount;
    document.getElementById("water-soil-balaton-label").textContent = "Balatonnyi, 81 cm mélységig";
    document.getElementById("water-soil-exact").textContent =
      `kb. ${waterNum(soil.country_total_liters / 1e9, 0)} milliárd liter`;
    const avgMoisture = waterCountryAvgMoisture(soil);
    renderBalatonStack(
      document.getElementById("water-balaton-stack"),
      soil.depth_bands_cm,
      soil.country_total_by_depth,
      avgMoisture
    );
    document.getElementById("water-soil-section").hidden = false;

    // 2. Országtérkép
    const hungaryCells = soil.points.filter(p => p.in_hungary);
    const maxCell = hungaryCells.reduce((a, b) => (b.liters_total > a.liters_total ? b : a), hungaryCells[0]);
    const minCell = hungaryCells.reduce((a, b) => (b.liters_total < a.liters_total ? b : a), hungaryCells[0]);
    document.getElementById("water-map-headline").textContent =
      `legtöbb víz: ${waterNum(maxCell.liters_total / 1e9, 0)} milliárd liter egy cellában`;
    document.getElementById("water-map-detail").textContent =
      `legkevesebb: ${waterNum(minCell.liters_total / 1e9, 0)} milliárd liter`;
    buildReliefMap(
      document.getElementById("water-relief-map"),
      document.getElementById("water-map-legend"),
      soil,
      rivers.stations,
      lakes.stations,
      point,
      waterGeo
    );
    document.getElementById("water-map-section").hidden = false;

    // 2c. Folyóhálózat: statikus, önálló (ld. WATER_RIVER_NET_SVG)
    document.getElementById("water-river-net").innerHTML = WATER_RIVER_NET_SVG;
    document.getElementById("water-river-net-section").hidden = false;

    // 2b. Folyók: önálló lista, kattintható állomások
    const riverCount = rivers.stations.length;
    const riverNames = [...new Set(rivers.stations.map(s => s.river))];
    document.getElementById("water-rivers-headline").textContent =
      `${riverCount} mérőállomás, ${riverNames.length} nagyobb folyón`;
    document.getElementById("water-rivers-detail").textContent =
      "koppints egy folyóra az előrejelzéshez és a korábbi vízálláshoz";
    buildRiverList(document.getElementById("water-river-list"), rivers.stations);
    document.getElementById("water-rivers-section").hidden = false;

    // 2d. Csatornák: lásd a buildChannelsMap fölötti kommentet - külön
    // lekérés, külön try/catch, mert ez a pillanatkép nem az óránkénti
    // ciklus része, tehát hiányozhat anélkül, hogy az a fenti, már
    // működő szakaszokat is eldöntené.
    try {
      const channels = await fetchWaterSnapshot("channels-snapshot");
      await loadBorders();
      buildChannelsMap(
        document.getElementById("water-channels-map"),
        document.getElementById("water-channels-legend"),
        channels
      );
      const stats = channels.stats;
      document.getElementById("water-channels-headline").textContent =
        `${waterNum(stats.total_ways, 0)} csatorna, belvízelvezető és árok`;
      document.getElementById("water-channels-detail").textContent =
        `összesen kb. ${waterNum(stats.total_km, 0)} km`;
      document.getElementById("water-channels-longest").innerHTML = stats.longest
        .slice(0, 8)
        .map(c => `<li><span>${c.name}</span><span>${waterNum(c.km, 1)} km</span></li>`)
        .join("");
      document.getElementById("water-channels-caveat").textContent =
        "A térkép csak a nevesített vízfolyásokat rajzolja ki, a fenti darabszám és hossz viszont mindegyikkel számol - a legtöbb kisebb árok nincs elnevezve.";
      document.getElementById("water-channels-section").hidden = false;
    } catch (err) {
      console.error(err);
      document.getElementById("water-channels-section").hidden = true;
    }

    // 3. Személyes
    document.getElementById("water-local-question").textContent = `és ${point.name || "a keresett helyszín"} környékén?`;
    try {
      const localMoisture = await fetchUserSoilProfile(point);
      const localAvgPct = Math.round(waterWeightedAvg(localMoisture) * 100);
      const countryAvgPct = Math.round(waterWeightedAvg(avgMoisture) * 100);
      document.getElementById("water-local-total").textContent = `${localAvgPct}% átlagos víztartalom`;
      document.getElementById("water-local-compare").textContent =
        localAvgPct >= countryAvgPct
          ? `az országos átlag (${countryAvgPct}%) felett`
          : `az országos átlag (${countryAvgPct}%) alatt`;
      const surfacePct = Math.round(localMoisture[0] * 100);
      const deepPct = Math.round(localMoisture[4] * 100);
      document.getElementById("water-local-profile-text").textContent =
        surfacePct > deepPct
          ? "felül nedvesebb, mélyebben alig van víz"
          : surfacePct < deepPct
            ? "mélyebben van több víz, mint felül"
            : "a mélység mentén egyenletes a víztartalom";
      renderSoilCoreProfile(document.getElementById("water-soil-core"), localMoisture);
      document.getElementById("water-local-section").hidden = false;
    } catch (err) {
      console.error(err);
      document.getElementById("water-local-section").hidden = true;
    }

    // 4. Vízmérleg
    document.getElementById("water-sankey").innerHTML = WATER_SANKEY_SVG;
    document.getElementById("water-sankey-soil-now").textContent =
      `${waterNum(soil.country_total_liters / 1e12, 2)} km³`;
    const balanceBalatonCount = 172e9 / (BALATON_LITERS / 1e3); // 172 km³ = 172e9 m³
    const balanceWhole = Math.floor(balanceBalatonCount);
    const balanceFraction = balanceBalatonCount - balanceWhole;
    document.getElementById("water-balance-balaton-count").textContent =
      balanceFraction >= 0.4 && balanceFraction < 0.6
        ? `${balanceWhole} és fél`
        : waterNum(balanceBalatonCount, 1);
    document.getElementById("water-balaton-tiles").innerHTML = waterBalatonTilesSvg(balanceBalatonCount);
    document.getElementById("water-balance-section").hidden = false;

    // 5. Tavak
    const balatonAvg = findLakeStation(lakes.stations, "Balaton", "Balaton average");
    if (balatonAvg) {
      document.getElementById("water-balaton-level").textContent = `${waterNum(balatonAvg.level_cm, 0)} cm`;
      document.getElementById("water-balaton-detail").textContent =
        balatonAvg.stale ? "a siófoki mércén mért országos átlag (tegnapi adat)" : "a siófoki mércén mért országos átlag";
      renderBalatonFill(document.getElementById("water-balaton-fill"), balatonAvg.level_cm);
    } else {
      document.getElementById("water-balaton-level").textContent = "jelenleg nem elérhető";
      document.getElementById("water-balaton-detail").textContent = "a siófoki vízállás most nem tölthető be";
      document.getElementById("water-balaton-fill").innerHTML = "";
    }
    document.getElementById("water-lake-compare").innerHTML =
      `<g fill="var(--fg)">` +
      Object.values(LAKE_COMPARE_PATHS).map(p => `<path${p.transform ? ` transform="${p.transform}"` : ""} d="${p.d}"></path>`).join("") +
      `</g><g font-size="12" fill="var(--muted)" text-anchor="middle">` +
      `<text x="105" y="134">Balaton</text><text x="268" y="134">Fertő</text><text x="340" y="114">Tisza-tó</text></g>`;

    const gaugesEl = document.getElementById("water-lake-gauges");
    gaugesEl.innerHTML = "";
    const velencei = findLakeStation(lakes.stations, "Velencei-tó", "Agárd");
    renderLakeGauge(gaugesEl, "Velencei-tó", velencei ? velencei.level_cm : null, "ideális legalább 140 cm, felső határ 170 cm");
    const tiszato = findRiverStation(rivers.stations, "Tisza", "Kisköre alsó");
    renderLakeGauge(gaugesEl, "Tisza-tó", tiszato ? tiszato.level_cm : null, "a Kisköre alsó mérce adata, nem feltétlenül a tó üzemvízszintjével egyező skálán");
    const ferto = findLakeStation(lakes.stations, "Fertő", "Fertőrákos");
    renderLakeGauge(gaugesEl, "Fertő", ferto ? ferto.level_cm : null, "a fertőrákosi mérce napi vízállása, szabályozási sáv még nincs megadva");

    // "legrosszabbul álló tó": csak azok közül választunk, amiknek van
    // megbízható szabályozási sávja (most csak a Velencei-tó) - enélkül a
    // "legrosszabbul" állítás megtévesztő lenne, mint a Tisza-tónál.
    const worstLakeCandidates = [
      { name: "Velencei-tó", levelCm: velencei ? velencei.level_cm : null },
      { name: "Fertő", levelCm: ferto ? ferto.level_cm : null },
    ]
      .map(c => {
        const band = WATER_LAKE_BANDS[c.name];
        return band && band.lowCm !== null && c.levelCm !== null
          ? { ...c, deficit: band.lowCm - c.levelCm }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.deficit - a.deficit);
    const worstLake = worstLakeCandidates[0];
    if (worstLake) {
      document.getElementById("water-lake-worst-headline").textContent =
        worstLake.deficit > 0 ? `${worstLake.name} áll a legrosszabbul` : `${worstLake.name} a legjobb állapotban`;
      document.getElementById("water-lake-worst-detail").textContent =
        worstLake.deficit > 0
          ? `${waterNum(worstLake.deficit, 0)} cm-rel az ideális szint alatt`
          : `${waterNum(-worstLake.deficit, 0)} cm-rel az ideális szint felett`;
    } else {
      document.getElementById("water-lake-worst-headline").textContent = "nincs elég adat az összevetéshez";
      document.getElementById("water-lake-worst-detail").textContent = "";
    }

    document.getElementById("water-lakes-section").hidden = false;

    statusEl.hidden = true;
  } catch (err) {
    console.error(err);
    statusEl.textContent = "a vízadatok most nem érhetők el";
  }
}

function resetWaterPanel() {
  const panel = document.getElementById("water-panel");
  panel.hidden = true;
  for (const id of ["water-soil-section", "water-map-section", "water-rivers-section", "water-channels-section", "water-local-section", "water-balance-section", "water-lakes-section"]) {
    document.getElementById(id).hidden = true;
  }
  document.getElementById("water-status").hidden = false;
  document.getElementById("water-status").textContent = "töltés…";
}

// ---- Indítás ----

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(err => console.error(err));
}

updateNotifyButton();

const saved = loadSavedLocation();
if (saved) {
  showResult();
  runAndTrack(saved);
} else {
  tryAutoLocate();
}
