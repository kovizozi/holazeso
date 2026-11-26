// A /cigand/ oldal ábráinak betöltője (nem az esőalkalmazás).
//
// A water.js klasszikus script, és a Cigánd-ábrák kódja (buildCigandFigures)
// ott van; a script.js (kb. 117 kB, az esőkereső) ehhez az oldalhoz NEM kell.
// Itt csak azt a néhány globális nevet pótoljuk, amit a water.js függvényei a
// script.js-ből várnának, de a Cigánd-ábráknál csak null/üres is jó:
//   borderRings: az országhatár-gyűrűk (a térkép sarok-áttekintőjéhez; null esetén
//                az áttekintő egyszerűen elmarad, borders.json nem töltődik).
// A worker-pillanatképek (CORS, csak éles origin) nem kellenek: az ábrák csak a
// cigand.json és cigand-geo.json (azonos eredet) adatait használják.
// Ha a water.js mellé más script.js-névre is szükség lenne, itt kell pótolni.
let borderRings = null;

(function () {
  const WATER_JS_URL = "/water.js?v=20";
  const s = document.createElement("script");
  s.src = WATER_JS_URL;
  s.onload = () => buildCigandPage();
  s.onerror = () => {
    const figs = document.getElementById("cigand-figures");
    if (figs) figs.hidden = true;
  };
  document.head.appendChild(s);
})();
