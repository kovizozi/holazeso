"""Az /eghajlat/ oldal "Összefüggések és kitekintés" pontdiagramjai (a build_pages.py hívja).

Adat: a data/eghajlat.json "yearly" része (évenkénti értékek, 10 állomás átlaga,
tools/import_climate_trends.py). Kétféle ábra:
  - kapcsolati (scatter): x = nyári középhőmérséklet, y = hőségnap / trópusi éjszaka,
    illesztett modell (lineáris vagy Poisson-exponenciális), 90%-os sáv, és
    forgatókönyvek: az 1991-2020-as nyári átlag, +1 és +2 °C;
  - idősor: évek, Gauss-simított átlag, lineáris trend meghosszabbítva 2050-ig, 90%-os sáv.
A megbízhatósági mondat számait itt számoljuk (időben kettévágott teszt: tanítás
1901-1962, teszt 1963-2025), hogy a szöveg mindig az adatból jöjjön.
A színek CSS-osztályokból jönnek (style.css .eg-sc*), így sötét módban is működnek.
Csak szabványos könyvtár.
"""
import math
import statistics

W, H = 460, 320
ML, MR, MT, MB = 52, 14, 14, 46
SPLIT = 1962
NEAR = 1.645          # 90%-os sáv: +-1,645 szórás


def fmt(x, d=0):
    x = round(x, d) + 0.0
    return f"{x:.{d}f}".replace(".", ",").replace("-", "−")


def esc(t):
    return str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def fit_linear(x, y):
    r = statistics.linear_regression(x, y)
    return lambda v: r.slope * v + r.intercept


def fit_poisson(x, y, it=60):
    """log(E[y]) = a + b*x, Newton-iteráció."""
    a, b = math.log(max(statistics.mean(y), 0.1)), 0.0
    for _ in range(it):
        mu = [math.exp(a + b * v) for v in x]
        g0 = sum(yy - m for yy, m in zip(y, mu))
        g1 = sum((yy - m) * v for yy, m, v in zip(y, mu, x))
        h00 = sum(mu)
        h01 = sum(m * v for m, v in zip(mu, x))
        h11 = sum(m * v * v for m, v in zip(mu, x))
        det = h00 * h11 - h01 * h01
        a += (h11 * g0 - h01 * g1) / det
        b += (-h01 * g0 + h00 * g1) / det
    return lambda v: math.exp(a + b * v)


def gauss_smooth(v, sig=8):
    n = len(v)
    out = []
    for i in range(n):
        w = [math.exp(-((i - j) / sig) ** 2 / 2) for j in range(n)]
        out.append(sum(a * b for a, b in zip(v, w)) / sum(w))
    return out


def ticks(lo, hi, n=6):
    step = 10 ** math.floor(math.log10((hi - lo) / n))
    for m in (1, 2, 5, 10):
        if (hi - lo) / (step * m) <= n:
            step *= m
            break
    v = math.ceil(lo / step - 1e-9) * step
    out = []
    while v <= hi + 1e-9:
        out.append(round(v, 6))
        v += step
    return out


class Plot:
    def __init__(self, xr, yr, xlab, ylab, xd=0, yd=0):
        self.xr, self.yr = xr, yr
        self.parts = []
        sx, sy = self.sx, self.sy
        for v in ticks(*xr):
            self.parts.append(f'<line class="eg-sc-gl" x1="{sx(v):.1f}" x2="{sx(v):.1f}" y1="{MT}" y2="{H - MB}"/>'
                              f'<text x="{sx(v):.1f}" y="{H - MB + 16}" text-anchor="middle">{fmt(v, xd)}</text>')
        for v in ticks(*yr):
            self.parts.append(f'<line class="eg-sc-gl" x1="{ML}" x2="{W - MR}" y1="{sy(v):.1f}" y2="{sy(v):.1f}"/>'
                              f'<text x="{ML - 6}" y="{sy(v) + 4:.1f}" text-anchor="end">{fmt(v, yd)}</text>')
        self.parts.append(f'<line class="eg-sc-axis" x1="{ML}" x2="{W - MR}" y1="{H - MB}" y2="{H - MB}"/>'
                          f'<line class="eg-sc-axis" x1="{ML}" x2="{ML}" y1="{MT}" y2="{H - MB}"/>'
                          f'<text class="eg-sc-lab" x="{(ML + W - MR) / 2}" y="{H - 8}" text-anchor="middle">{esc(xlab)}</text>'
                          f'<text class="eg-sc-lab" transform="translate(13,{(MT + H - MB) / 2}) rotate(-90)" '
                          f'text-anchor="middle">{esc(ylab)}</text>')

    def sx(self, v):
        return ML + (v - self.xr[0]) / (self.xr[1] - self.xr[0]) * (W - ML - MR)

    def sy(self, v):
        v = min(max(v, self.yr[0]), self.yr[1])
        return H - MB - (v - self.yr[0]) / (self.yr[1] - self.yr[0]) * (H - MT - MB)

    def band(self, xs, lo, hi):
        pts = [(self.sx(x), self.sy(v)) for x, v in zip(xs, hi)] + \
              [(self.sx(x), self.sy(v)) for x, v in reversed(list(zip(xs, lo)))]
        self.parts.append('<polygon class="eg-sc-band" points="' + " ".join(f"{a:.1f},{b:.1f}" for a, b in pts) + '"/>')

    def line(self, xs, ys, cls):
        self.parts.append(f'<polyline class="{cls}" points="'
                          + " ".join(f"{self.sx(x):.1f},{self.sy(y):.1f}" for x, y in zip(xs, ys)) + '"/>')

    def points(self, xs, ys, years, tips):
        for x, y, yr, tip in zip(xs, ys, years, tips):
            k = min(12, (yr - 1900) // 10)
            self.parts.append(f'<circle class="eg-sc-pt eg-y{k}" cx="{self.sx(x):.1f}" cy="{self.sy(y):.1f}" r="3.6" '
                              f'data-tip="{esc(tip)}"/>')

    def svg(self, label):
        return (f'<svg class="eg-sc" viewBox="0 0 {W} {H}" role="img" aria-label="{esc(label)}">'
                + "".join(self.parts) + "</svg>")


def split_test(x, y, years, fit):
    """Tanítás 1901-SPLIT, teszt utána: (átlagos abszolút hiba, a naiv tipp hibája, R2)."""
    tr = [i for i, yr in enumerate(years) if yr <= SPLIT]
    te = [i for i, yr in enumerate(years) if yr > SPLIT]
    m = fit([x[i] for i in tr], [y[i] for i in tr])
    pred = [m(x[i]) for i in te]
    obs = [y[i] for i in te]
    mae = statistics.mean(abs(a - b) for a, b in zip(obs, pred))
    naive = statistics.mean(abs(a - statistics.mean(y[i] for i in tr)) for a in obs)
    mo = statistics.mean(obs)
    r2 = 1 - sum((a - b) ** 2 for a, b in zip(obs, pred)) / sum((a - mo) ** 2 for a in obs)
    return mae, naive, r2


def relation_chart(yearly, years, ykey, fit, title, ylab, unit, yr, digits=0):
    x, y = yearly["t_nyar"], yearly[ykey]
    m = fit(x, y)
    sd = statistics.pstdev([b - m(a) for a, b in zip(x, y)])
    p = Plot((18, 24.5), yr, "Nyári középhőmérséklet (jún.-aug., °C)", ylab, 0, 0)
    xs = [18 + 6.5 * i / 80 for i in range(81)]
    p.band(xs, [max(0, m(v) - NEAR * sd) for v in xs], [m(v) + NEAR * sd for v in xs])
    p.points(x, y, years, [f"{yr_}: nyár {fmt(a, 1)} °C, {fmt(b, digits)} {unit}" for yr_, a, b in zip(years, x, y)])
    p.line(xs, [m(v) for v in xs], "eg-sc-model")
    base = statistics.mean(v for v, yr_ in zip(x, years) if 1991 <= yr_ <= 2020)
    scen = []
    for lab, dx in (("1991-2020", 0), ("+1 °C", 1), ("+2 °C", 2)):
        xv = base + dx
        yv = m(xv)
        scen.append((lab, xv, yv))
        p.parts.append(f'<line class="eg-sc-scen" x1="{p.sx(xv):.1f}" x2="{p.sx(xv):.1f}" y1="{MT}" y2="{H - MB}"/>'
                       f'<circle class="eg-sc-mark" cx="{p.sx(xv):.1f}" cy="{p.sy(yv):.1f}" r="5.5"/>'
                       f'<text class="eg-sc-strong" x="{p.sx(xv) - 5:.1f}" y="{MT + 13}" text-anchor="end">{lab}</text>'
                       f'<text class="eg-sc-strong" x="{p.sx(xv) - 5:.1f}" y="{MT + 28}" text-anchor="end">kb. {fmt(yv)}</text>')
    mae, naive, r2 = split_test(x, y, years, fit)
    trust = (f"Megbízható kapcsolat: ugyanez a modell csak az 1901-{SPLIT} közötti évekből tanulva az 1963-2025-ös "
             f"éveket átlagosan {fmt(mae, 1)} {unit} hibával becsülte (a puszta átlaggal tippelve {fmt(naive, 1)} lett volna). "
             f"A szám azt mondja meg, mire számíthatunk egy adott melegségű nyáron, azt nem, hogy mikor lesz ilyen nyár.")
    summary = "; ".join(f"{lab}: kb. {fmt(yv)} {unit}" for lab, _, yv in scen)
    return title, p.svg(f"{title}. {summary}."), summary, trust


def time_chart(yearly, years, key, title, ylab, unit, yr, digits, trend_from, show_2050=True):
    v = yearly[key]
    sp = "" if unit == "%" else " "     # magyarul: 25%, de 24,2 °C
    p = Plot((1900, 2050), yr, "Év", ylab, 0, 0)
    tx = [yr_ for yr_ in years if yr_ >= trend_from]
    ty = [a for a, yr_ in zip(v, years) if yr_ >= trend_from]
    r = statistics.linear_regression(tx, ty)
    sd = statistics.pstdev([b - (r.slope * a + r.intercept) for a, b in zip(tx, ty)])
    fx = list(range(trend_from, 2051))
    if show_2050:
        p.band(fx, [r.slope * a + r.intercept - NEAR * sd for a in fx], [r.slope * a + r.intercept + NEAR * sd for a in fx])
    p.points(years, v, years, [f"{yr_}: {fmt(a, digits)}{sp}{unit}" for yr_, a in zip(years, v)])
    p.line(years, gauss_smooth(v), "eg-sc-model")
    end = 2050 if show_2050 else years[-1]
    p.line([trend_from, end], [r.slope * trend_from + r.intercept, r.slope * end + r.intercept], "eg-sc-trend")
    v50 = r.slope * 2050 + r.intercept
    if show_2050:
        p.parts.append(f'<circle class="eg-sc-mark" cx="{p.sx(2050):.1f}" cy="{p.sy(v50):.1f}" r="5.5"/>'
                       f'<text class="eg-sc-strong" x="{p.sx(2050) - 9:.1f}" y="{p.sy(v50) - 10:.1f}" '
                       f'text-anchor="end">2050: kb. {fmt(v50, digits)}{sp}{esc(unit)}</text>')
    # időben kettévágott teszt: az 1901-SPLIT trend meghosszabbítva vs. a mért későbbi átlag
    early = [(a, b) for a, b in zip(years, v) if a <= SPLIT]
    re_ = statistics.linear_regression([a for a, _ in early], [b for _, b in early])
    later = [(a, b) for a, b in zip(years, v) if a > SPLIT]
    pred = statistics.mean(re_.slope * a + re_.intercept for a, _ in later)
    obs = statistics.mean(b for _, b in later)
    naive = statistics.mean(b for _, b in early)
    per_dec = r.slope * 10
    first30 = statistics.mean(v[:30])
    last30 = statistics.mean(v[-30:])
    noise = statistics.pstdev([b - (r.slope * a + r.intercept) for a, b in zip(tx, ty)])
    test = (f"Próba: az 1901-{SPLIT} közötti trend meghosszabbítva az 1963-2025-ös évekre átlagosan {fmt(pred, digits)}{sp}"
            f"{unit} értéket adott, a mért {fmt(obs, digits)}{sp}{unit} volt (a régi átlag, {fmt(naive, digits)}, ennél rosszabb tipp).")
    if show_2050:
        summary = f"{trend_from} óta évtizedenként {fmt(per_dec, max(digits, 1))}{sp}{unit}; ha így folytatódik, 2050-ben kb. {fmt(v50, digits)}{sp}{unit}"
        trust = (test + " Ez egyszerű trend-meghosszabbítás, nem éghajlati modell; a kék sáv csak az évek közti ingadozást "
                 "mutatja, a trend bizonytalanságát nem.")
    else:
        summary = (f"az első 30 év átlaga {fmt(first30, digits)}, az utolsó 30 évé {fmt(last30, digits)}{sp}{unit}; "
                   f"az évek közti ingadozás (kb. ±{fmt(noise, digits)}{sp}{unit}) sokszorosa a változásnak")
        trust = ("Nincs egyértelmű irány: egy adott év csapadéka nem jelezhető előre, az évről évre ingadozás sokszorosa "
                 "a hosszú távú változásnak.")
    return title, p.svg(f"{title}. {summary}."), summary, trust


def build(data):
    """Az ábrák listája: (cím, svg, összefoglaló, megbízhatósági mondat)."""
    yearly = data["yearly"]
    years = list(range(data["y0"], data["y1"] + 1))
    return [
        relation_chart(yearly, years, "hoseg", fit_linear, "Minél melegebb a nyár, annál több a hőségnap",
                       "Hőségnapok (legalább 30 °C) / év", "nap", (0, 70)),
        relation_chart(yearly, years, "tropusi", fit_poisson, "A trópusi éjszakák gyorsulva szaporodnak",
                       "Trópusi éjszakák (legalább 20 °C) / év", "éjszaka", (0, 40)),
        time_chart(yearly, years, "t_nyar", "A nyár egyre melegebb", "Nyári középhőmérséklet (°C)", "°C",
                   (18, 25), 1, 1981),
        time_chart(yearly, years, "esonap", "Egyre kevesebb napon esik", "Esős napok (legalább 1 mm) / év", "nap",
                   (55, 120), 0, years[0]),
        time_chart(yearly, years, "nagyeso", "Egyre több csapadék jön nagy esőkből",
                   "Legalább 20 mm-es napokból (%)", "%", (0, 45), 0, years[0]),
        time_chart(yearly, years, "csap", "Az éves csapadék: nincs egyértelmű irány", "Éves csapadék (mm)", "mm",
                   (300, 950), 0, years[0], show_2050=False),
    ]
