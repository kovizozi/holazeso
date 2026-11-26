// /eghajlat/: a hőtérképek hoverje és a simítás-választó. Az ábrák statikus SVG-k (a
// generátor rajzolja a közepes simítással); ez a script a mutató alatti cella értékét írja
// ki, és simítás-váltáskor a cellákat újrarajzolja ugyanazzal a logikával, mint a
// tools/build_pages.py eg_svg(). Az adatot (data/eghajlat.json) az első használatkor tölti le.
(function () {
  "use strict";
  const MONTHS = ["jan.", "febr.", "márc.", "ápr.", "máj.", "jún.", "júl.", "aug.", "szept.", "okt.", "nov.", "dec."];
  const LEVELS = 6;
  let dataPromise = null;
  let level = null;   // null: az alapértelmezett (a JSON "default"-ja)
  const figs = [...document.querySelectorAll(".eg-fig")];
  if (!figs.length) return;
  const load = () => dataPromise || (dataPromise = fetch(figs[0].dataset.src).then(r => r.json()));
  const num = (x, d) => x.toFixed(d).replace(".", ",").replace("-", "−");
  const sign = (x, d) => (x > 0 ? "+" : "") + num(x, d);
  const dayText = doy => {
    const t = new Date(Date.UTC(2001, 0, 1) + Math.round(doy) * 864e5);
    return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}.`;
  };
  const geom = svg => ({ pre: +svg.dataset.pre, cw: +svg.dataset.cw, rh: +svg.dataset.rh, L: +svg.dataset.l, T: +svg.dataset.t });

  function redraw(fig, data) {
    const svg = fig.querySelector(".eg-svg"), g = geom(svg);
    const ch = data.charts[fig.dataset.eg][level];
    const ny = data.y1 - data.y0 + 1, nb = data.nb, digits = +fig.dataset.digits;
    const lvAt = (y, b) => {
      if (b < 0) { y -= 1; b += nb; } else if (b >= nb) { y += 1; b -= nb; }
      if (y < 0 || y >= ny) return null;
      const t = 0.5 + ch.anom[b][y] / ch.k / (2 * ch.scale);
      return Math.max(0, Math.min(LEVELS, Math.round(t * LEVELS)));
    };
    const nrows = nb + 2 * g.pre;
    let out = "";
    for (let y = 0; y < ny; y++) {
      let k = 0;
      while (k < nrows) {
        const lv = lvAt(y, k - g.pre);
        let n = 1;
        while (k + n < nrows && lvAt(y, k + n - g.pre) === lv) n++;
        if (lv !== null) out += `<rect class="eg-l${lv}" x="${g.L + y * g.cw}" y="${g.T + k * g.rh}" width="${g.cw + 1}" height="${n * g.rh + 0.5}"/>`;
        k += n;
      }
    }
    svg.querySelector(".eg-cells").innerHTML = out;
    const lines = svg.querySelector(".eg-lines");
    if (lines.childElementCount) {
      const fr = data.frost[level];
      lines.innerHTML = ["last", "first"].map(key => `<polyline class="eg-frost" points="${fr[key].map((d, i) =>
        `${(g.L + i * g.cw + g.cw / 2).toFixed(1)},${(g.T + (g.pre + d * nb / 365.25) * g.rh).toFixed(1)}`).join(" ")}"/>`).join("");
    }
    fig.querySelector(".eg-lo").textContent = num(-ch.scale, digits);
    fig.querySelector(".eg-hi").textContent = sign(ch.scale, digits);
  }

  function setLevel(next) {
    load().then(data => {
      level = next;
      figs.forEach(fig => {
        redraw(fig, data);
        fig.querySelectorAll(".eg-ctl button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.level === level)));
      });
    });
  }

  figs.forEach(fig => {
    const svg = fig.querySelector(".eg-svg"), tip = fig.querySelector(".vz-tip"), g = geom(svg);
    const ctl = fig.querySelector(".eg-ctl");
    ctl.hidden = false;
    ctl.querySelectorAll("button").forEach(b => b.addEventListener("click", () => setLevel(b.dataset.level)));
    const unit = fig.dataset.unit, digits = +fig.dataset.digits;

    function show(ev) {
      load().then(data => {
        const lv = level || data.default;
        const pt = svg.createSVGPoint();
        pt.x = ev.clientX; pt.y = ev.clientY;
        const p = pt.matrixTransform(svg.getScreenCTM().inverse());
        const ny = data.y1 - data.y0 + 1, nb = data.nb;
        let y = Math.floor((p.x - g.L) / g.cw), b = Math.floor((p.y - g.T) / g.rh) - g.pre;
        if (b < 0) { y -= 1; b += nb; } else if (b >= nb) { y += 1; b -= nb; }
        if (y < 0 || y >= ny || b < 0 || b >= nb || p.x < g.L) { tip.hidden = true; return; }
        const ch = data.charts[fig.dataset.eg][lv];
        const clim = ch.clim[b], an = ch.anom[b][y] / ch.k;
        const from = b * 365 / nb, to = (b + 1) * 365 / nb - 1;
        tip.innerHTML = `<strong>${data.y0 + y}, ${dayText(from)} - ${dayText(to)}</strong>` +
          `<span>${num(clim + an, digits)} ${unit} (szokásos: ${num(clim, digits)})</span>` +
          `<span>eltérés: ${sign(an, digits)} ${unit}</span>`;
        tip.hidden = false;
        const box = fig.getBoundingClientRect();
        const x = ev.clientX - box.left, yy = ev.clientY - box.top;
        tip.style.left = Math.max(4, Math.min(box.width - tip.offsetWidth - 4, x + 12)) + "px";
        tip.style.top = Math.max(4, yy - tip.offsetHeight - 12) + "px";
      });
    }
    svg.addEventListener("pointermove", show);
    svg.addEventListener("pointerdown", show);
    svg.addEventListener("pointerleave", ev => { if (ev.pointerType === "mouse") tip.hidden = true; });
  });
})();
