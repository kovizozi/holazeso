// ---- Keresési rács ----
// Nincs fix településlista: a felhasználó koordinátája köré generálunk egy
// gyűrűkből álló ponthálót, és abban keressük a legközelebbi esőt. Ez minden
// országban egyformán pontos, nem csak Magyarországon vagy egy előre
// kiválasztott városlistán.
const SEARCH_RINGS_KM = [30, 70, 150, 300, 600];
const SEARCH_BEARINGS_DEG = [0, 45, 90, 135, 180, 225, 270, 315];

const NEARBY_LIMIT_KM = 70; // eddig számít "közelinek" egy esős hely
const RAIN_THRESHOLD_MM = 0.1; // ennél kevesebb csapadékot zajnak tekintünk

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

  return { lat: lat2 * 180 / Math.PI, lon: lon2 * 180 / Math.PI };
}

// A felhasználó koordinátája köré generált keresési pontok, gyűrűnként
// növekvő távolsággal, hogy a legközelebbi találat mindig elöl legyen.
function generateSearchGrid(userLoc) {
  const points = [];
  for (const distance of SEARCH_RINGS_KM) {
    for (const bearing of SEARCH_BEARINGS_DEG) {
      const p = destinationPoint(userLoc.lat, userLoc.lon, bearing, distance);
      points.push({ lat: p.lat, lon: p.lon, distance });
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
  return { name: r.name, lat: r.latitude, lon: r.longitude };
}

// Koordinátából településnév az OpenStreetMap-alapú, kulcs nélküli BigDataCloud
// reverse geocoding API-val. Ha nem sikerül, null-t adunk vissza, és általános
// szöveggel folytatjuk. A koordináta enélkül is elég a válaszhoz.
async function reverseGeocode(lat, lon) {
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=hu`;
  const res = await fetch(url);
  const data = await res.json();
  return data.city || data.locality || null;
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

// Egyetlen hívásban lekérjük a felhasználó helyét ÉS a köré generált rács
// összes pontját.
async function fetchAllPrecipitation(userLoc) {
  const grid = generateSearchGrid(userLoc);
  const allPoints = [userLoc, ...grid];
  const lats = allPoints.map(p => p.lat).join(",");
  const lons = allPoints.map(p => p.lon).join(",");
  // forecast_days=2, hogy a "hamarosan" (következő 3 óra) ablak éjfél körül is
  // átnyúlhasson a következő napra, ne csak az aktuális nap 23:00-jánál vágja le.
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&current=precipitation&hourly=precipitation&forecast_days=2&timezone=auto`;
  const res = await fetch(url);
  const data = await res.json();

  // A válasz ugyanabban a sorrendben jön vissza, ahogy küldtük a koordinátákat
  return {
    user: data[0],
    grid,
    gridForecasts: data.slice(1),
  };
}

function isRainingNow(forecast) {
  return forecast.current.precipitation >= RAIN_THRESHOLD_MM;
}

function isRainingSoon(forecast) {
  // A "current.time" perc-pontosságú (pl. "...T18:45"), az "hourly.time" viszont
  // csak egész órás bontású ("...T18:00"), ezért kerekítsük le óra-pontosságra egyezéshez.
  const currentHour = forecast.current.time.slice(0, 13) + ":00";
  const idx = forecast.hourly.time.indexOf(currentHour);
  if (idx === -1) return false;
  return forecast.hourly.precipitation
    .slice(idx, idx + 3)
    .some(v => v >= RAIN_THRESHOLD_MM);
}

// ---- Fő logika ----

async function run(userLoc) {
  showLoading(true);
  try {
    const { user, grid, gridForecasts } = await fetchAllPrecipitation(userLoc);
    await render(userLoc, user, grid, gridForecasts);
  } catch (err) {
    console.error(err);
    setHero("Hiba", "");
    setQ2(null);
    document.getElementById("q1-context").textContent =
      "Nem sikerült lekérni az adatokat. Próbáld újra kicsit később.";
  } finally {
    showLoading(false);
  }
}

async function render(userLoc, userForecast, gridPoints, gridForecasts) {
  document.getElementById("q1-question").textContent =
    `hol az eső ${userLoc.name} környékén?`;

  // --- Nálad esik, vagy hamarosan fog ---
  if (isRainingNow(userForecast)) {
    setHero("Nálad", "most esik");
    setQ2(null);
    return;
  }
  if (isRainingSoon(userForecast)) {
    setHero("Nálad", "hamarosan elkezdődik");
    setQ2(null);
    return;
  }

  // --- Keressük meg a hozzád legközelebbi esős rácspontot ---
  const raining = gridPoints
    .map((point, i) => ({ point, forecast: gridForecasts[i] }))
    .filter(({ forecast }) => isRainingNow(forecast))
    .sort((a, b) => a.point.distance - b.point.distance);

  if (raining.length > 0) {
    const nearest = raining[0].point;
    const isNearby = nearest.distance <= NEARBY_LIMIT_KM;
    setHero(
      isNearby ? "Közelben" : "Távolban",
      isNearby ? "a közeli térségben esik" : "egy távolabbi térségben esik"
    );

    let placeName = null;
    try {
      placeName = await reverseGeocode(nearest.lat, nearest.lon);
    } catch (err) {
      console.error(err);
    }

    setQ2(
      "de hol esik pontosan?",
      `<p class="place-line">${placeName || "egy közeli térségben"}</p>
       <p class="context">kb. ${Math.round(nearest.distance)} km innen</p>`
    );
    return;
  }

  // --- A teljes átvizsgált körzetben sehol nem esik ---
  setHero("Sehol", "a közeledben most száraz idő van");
  setQ2(null);
}

function setHero(answer, context) {
  document.getElementById("q1-answer").textContent = answer;
  document.getElementById("q1-context").textContent = context;
}

function setQ2(question, html) {
  const block = document.getElementById("q2-block");
  if (question === null) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  document.getElementById("q2-question").textContent = question;
  document.getElementById("q2-answer").innerHTML = html;
}

// ---- UI-vezérlés ----

function showLoading(on, text = "töltés…") {
  const el = document.getElementById("loading");
  el.textContent = text;
  el.hidden = !on;
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
}

// Automatikus helymeghatározás: ez az alapértelmezett út. Ha a felhasználó
// megtagadja vagy nem támogatott, a kézi keresőre esünk vissza.
async function tryAutoLocate() {
  showLoading(true, "helymeghatározás…");
  try {
    const coords = await detectLocation();
    let name = null;
    try {
      name = await reverseGeocode(coords.lat, coords.lon);
    } catch (err) {
      console.error(err);
    }
    const loc = { name: name || "a jelenlegi helyzeted", lat: coords.lat, lon: coords.lon };
    saveLocation(loc);
    showLoading(false);
    showResult();
    run(loc);
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
  run(loc);
});

document.getElementById("change-location").addEventListener("click", () => {
  showPicker();
});

document.getElementById("retry-geo").addEventListener("click", () => {
  document.getElementById("location-error").hidden = true;
  tryAutoLocate();
});

// ---- Indítás ----

const saved = loadSavedLocation();
if (saved) {
  showResult();
  run(saved);
} else {
  tryAutoLocate();
}
