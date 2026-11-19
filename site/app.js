/* Thun Missives — readings viewer. No build step, no framework.
   Forked from the St. Gallen Missives viewer (DHBern/sg-missiven-data): no
   edition, no scores; the register is generated from the automatic tagging. The unit is the letter (readings/letters.tsv,
   split by the scan file names), with its pages, their machine readings, the
   page images from Transkribus (IIIF) and, where one exists, a regest drafted
   by a language model. */
(() => {
  "use strict";
  const app = document.getElementById("app");
  const state = { index: null, readers: null, chunks: new Map(), filter: "", osd: null, pagekeys: null };
  const store = {
    get(k, d) { try { const v = localStorage.getItem("thm:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("thm:" + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  state.reader = store.get("reader", "");
  state.mode = store.get("mode", "plain");
  const IIIF = "https://files.transkribus.eu/iiif/2/";

  /* Language: ?lang=de|en, else the viewer's last choice, else the browser's. */
  const urlLang = new URLSearchParams(location.search).get("lang");
  let LANG = ["de", "en"].includes(urlLang) ? urlLang
    : store.get("lang", (navigator.language || "en").toLowerCase().startsWith("de") ? "de" : "en");
  /* T("English", "Deutsch"): every visible string in both languages, side by side */
  const T = (en, de) => (LANG === "de" ? de : en);
  const P = (n, en1, enN, de1, deN) => (n === 1 ? T(en1, de1) : T(enN, deN));
  const loc = (r, k) => (LANG === "de" && r[k + "_de"]) || r[k] || "";
  const num = (n) => Number(n).toLocaleString(LANG === "de" ? "de-CH" : "en-GB");
  function applyLang() {
    document.documentElement.lang = LANG;
    document.title = T("Thun Missives Readings", "Thuner Missiven: Lesungen");
    const nav = { letters: T("Letters", "Briefe"), search: T("Search", "Suche"), places: T("Places", "Orte"), names: T("Names", "Namen"), keywords: T("Keywords", "Schlagwörter"), readers: T("Readers", "Leser"), about: T("About", "Über") };
    document.querySelectorAll("[data-nav]").forEach((a) => { a.textContent = nav[a.dataset.nav]; });
    const brand = document.querySelector(".brand");
    if (brand) brand.innerHTML = `${T("Thun Missives", "Thuner Missiven")} <span>· ${T("readings", "Lesungen")}</span>`;
    document.querySelectorAll("[data-lang]").forEach((b) => {
      b.classList.toggle("on", b.dataset.lang === LANG);
      b.setAttribute("aria-pressed", String(b.dataset.lang === LANG));
    });
  }
  function setLang(l) {
    LANG = l;
    store.set("lang", l);
    const u = new URL(location.href);
    u.searchParams.set("lang", l);
    history.replaceState(null, "", u);
    applyLang();
    destroyOsd();
    route();
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (x) => (x == null ? "–" : (x * 100).toFixed(1).replace(".", LANG === "de" ? "," : ".") + " %");
  const json = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(p + ": " + r.status); return r.json(); });
  const readerLabel = (id) => { const r = (state.readers || []).find((x) => x.id === id); return r ? loc(r, "label") : (id || T("a machine reading", "einer maschinellen Lesung")); };
  /* "BAT 663.1, Nr. 500" / "BAT 663.1, no. 500" */
  const titleOf = (l) => `BAT ${l.shelf}, ${T("no.", "Nr.")} ${l.nr}`;
  const thumb = (tk) => `${IIIF}${encodeURIComponent(tk)}/full/200,/0/default.jpg`;
  /* r, v, r2, v1 … -> Recto, Verso, Recto 2, Verso 1 */
  function sideLabel(s) {
    const m = /^([rv])(\d*)$/i.exec(s || "");
    if (!m) return s || "";
    return (m[1].toLowerCase() === "r" ? "Recto" : "Verso") + (m[2] ? " " + m[2] : "");
  }
  const noteLabel = (n) => ({ aufgeklappt: T("opened out", "aufgeklappt"), "weitere Aufnahme": T("further scan", "weitere Aufnahme") }[n] || n || "");
  const pageLabel = (p) => sideLabel(p.side) + (p.note && !p.extra ? ` (${noteLabel(p.note)})` : "");
  const DIGI = () => T("The letters were digitised by the University of Zurich (Chair of Prof. Simon Teuscher); the images are served by Transkribus.",
    "Die Digitalisierung erfolgte durch die Universität Zürich (Lehrstuhl Prof. Simon Teuscher); die Bilder liefert Transkribus.");

  /* ---------- dates (dates/dates.jsonl, scripts/dates.py) and keywords ---------- */
  const WD = { Mo: ["Mon", "Mo"], Di: ["Tue", "Di"], Mi: ["Wed", "Mi"], Do: ["Thu", "Do"], Fr: ["Fri", "Fr"], Sa: ["Sat", "Sa"], So: ["Sun", "So"] };
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  /* "Fr 18.3.1440" / "Fri 18 Mar 1440" from an ISO date (Julian, as dates.py computed it) */
  function dayLabel(iso, wd) {
    const [y, m, d] = iso.split("-").map(Number);
    const w = WD[wd] ? T(WD[wd][0], WD[wd][1]) + " " : "";
    return w + T(`${d} ${MON[m - 1]} ${y}`, `${d}.${m}.${y}`);
  }
  /* short date for a list row: the day, else the year, "?" when the century is not written */
  const shortDate = (l) => (l.d ? dayLabel(l.d) : l.y ? String(l.y) : "") + (l.y && l.yu ? "?" : "");
  const WD_DE = { Mo: "Montag", Di: "Dienstag", Mi: "Mittwoch", Do: "Donnerstag", Fr: "Freitag", Sa: "Samstag", So: "Sonntag" };
  const WD_EN = { Mo: "Monday", Di: "Tuesday", Mi: "Wednesday", Do: "Thursday", Fr: "Friday", Sa: "Saturday", So: "Sunday" };
  const HOW = {
    "figures": ["read from the date line, where the day is written in figures", "aus der Datumszeile, wo der Tag in Ziffern steht"],
    "figures (ultima)": ["read from the date line: the last day of the month", "aus der Datumszeile: der letzte Tag des Monats"],
    "figures (penultima)": ["read from the date line: the last day but one of the month", "aus der Datumszeile: der zweitletzte Tag des Monats"],
    "feast day": ["computed: the feast day named in the date line", "berechnet: der Festtag, den die Datumszeile nennt"],
    "eve of a feast": ["computed: the eve of the feast named in the date line", "berechnet: der Vorabend des Festes, das die Datumszeile nennt"],
    "weekday after a feast": ["computed: the weekday after the feast named in the date line", "berechnet: der Wochentag nach dem Fest, das die Datumszeile nennt"],
    "weekday before a feast": ["computed: the weekday before the feast named in the date line", "berechnet: der Wochentag vor dem Fest, das die Datumszeile nennt"],
    "day after a feast": ["computed: the day after the feast named in the date line", "berechnet: der Tag nach dem Fest, das die Datumszeile nennt"],
    "octave of a feast": ["computed: the octave of the feast named in the date line", "berechnet: die Oktav des Festes, das die Datumszeile nennt"],
    "no day": ["year only: no day could be read from the date line", "nur das Jahr: Aus der Datumszeile liess sich kein Tag lesen"],
    "weekday not read": ["year only: the feast was found, the weekday before or after it was not", "nur das Jahr: Das Fest ist gefunden, der Wochentag davor oder danach nicht"],
  };
  function dateBlock(dt) {
    if (!dt) return "";
    const line = dt.date_text ? `<span class="dline">${T("Date line (machine reading)", "Datumszeile (maschinelle Lesung)")}: <q lang="und">${esc(dt.date_text)}</q></span>` : "";
    if (!dt.year) return `<div class="ldate"><p class="small muted">${T("No year could be read from the date line.", "Aus der Datumszeile liess sich kein Jahr lesen.")} ${line}</p></div>`;
    const head = dt.date ? `${esc(dayLabel(dt.date, dt.weekday))} <span class="cal">${T("(Julian)", "(julianisch)")}</span>` : esc(dt.year) + (dt.century !== "written" ? "?" : "");
    let how = HOW[dt.how] ? T(...HOW[dt.how]) : (dt.how || "");
    if (dt.feast) {  // name the feast the day was counted from
      const f = esc(dt.feast);
      const named = {
        "feast day": [`computed: the feast day, ${f}`, `berechnet: der Festtag ${f}`],
        "eve of a feast": [`computed: the eve of ${f}`, `berechnet: der Vorabend von ${f}`],
        "weekday after a feast": [`computed: the ${esc(dt.weekday ? WD_EN[dt.weekday] || dt.weekday : "weekday")} after ${f}`, `berechnet: ${esc(dt.weekday ? WD_DE[dt.weekday] || dt.weekday : "Wochentag")} nach ${f}`],
        "weekday before a feast": [`computed: the ${esc(dt.weekday ? WD_EN[dt.weekday] || dt.weekday : "weekday")} before ${f}`, `berechnet: ${esc(dt.weekday ? WD_DE[dt.weekday] || dt.weekday : "Wochentag")} vor ${f}`],
        "day after a feast": [`computed: the day after ${f}`, `berechnet: der Tag nach ${f}`],
        "octave of a feast": [`computed: the octave of ${f}`, `berechnet: die Oktav von ${f}`],
      }[dt.how];
      if (named) how = T(...named);
    }
    const notes = [];
    if (dt.century === "neighbours") notes.push(T("Only the last digits of the year are written; the century is taken from the dated letters around it in the same volume, so the year is uncertain.",
      "Vom Jahr sind nur die letzten Ziffern geschrieben; das Jahrhundert ist von den datierten Briefen in der Nähe im selben Band genommen, das Jahr ist darum unsicher."));
    else if (dt.century === "default") notes.push(T("Only the last digits of the year are written; the 15th century is assumed, so the year is uncertain.",
      "Vom Jahr sind nur die letzten Ziffern geschrieben; das 15. Jahrhundert ist angenommen, das Jahr ist darum unsicher."));
    const warn = [];
    if (dt.weekday_check === "mismatch") warn.push(T(`The weekday written in the date line does not match the computed day in ${dt.year}${dt.weekday_fits && dt.weekday_fits.length ? ` (it would fit ${dt.weekday_fits.join(", ")})` : ""}: the year or the day may be misread.`,
      `Der Wochentag in der Datumszeile passt nicht zum berechneten Tag im Jahr ${dt.year}${dt.weekday_fits && dt.weekday_fits.length ? ` (er passte ${dt.weekday_fits.join(", ")})` : ""}: Jahr oder Tag sind vielleicht falsch gelesen.`));
    if (dt.year_start) warn.push(T(`Bern began the year at Christmas: a letter of 25–31 December “${dt.year}” may have been written in December ${dt.year - 1} by our count.`,
      `Bern begann das Jahr an Weihnachten: Ein Brief vom 25.–31. Dezember «${dt.year}» ist nach unserer Zählung vielleicht im Dezember ${dt.year - 1} geschrieben.`));
    if (dt.weekday_check === "ok") notes.push(T("The weekday written in the date line matches the computed day.", "Der Wochentag in der Datumszeile passt zum berechneten Tag."));
    return `<div class="ldate">
      <p><b>${head}</b>${how ? ` <span class="small muted">· ${esc(how)}</span>` : ""}</p>
      ${warn.map((w) => `<p class="caveat">${esc(w)}</p>`).join("")}
      <p class="small muted">${notes.map(esc).join(" ")} ${line}</p>
    </div>`;
  }
  /* keywords are terms of the St. Gallen edition's vocabulary, in German in both languages */
  function kwChips(terms) {
    if (!terms || !terms.length) return "";
    return `<div class="kw kwl"><span class="kwlab">${T("Keywords (machine-assigned)", "Schlagwörter (maschinell)")}:</span>${terms.map((k) =>
      `<a href="#/search?kw=${encodeURIComponent(k)}" lang="de" title="${esc(T(`${num(state.kw.get(k) || 0)} letters`, `${num(state.kw.get(k) || 0)} Briefe`))}">${esc(k)}</a>`).join("")}</div>`;
  }

  /* ---------- overview: letters per decade, and the keywords ---------- */
  function timelineHtml() {
    const ls = state.index.letters, dated = ls.filter((l) => l.y);
    if (!dated.length) return "";
    const by = new Map();
    for (const l of dated) {
      const k = Math.floor(l.y / 10) * 10, c = by.get(k) || { w: 0, n: 0 };
      l.yu ? c.n++ : c.w++;
      by.set(k, c);
    }
    const decs = [...by.keys()].sort((a, b) => a - b);
    const tot = (k) => (by.get(k) ? by.get(k).w + by.get(k).n : 0);
    /* the dense range: from the first decade with 10 letters to the last with 5; the rest is noted */
    const lo = decs.find((k) => tot(k) >= 10) ?? decs[0], hi = [...decs].reverse().find((k) => tot(k) >= 5) ?? decs[decs.length - 1];
    const range = [];
    for (let k = lo; k <= hi; k += 10) range.push(k);
    const before = decs.filter((k) => k < lo), after = decs.filter((k) => k > hi);
    const sumOf = (ks) => ks.reduce((n, k) => n + tot(k), 0);
    const decLink = (ks) => "#/search?" + ks.map((k) => "dec=" + k).join("&");
    const max = Math.max(...range.map(tot));
    const step = max > 400 ? 200 : max > 150 ? 50 : max > 40 ? 20 : 5;
    const ticks = []; for (let v = step; v <= max; v += step) ticks.push(v);
    const top = Math.max(max, ticks[ticks.length - 1] || max);
    const busiest = range.reduce((a, k) => (tot(k) > tot(a) ? k : a), range[0]);
    const zoom = state.zoom && by.has(state.zoom) ? state.zoom : busiest;
    const bar = (label, c, href, tip, minor) => {
      const t = c.w + c.n;
      return `<a class="tl-bar" href="${href}" data-tip="${esc(tip)}" aria-label="${esc(tip)}">
        <span class="tl-col">${c.w ? `<i class="w" style="height:${(c.w / top) * 100}%"></i>` : ""}${c.n ? `<i class="n" style="height:${(c.n / top) * 100}%"></i>` : ""}${t === max ? `<span class="tl-val" style="bottom:${(t / top) * 100}%">${num(t)}</span>` : ""}</span>
        <span class="tl-x${minor ? " minor" : ""}">${label}</span></a>`;
    };
    const tipOf = (lab, c) => `${lab}: ${num(c.w + c.n)} ${P(c.w + c.n, "letter", "letters", "Brief", "Briefe")} · ${num(c.w)} ${T("year written in full", "Jahr ausgeschrieben")} · ${num(c.n)} ${T("century from neighbours", "Jahrhundert aus der Nachbarschaft")}`;
    const grid = (vals, tp) => `<span class="tl-grid" aria-hidden="true">${vals.map((v) => `<span style="bottom:${(v / tp) * 100}%"><b>${num(v)}</b></span>`).join("")}</span>`;
    const decBars = range.map((k, i) => bar(i % 2 === 0 || range.length < 12 ? String(k) : "", by.get(k) || { w: 0, n: 0 }, decLink([k]), tipOf(T(`${k}s`, `${k}er`), by.get(k) || { w: 0, n: 0 }), range.length >= 12 && i % 4 !== 0)).join("");
    /* the years of one decade */
    const yc = new Map();
    for (const l of dated) if (Math.floor(l.y / 10) * 10 === zoom) { const c = yc.get(l.y) || { w: 0, n: 0 }; l.yu ? c.n++ : c.w++; yc.set(l.y, c); }
    const ymax = Math.max(1, ...[...yc.values()].map((c) => c.w + c.n));
    const ystep = ymax > 100 ? 50 : ymax > 40 ? 20 : ymax > 10 ? 5 : 1;
    const yticks = []; for (let v = ystep; v <= ymax; v += ystep) yticks.push(v);
    const ytop = Math.max(ymax, yticks[yticks.length - 1] || ymax);
    const ybar = (y) => {
      const c = yc.get(y) || { w: 0, n: 0 }, t = c.w + c.n;
      const tip = tipOf(String(y), c);
      return `<a class="tl-bar" href="#/search?yr=${y}" data-tip="${esc(tip)}" aria-label="${esc(tip)}">
        <span class="tl-col">${c.w ? `<i class="w" style="height:${(c.w / ytop) * 100}%"></i>` : ""}${c.n ? `<i class="n" style="height:${(c.n / ytop) * 100}%"></i>` : ""}${t && t === ymax ? `<span class="tl-val" style="bottom:${(t / ytop) * 100}%">${num(t)}</span>` : ""}</span>
        <span class="tl-x">${String(y).slice(2)}</span></a>`;
    };
    const written = dated.filter((l) => !l.yu).length;
    return `<section class="overview tl" aria-labelledby="tl-h">
      <h2 id="tl-h">${T("Letters by decade", "Briefe nach Jahrzehnt")}</h2>
      <p class="small muted">${T(`${num(dated.length)} of ${num(ls.length)} letters have a year; ${num(ls.length - dated.length)} have none that could be read. Click a bar to search those letters.`,
        `${num(dated.length)} von ${num(ls.length)} Briefen haben ein Jahr; ${num(ls.length - dated.length)} haben keines, das sich lesen liess. Ein Klick auf einen Balken sucht diese Briefe.`)}</p>
      <div class="tl-legend small"><span><i class="w"></i>${T("year written in full", "Jahr ausgeschrieben")} (${num(written)})</span>
        <span><i class="n"></i>${T("century taken from neighbouring letters: uncertain", "Jahrhundert aus benachbarten Briefen: unsicher")} (${num(dated.length - written)})</span></div>
      <div class="tl-chart" role="group" aria-label="${T("Letters per decade", "Briefe pro Jahrzehnt")}">${grid(ticks, top)}<div class="tl-bars">${decBars}</div></div>
      <p class="small muted tl-out">${before.length ? `<a href="${decLink(before)}">${T(`Before ${lo}: ${num(sumOf(before))} letters`, `Vor ${lo}: ${num(sumOf(before))} Briefe`)}</a> (${before[0]}–${before[before.length - 1] + 9})` : ""}
        ${before.length && after.length ? " · " : ""}${after.length ? `<a href="${decLink(after)}">${T(`After ${hi + 9}: ${num(sumOf(after))} letters`, `Nach ${hi + 9}: ${num(sumOf(after))} Briefe`)}</a> (${T("up to", "bis")} ${after[after.length - 1] + 9})` : ""}
        ${before.length || after.length ? T(" — a year far from the rest is more likely misread than not.", " – ein Jahr weit weg von den übrigen ist eher falsch gelesen als nicht.") : ""}</p>
      <div class="tl-zoomhead"><h3 id="tl-zh">${T("Years of the", "Jahre der")}</h3>
        <select id="tl-zoom" aria-labelledby="tl-zh">${range.filter((k) => tot(k)).map((k) => `<option value="${k}" ${k === zoom ? "selected" : ""}>${T(`${k}s`, `${k}er`)} (${num(tot(k))})</option>`).join("")}</select></div>
      <div class="tl-chart tl-years" role="group" aria-label="${T("Letters per year", "Briefe pro Jahr")}">${grid(yticks, ytop)}<div class="tl-bars">${Array.from({ length: 10 }, (_, i) => ybar(zoom + i)).join("")}</div></div>
      <details class="tl-table small"><summary>${T("Table", "Tabelle")}</summary><div class="scroll"><table class="scores">
        <thead><tr><th>${T("Decade", "Jahrzehnt")}</th><th>${T("Letters", "Briefe")}</th><th>${T("year written", "Jahr ausgeschrieben")}</th><th>${T("century from neighbours", "Jahrhundert aus Nachbarn")}</th></tr></thead>
        <tbody>${decs.map((k) => `<tr><td><a href="${decLink([k])}">${T(`${k}s`, `${k}er`)}</a></td><td class="n">${num(tot(k))}</td><td class="n">${num(by.get(k).w)}</td><td class="n">${num(by.get(k).n)}</td></tr>`).join("")}</tbody></table></div></details>
      <p class="small muted">${T(`Dates are read by rule (scripts/dates.py) from the date line that the machine-drafted regest quotes from a machine reading; nothing is checked by a person.
          A day computed from a feast is a date in the Julian calendar, which Bern kept until 1701. Where only the last digits of the year are written, the century comes from the dated letters around it in the same volume and is uncertain.`,
        `Die Daten sind nach Regeln (scripts/dates.py) aus der Datumszeile gelesen, die der Maschinenentwurf des Regests aus einer maschinellen Lesung zitiert; niemand hat sie geprüft.
          Ein aus einem Fest berechneter Tag ist ein Datum im julianischen Kalender, den Bern bis 1701 behielt. Wo vom Jahr nur die letzten Ziffern geschrieben sind, stammt das Jahrhundert von den datierten Briefen in der Nähe im selben Band und ist unsicher.`)}</p>
    </section>`;
  }

  function keywordsHtml() {
    const voc = state.index.vocabulary;
    if (!voc || !state.kw.size) return `<p class="small muted kw-soon">${T("Keywords will follow.", "Schlagwörter folgen.")}</p>`;
    const ls = state.index.letters;
    const withKw = ls.filter((l) => l.k && l.k.length).length;
    const terms = [...state.kw.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "de"));
    const max = terms[0][1];
    const row = ([k, c]) => `<a class="kwrow" href="${kwHref(k)}"><span class="kl" lang="de">${esc(k)}</span><span class="kb"><i style="width:${(c / max) * 100}%"></i></span><span class="kn">${num(c)}</span></a>`;
    const TOP = 40;
    return `<section class="overview kwov" aria-labelledby="kw-h">
      <h2 id="kw-h">${T("Keywords", "Schlagwörter")}</h2>
      <p class="small muted">${T(`${num(withKw)} of ${num(ls.length)} letters have keywords, ${num(terms.length)} different terms. A language model assigned them from the machine-drafted regests, choosing from the ${num(voc.terms)} keywords of the St. Gallen Missives edition; unchecked. Click a keyword for its page: its letters, its companions and their decades.`,
        `${num(withKw)} von ${num(ls.length)} Briefen haben Schlagwörter, ${num(terms.length)} verschiedene. Ein Sprachmodell hat sie aus den maschinell entworfenen Regesten vergeben, gewählt aus den ${num(voc.terms)} Schlagwörtern der Edition der St. Galler Missiven; ungeprüft. Ein Klick auf ein Schlagwort öffnet seine Seite: seine Briefe, seine Begleiter und deren Jahrzehnte.`)}</p>
      <p class="small"><a href="#/keywords">${T("Keywords over time (heatmap) →", "Schlagwörter über die Zeit (Heatmap) →")}</a> · <a href="#/keywords/network">${T("Keyword network →", "Netzwerk der Schlagwörter →")}</a></p>
      <div class="kwlist">${terms.slice(0, TOP).map(row).join("")}</div>
      ${terms.length > TOP ? `<details class="kwmore"><summary>${T(`Show all ${num(terms.length)}`, `Alle ${num(terms.length)} anzeigen`)}</summary><div class="kwlist">${terms.slice(TOP).map(row).join("")}</div></details>` : ""}
    </section>`;
  }

  /* hover / focus tooltip on the timeline bars */
  function tlTip(ev) {
    const b = ev.target.closest && ev.target.closest(".tl-bar");
    if (!b) { if (ev.type === "mouseout" || ev.type === "focusout") hideTip(); return; }
    hideTip();
    tipEl = document.createElement("div");
    tipEl.className = "tip";
    tipEl.textContent = b.dataset.tip;
    document.body.appendChild(tipEl);
    const r = b.getBoundingClientRect(), w = tipEl.offsetWidth;
    tipEl.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
    tipEl.style.top = Math.max(8, r.top - tipEl.offsetHeight - 6) + "px";
    tipEl.style.pointerEvents = "none";
  }

  async function boot() {
    [state.index, state.readers] = await Promise.all([json("data/index.json"), json("data/readers.json")]);
    state.pos = new Map(state.index.letters.map((l, i) => [l.id, i]));
    /* keyword term -> number of letters; empty until keywords/assigned.jsonl exists */
    state.kw = new Map();
    for (const l of state.index.letters) for (const k of l.k || []) state.kw.set(k, (state.kw.get(k) || 0) + 1);
    if (!state.readers.some((r) => r.id === state.reader)) state.reader = state.readers.length ? state.readers[0].id : "";
    window.addEventListener("hashchange", route);
    document.querySelectorAll("[data-lang]").forEach((b) => b.addEventListener("click", () => setLang(b.dataset.lang)));
    document.addEventListener("keydown", pageKeys);
    applyLang();
    route();
  }

  function setNav(which) {
    if (which !== "search") clearTimeout(searchTimer);
    document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === which));
  }

  function route() {
    hideTip();
    destroyMaps();
    const [path, qs] = location.hash.replace(/^#\/?/, "").split("?");
    const parts = path.split("/").map(decodeURIComponent);
    /* a new view starts at the top (a letter keeps its own scrolling between its pages) */
    const view = parts[0] === "letter" ? "letter/" + parts[1] : path;
    if (state.lastView !== undefined && state.lastView !== view) window.scrollTo(0, 0);
    state.lastView = view;
    if (parts[0] !== "letter") { destroyOsd(); cur = null; }
    if (parts[0] === "search") return showSearch(new URLSearchParams(qs || ""));
    if (parts[0] === "places" || parts[0] === "names") return showRegister(parts[0], new URLSearchParams(qs || ""));
    if (parts[0] === "entry" && parts[1]) return showEntry(parts[1]);
    if (parts[0] === "keywords" && parts[1] === "network") return showKeywordNetwork(new URLSearchParams(qs || ""));
    if (parts[0] === "keywords") return showKeywords();
    if (parts[0] === "keyword" && parts[1]) return showKeyword(parts[1]);
    if (parts[0] === "letter" && parts[1]) return showLetter(parts[1], +(parts[2] || 1), parts[3]);
    /* old links: #/doc/<Transkribus document>/<page>/<reader>, and #/page/<page key> */
    if (parts[0] === "doc" && parts[1]) return toPageKey(`${parts[1]}_p${String(+(parts[2] || 1)).padStart(4, "0")}`, parts[3]);
    if (parts[0] === "page" && parts[1]) return toPageKey(parts[1], parts[2]);
    if (parts[0] === "readers") return showReaders();
    if (parts[0] === "about") return showAbout();
    return showList();
  }

  async function toPageKey(key, reader) {
    if (!state.pagekeys) state.pagekeys = json("data/pagekeys.json");
    const hit = (await state.pagekeys)[key];
    if (!hit) { app.innerHTML = `<p>${T("No page", "Keine Seite")} ${esc(key)}. <a href="#/">${T("All letters", "Alle Briefe")}</a></p>`; return; }
    location.replace(`#/letter/${encodeURIComponent(hit[0])}/${hit[1]}${reader ? "/" + encodeURIComponent(reader) : ""}`);
  }

  /* ---------- register (registers/*.json via site/data/registers.json) ----------
     Generated automatically from the tagging (scripts/register.py, docs/REGISTER.md):
     every entry and every link is a proposal, graded by St. Gallen's rules. The
     list, entry and map code is adapted from the St. Gallen viewer. */
  function loadRegisters() {
    if (!state.index.registers) return Promise.resolve(null);
    if (!state.regP) {
      state.regP = json("data/registers.json").then((r) => {
        const byLetter = new Map();
        for (const [id, e] of Object.entries(r.entries)) {
          const f = { place: "pl", person: "per", org: "org" }[e.k];
          for (const lid of e.l) {
            if (!byLetter.has(lid)) byLetter.set(lid, { pl: [], per: [], org: [] });
            byLetter.get(lid)[f].push(id);
          }
        }
        state.reg = r; state.regByLetter = byLetter;
        return r;
      }).catch(() => null);
    }
    return state.regP;
  }
  const GRADE = () => ({ "sicher": T("certain", "sicher"), "wahrscheinlich": T("likely", "wahrscheinlich"), "möglich": T("possible", "möglich") });
  const SRC = () => ({ "hls": "HLS", "ssrq": "SSRQ", "kf": T("Königsfelden", "Königsfelden"), "st-gallen": T("St. Gallen", "St. Gallen") });
  const LINK_LABEL = { "hls": "HLS", "ssrq": "SSRQ", "kf": "Königsfelden", "st-gallen": "St. Gallen", "gnd": "GND", "ortsnamen": "ortsnamen.ch", "wikidata": "Wikidata" };
  const kindName = (k) => ({ place: T("place", "Ort"), person: T("person", "Person"), org: T("organisation", "Organisation") }[k] || k);
  const nLetters = (e) => e.l.length;
  const best = (e) => (e.c || [])[0];
  /* "(measured in St. Gallen: 74 % right)" for a candidate's rule and grade */
  function precision(c, kind) {
    const m = ((state.reg || {}).measured || {})[c.rule];
    const kk = kind === "person" ? "per" : kind;
    const v = m && m[kk] && m[kk][c.grade];
    if (!v) return c.rule === "sg-formula" || c.rule === "org" || c.rule === "sg-register" ? T("not measured", "nicht gemessen") : "";
    return T(`measured in St. Gallen: ${Math.round((100 * v[0]) / v[1])} % right (${v[0]}/${v[1]})`, `in St. Gallen gemessen: ${Math.round((100 * v[0]) / v[1])} % richtig (${v[0]}/${v[1]})`);
  }
  function candLinks(c) {
    return (c.links || []).map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(LINK_LABEL[l.type] || l.type)}</a>`).join("");
  }
  const gradeChip = (c, kind) => `<span class="grade g-${esc(c.grade)}" title="${esc(precision(c, kind))}">${esc(GRADE()[c.grade] || c.grade)}</span>`;
  const autoBadge = () => `<span class="badge gen" title="${esc(T("Generated automatically from the automatic tagging; unchecked", "Automatisch aus der automatischen Auszeichnung generiert; ungeprüft"))}">${T("automatic", "automatisch")}</span>`;
  const candDesc = (c) => [
    c.desc, c.region, c.type,
    c.birth || c.death ? `${c.birth || "?"}–${c.death || "?"}` : "",
    c.first ? T(`attested ${c.first}${c.last && c.last !== c.first ? "–" + c.last : ""}`, `belegt ${c.first}${c.last && c.last !== c.first ? "–" + c.last : ""}`) : "",
    c.km != null ? T(`${num(c.km)} km from Thun`, `${num(c.km)} km von Thun`) : "",
  ].filter(Boolean).join(" · ");

  function regIntro(which) {
    const r = state.reg, es = Object.values(r.entries);
    const kinds = which === "places" ? ["place"] : ["person", "org"];
    const n = (k) => es.filter((e) => e.k === k).length;
    return `<section class="intro">
      <h1>${which === "places" ? T("Places", "Orte") : T("Names", "Namen")}</h1>
      <p>${which === "places"
        ? T(`${num(n("place"))} places, generated automatically from the names that the automatic tagging found in the letters, one entry per settlement where the spellings could be joined.`,
            `${num(n("place"))} Orte, automatisch generiert aus den Namen, die die automatische Auszeichnung in den Briefen gefunden hat, ein Eintrag pro Siedlung, wo sich die Schreibungen zusammenführen liessen.`)
        : T(`${num(n("person"))} persons and ${num(n("org"))} organisations, generated automatically from the names that the automatic tagging found in the letters. A person is a name within 30 years; the same name later is another entry.`,
            `${num(n("person"))} Personen und ${num(n("org"))} Organisationen, automatisch generiert aus den Namen, die die automatische Auszeichnung in den Briefen gefunden hat. Eine Person ist ein Name innerhalb von 30 Jahren; derselbe Name später ist ein weiterer Eintrag.`)}
      ${T(`Each entry is matched against HLS, the SSRQ, the Königsfelden edition and the St. Gallen Missives; every link is a proposal graded <b>certain</b>, <b>likely</b> or <b>possible</b> by St. Gallen's rules, with the precision St. Gallen measured for that rule. Nothing here is checked by a person; the tagger itself is not measured on Thun.`,
        `Jeder Eintrag ist mit dem HLS, der SSRQ, der Königsfelder Edition und den St. Galler Missiven abgeglichen; jeder Link ist ein Vorschlag, nach den Regeln aus St. Gallen als <b>sicher</b>, <b>wahrscheinlich</b> oder <b>möglich</b> eingestuft, mit der Trefferquote, die St. Gallen für die Regel gemessen hat. Nichts hier ist von einem Menschen geprüft; die Auszeichnung selbst ist an Thun nicht gemessen.`)}
      <a href="https://github.com/DHBern/thun-missiven-data/blob/main/docs/REGISTER.md" target="_blank" rel="noopener">docs/REGISTER.md</a></p>
    </section>`;
  }

  async function showRegister(which, params) {
    setNav(which);
    app.innerHTML = `<p class="muted">${T("Loading…", "Wird geladen…")}</p>`;
    const r = await loadRegisters();
    if (!r) { app.innerHTML = `<p>${T("No register yet.", "Noch kein Register.")}</p>`; return; }
    const kinds = which === "places" ? ["place"] : ["person", "org"];
    const all = Object.entries(r.entries).filter(([, e]) => kinds.includes(e.k)).sort((a, b) => nLetters(b[1]) - nLetters(a[1]) || a[1].n.localeCompare(b[1].n, "de"));
    const f = state.regFilter = state.regFilter || {};
    if (params.get("nogeo")) f.nogeo = true;
    const noGeo = all.filter(([, e]) => !e.g || e.gg !== "wahrscheinlich").length;
    const cnt = (pred) => all.filter(([, e]) => pred(e)).length;
    app.innerHTML = regIntro(which) + `
      <div class="filters">
        <input id="rq" type="search" placeholder="${T("Search names and spellings…", "Namen und Schreibungen suchen…")}" value="${esc(f[which] || "")}" aria-label="${T("Search the register", "Register durchsuchen")}">
        ${which === "names" ? `<select id="rt" aria-label="${T("Kind", "Art")}"><option value="">${T("Persons and organisations", "Personen und Organisationen")}</option><option value="person" ${f.kind === "person" ? "selected" : ""}>${T("Persons", "Personen")} (${num(cnt((e) => e.k === "person"))})</option><option value="org" ${f.kind === "org" ? "selected" : ""}>${T("Organisations", "Organisationen")} (${num(cnt((e) => e.k === "org"))})</option></select>` : ""}
        <select id="rgr" aria-label="${T("Best link", "Bester Link")}">
          <option value="">${T("Any link", "Alle")}</option>
          ${["sicher", "wahrscheinlich", "möglich"].map((g) => `<option value="${g}" ${f.grade === g ? "selected" : ""}>${T("best link", "bester Link")} ${GRADE()[g]} (${num(cnt((e) => best(e) && best(e).grade === g))})</option>`).join("")}
          <option value="none" ${f.grade === "none" ? "selected" : ""}>${T("no candidate", "kein Kandidat")} (${num(cnt((e) => !best(e)))})</option>
        </select>
        <select id="rsrc" aria-label="${T("Source", "Quelle")}"><option value="">${T("Any source", "Alle Quellen")}</option>
          ${Object.entries(SRC()).map(([k, l]) => `<option value="${k}" ${f.src === k ? "selected" : ""}>${T("best link from", "bester Link aus")} ${esc(l)} (${num(cnt((e) => best(e) && (best(e).srcs || []).includes(k)))})</option>`).join("")}</select>
        <label class="small"><input type="checkbox" id="rmany" ${f.many ? "checked" : ""}> ${T("in two letters or more", "in zwei Briefen oder mehr")}</label>
        ${which === "places" ? `<label class="small"><input type="checkbox" id="rg" ${f.nogeo ? "checked" : ""}> ${T("not on the map", "nicht auf der Karte")} (${num(noGeo)})</label>` : ""}
        <span id="rcount" class="muted small"></span>
      </div>
      <div class="list reg" id="rlist"></div>`;
    const $ = (id) => document.getElementById(id);
    const draw = () => {
      f[which] = $("rq").value; f.grade = $("rgr").value; f.src = $("rsrc").value; f.many = $("rmany").checked;
      if (which === "names") f.kind = $("rt").value;
      if (which === "places") f.nogeo = $("rg").checked;
      const words = $("rq").value.toLowerCase().split(/\s+/).filter(Boolean);
      const rows = all.filter(([, e]) => {
        const b = best(e);
        if (which === "names" && f.kind && e.k !== f.kind) return false;
        if (f.grade && (f.grade === "none" ? b : !b || b.grade !== f.grade)) return false;
        if (f.src && (!b || !(b.srcs || []).includes(f.src))) return false;
        if (f.many && nLetters(e) < 2) return false;
        if (which === "places" && f.nogeo && e.g && e.gg === "wahrscheinlich") return false;
        if (!words.length) return true;
        const hay = [e.n, ...e.f.map((x) => x[0]), b ? b.label : ""].join(" ").toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      $("rcount").textContent = `${num(rows.length)} ${P(rows.length, "entry", "entries", "Eintrag", "Einträge")}`;
      $("rlist").innerHTML = rows.slice(0, 400).map(([id, e]) => {
        const b = best(e), n = nLetters(e);
        return `<div class="row rrow">
          <span class="num">${num(n)}<span class="muted small"> ${P(n, "letter", "letters", "Brief", "Briefe")}</span></span>
          <span><a class="who go" href="#/entry/${encodeURIComponent(id)}">${esc(e.n)}</a>${e.y ? ` <span class="muted small">${e.y[0]}${e.y[1] !== e.y[0] ? "–" + e.y[1] : ""}</span>` : ""}
            <span class="reg">${esc(kindName(e.k))}${e.f.length > 1 ? ` · ${e.f.slice(0, 4).map((x) => esc(x[0])).join(", ")}` : ""}${b ? ` · ${esc(b.label)}?` : ` · ${T("no candidate found", "kein Kandidat gefunden")}`}</span></span>
          <span class="ext">${b ? gradeChip(b, e.k) : ""}${b ? candLinks(b) : ""}</span>
        </div>`;
      }).join("") + (rows.length > 400 ? `<p class="muted small">${T(`Showing 400 of ${num(rows.length)}: narrow the search.`, `400 von ${num(rows.length)} angezeigt: Suche eingrenzen.`)}</p>` : "");
    };
    ["rq", "rgr", "rsrc", "rmany", "rt", "rg"].forEach((id) => { const el = $(id); el && el.addEventListener(id === "rq" ? "input" : "change", draw); });
    draw();
  }

  async function showEntry(id) {
    app.innerHTML = `<p class="muted">${T("Loading…", "Wird geladen…")}</p>`;
    const r = await loadRegisters();
    const e = r && r.entries[id];
    if (!e) { setNav("places"); app.innerHTML = `<p>${T("No register entry", "Kein Registereintrag")} ${esc(id)}. <a href="#/places">${T("Places", "Orte")}</a> · <a href="#/names">${T("Names", "Namen")}</a></p>`; return; }
    const which = e.k === "place" ? "places" : "names";
    setNav(which);
    const facet = { place: "pl", person: "per", org: "org" }[e.k];
    const letters = e.l.map((lid) => state.index.letters[state.pos.get(lid)]).filter(Boolean);
    const roles = Object.entries(e.r || {}).map(([k, n]) => `${esc({ issuer: T("issuer", "Aussteller"), recipient: T("recipient", "Empfänger"), origPlace: T("place of writing", "Ausstellungsort") }[k] || k)} ${num(n)}×`).join(", ");
    const sg = (e.c || []).filter((c) => c.sg);
    app.innerHTML = `
      <section class="entry">
        <p class="muted small"><a href="#/${which}">← ${which === "places" ? T("Places", "Orte") : T("Names", "Namen")}</a></p>
        <h1>${esc(e.n)} ${autoBadge()}</h1>
        <p class="muted">${esc(kindName(e.k))}${e.y ? ` · ${e.y[0]}${e.y[1] !== e.y[0] ? "–" + e.y[1] : ""}` : ""} · ${num(e.m)} ${P(e.m, "mention", "mentions", "Nennung", "Nennungen")} ${T("in", "in")} ${num(letters.length)} ${P(letters.length, "letter", "letters", "Brief", "Briefen")}${roles ? ` · ${roles}` : ""}</p>
        <p class="note-box">${T(`This entry was generated automatically: the tagger (St. Gallen's model, not measured on Thun) found these names in the machine reading, and a rule joined their spellings${e.k === "person" ? " within 30 years" : ""}${e.nz ? "; the address formula is normalised" : ""}. The candidates were looked up by name${e.k === "person" ? " and checked against the letters' years" : ""}. None of it is checked by a person.`,
          `Dieser Eintrag ist automatisch generiert: Die Auszeichnung (das Modell aus St. Gallen, an Thun nicht gemessen) hat diese Namen in der maschinellen Lesung gefunden, und eine Regel hat ihre Schreibungen zusammengeführt${e.k === "person" ? ", innerhalb von 30 Jahren" : ""}${e.nz ? "; die Anredeformel ist vereinheitlicht" : ""}. Die Kandidaten sind nach dem Namen gesucht${e.k === "person" ? " und an den Jahren der Briefe geprüft" : ""}. Nichts davon ist von einem Menschen geprüft.`)}</p>
        ${(e.o || []).length ? `<h2>${T("Office", "Amt")}</h2>
        ${e.o.map((o) => `<p><b>${esc(o.t)}</b>${o.y ? ` · ${o.y[0]}${o.y[1] !== o.y[0] ? "–" + o.y[1] : ""}` : ""} · ${T(`named in office in ${num(o.n)} ${P(o.n, "letter", "letters", "", "")}`, `in ${num(o.n)} ${P(o.n, "", "", "Brief", "Briefen")} im Amt genannt`)}
          ${o.l.length ? `<span class="small">(${o.l.slice(0, 8).map((lid) => { const l = state.index.letters[state.pos.get(lid)]; return l ? `<a href="#/letter/${encodeURIComponent(lid)}/1">${esc(titleOf(l))}</a>` : ""; }).filter(Boolean).join(", ")}${o.l.length > 8 ? " …" : ""})</span>` : ""}</p>`).join("")}
        <p class="muted small">${T("From an address or signature in the Argon reading that names this man with the office, matched to the lists of Schultheissen and Stadtschreiber (Wikipedia, checked against the letters: docs/OFFICES.md). Spellings and periods of one man in office are joined into this entry beyond the 30-year rule. Unchecked.",
          "Aus einer Anrede oder Unterschrift in der Lesung von Argon, die diesen Mann mit dem Amt nennt, abgeglichen mit den Listen der Schultheissen und Stadtschreiber (Wikipedia, an den Briefen geprüft: docs/OFFICES.md). Schreibungen und Zeiträume eines Amtsinhabers sind über die 30-Jahre-Regel hinaus zu diesem Eintrag zusammengeführt. Ungeprüft.")}</p>` : ""}
        <h2>${T("Spellings", "Schreibungen")}</h2>
        <p class="chips">${e.f.map(([f, n]) => `<span><i>${esc(f)}</i> <span class="muted">${num(n)}</span></span>`).join("")}</p>
        <h2>${T("Candidates", "Kandidaten")}</h2>
        ${(e.c || []).length ? `<div class="list cands">${e.c.map((c) => `
          <div class="row cand">${gradeChip(c, e.k)}
            <span><b>${esc(c.label)}</b> <span class="muted small">${esc((c.srcs || []).map((s) => SRC()[s] || s).join(" + "))}</span>${candDesc(c) ? `<br><span class="muted small">${esc(candDesc(c))}</span>` : ""}${c.via && c.via !== c.label ? `<br><span class="muted small">${T("found by the spelling", "gefunden über die Schreibung")} «${esc(c.via)}»</span>` : ""}<br><span class="muted small">${esc(precision(c, e.k))}</span></span>
            <span class="ext">${candLinks(c)}</span>
          </div>`).join("")}</div>
          <p class="muted small">${e.k === "person"
            ? T("Grades: <b>certain</b> forename and surname match an HLS person (≥ 95), the letters fall in the adult life and nothing else comes close; <b>likely</b> the spelling matches (≥ 90 HLS, ≥ 95 SSRQ/Königsfelden/St. Gallen, those attested within 40 years of the letters), clearly the best; <b>possible</b> a close spelling whose years fit. SSRQ, Königsfelden and St. Gallen are never certain.",
                "Stufen: <b>sicher</b> Vor- und Nachname stimmen mit einer Person im HLS (≥ 95), die Briefe fallen in ihr Erwachsenenleben, nichts anderes kommt nahe; <b>wahrscheinlich</b> die Schreibung stimmt (≥ 90 HLS, ≥ 95 SSRQ/Königsfelden/St. Gallen, dort innerhalb von 40 Jahren um die Briefe belegt), klar der beste; <b>möglich</b> eine ähnliche Schreibung, deren Jahre passen. SSRQ, Königsfelden und St. Gallen sind nie «sicher».")
            : e.k === "place"
            ? T("Grades: <b>likely</b> the spelling is a name of a place with an HLS article (settlements, then the nearest to Thun, first), or exactly one settlement of the SSRQ place database has it as a name or a recorded spelling; <b>possible</b> another place of that name, or a close spelling. A place is never certain: old spellings name too many places.",
                "Stufen: <b>wahrscheinlich</b> die Schreibung ist ein Name eines Orts mit HLS-Artikel (Siedlungen und dann der nächste bei Thun zuerst), oder genau eine Siedlung der SSRQ-Ortsdatenbank hat sie als Namen oder überlieferte Schreibung; <b>möglich</b> ein anderer Ort dieses Namens oder eine ähnliche Schreibung. Ein Ort ist nie «sicher»: Alte Schreibungen treffen zu viele Orte.")
            : T("Grades: an organisation is at most <b>possible</b> (St. Gallen's rule), except that the normalised address formula equal to the main name of a St. Gallen register entry is <b>likely</b> (a Thun rule, not measured).",
                "Stufen: Eine Organisation ist höchstens <b>möglich</b> (Regel aus St. Gallen), ausser die vereinheitlichte Anredeformel ist genau der Hauptname eines Eintrags im St. Galler Register: dann <b>wahrscheinlich</b> (eine Thuner Regel, nicht gemessen).")}</p>`
          : `<p class="muted">${T("No candidate found in HLS, the SSRQ, Königsfelden or St. Gallen.", "Kein Kandidat im HLS, in der SSRQ, in Königsfelden oder in St. Gallen gefunden.")}${e.k === "person" && !e.y ? " " + T("Without a year no person is proposed.", "Ohne Jahr wird keine Person vorgeschlagen.") : ""}</p>`}
        ${sg.length ? `<p>${T("In the St. Gallen Missives", "In den St. Galler Missiven")}: ${sg.map((c) => `<a href="${esc((c.links.find((l) => l.type === "st-gallen") || {}).url)}" target="_blank" rel="noopener">${esc(c.label)} ↗</a> <span class="muted small">(${esc(GRADE()[c.grade])})</span>`).join(", ")}</p>` : ""}
        ${e.k === "place" ? (e.g ? `<div id="emap" class="emap"></div><p class="small muted">${T("Coordinates from", "Koordinaten aus")} ${esc(SRC()[e.gf] || (e.gf === "wikidata" ? T("Wikidata, by the HLS id", "Wikidata, über die HLS-Kennung") : e.gf || ""))}, ${T("candidate graded", "Kandidat eingestuft als")} ${esc(GRADE()[e.gg] || "")}.</p>`
          : `<p class="note-box">${T("No coordinates: no candidate with coordinates was found, so the place is not on the map.", "Keine Koordinaten: Kein Kandidat mit Koordinaten gefunden, darum fehlt der Ort auf der Karte.")}</p>`) : ""}
        <h2>${num(letters.length)} ${P(letters.length, "letter", "letters", "Brief", "Briefe")} <a class="small" href="#/search?${facet}=${encodeURIComponent(id)}">${T("in the search", "in der Suche")} →</a></h2>
        <div class="list">${letters.map((l) => letterRow(l)).join("")}</div>
      </section>`;
    if (e.g && window.L) {
      const m = baseMap("emap", { center: e.g, zoom: 10 });
      placeMarker(id, e, m, true);
    }
  }

  /* ---------- map (Leaflet 1.9.4, OpenStreetMap tiles) ---------- */
  let leafletMaps = [];
  function destroyMaps() { leafletMaps.forEach((m) => m.remove()); leafletMaps = []; }
  function baseMap(el, opts = {}) {
    const m = L.map(el, { scrollWheelZoom: false, ...opts });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(m);
    leafletMaps.push(m);
    return m;
  }
  function placeMarker(id, e, m, on) {
    const n = nLetters(e);
    const poss = e.gg !== "wahrscheinlich";
    const pop = `<b>${esc(e.n)}</b><br>${num(n)} ${P(n, "letter", "letters", "Brief", "Briefe")}${poss ? `<br><span class="muted">${T("coordinates of a «possible» candidate", "Koordinaten eines «möglichen» Kandidaten")}</span>` : ""}
      <br><a href="#/entry/${encodeURIComponent(id)}">${T("Entry", "Eintrag")}</a> · <a href="#/search?pl=${encodeURIComponent(id)}">${T("Letters", "Briefe")}</a>`;
    return L.circleMarker(e.g, { radius: Math.min(22, 4 + Math.sqrt(n) * 1.6), className: `lf-place${poss ? " poss" : ""}${on ? " on" : ""}`, weight: 1.5, fillOpacity: poss ? 0.15 : 0.45, dashArray: poss ? "3 3" : null })
      .bindTooltip(`${esc(e.n)} · ${num(n)} ${P(n, "letter", "letters", "Brief", "Briefe")}`)
      .bindPopup(pop)
      .addTo(m);
  }
  function mapHtml() {
    if (!state.index.registers || !state.index.registers.place) return "";
    return `<section class="overview mapov" aria-labelledby="map-h">
      <h2 id="map-h">${T("Places", "Orte")}</h2>
      <p class="small muted" id="map-note">${T("Loading…", "Wird geladen…")}</p>
      <label class="small"><input type="checkbox" id="mapposs" ${state.mapPoss ? "checked" : ""}> ${T("also places whose coordinates come from a «possible» candidate", "auch Orte, deren Koordinaten von einem «möglichen» Kandidaten stammen")}</label>
      <div id="ovmap" class="ovmap" role="region" aria-label="${T("Map of the places named in the letters", "Karte der in den Briefen genannten Orte")}"></div>
    </section>`;
  }
  async function drawOverviewMap() {
    const el = document.getElementById("ovmap");
    if (!el) return;
    const r = await loadRegisters();
    if (!r || document.getElementById("ovmap") !== el) return;
    if (!window.L) { el.innerHTML = `<p class="noimg">${T("The map library did not load.", "Die Kartenbibliothek wurde nicht geladen.")}</p>`; return; }
    const places = Object.entries(r.entries).filter(([, e]) => e.k === "place");
    const sure = places.filter(([, e]) => e.g && e.gg === "wahrscheinlich");
    const poss = places.filter(([, e]) => e.g && e.gg !== "wahrscheinlich");
    const shown = state.mapPoss ? sure.concat(poss) : sure;
    const lettersOn = new Set(shown.flatMap(([, e]) => e.l)).size;
    document.getElementById("map-note").innerHTML = T(
      `${num(sure.length)} of the ${num(places.length)} places of the generated register have coordinates from a candidate graded «likely» (HLS, SSRQ, Königsfelden or St. Gallen; never from a name alone), ${num(poss.length)} more from a «possible» one. A circle's size is the number of letters that name the place; click it for the place and its letters. <a href="#/places?nogeo=1">${num(places.length - sure.length)} places are not on the map</a> (no coordinates, or only from a «possible» candidate). Places named in the letters on the map: ${num(lettersOn)} letters.`,
      `${num(sure.length)} der ${num(places.length)} Orte des generierten Registers haben Koordinaten von einem als «wahrscheinlich» eingestuften Kandidaten (HLS, SSRQ, Königsfelden oder St. Gallen; nie aus dem Namen allein), ${num(poss.length)} weitere von einem «möglichen». Die Grösse eines Kreises ist die Zahl der Briefe, die den Ort nennen; ein Klick zeigt den Ort und seine Briefe. <a href="#/places?nogeo=1">${num(places.length - sure.length)} Orte fehlen auf der Karte</a> (keine Koordinaten oder nur von einem «möglichen» Kandidaten). Briefe, die einen Ort auf der Karte nennen: ${num(lettersOn)}.`);
    const m = baseMap(el, { scrollWheelZoom: false });
    shown.sort((a, b) => nLetters(b[1]) - nLetters(a[1])).forEach(([id, e]) => placeMarker(id, e, m));
    /* open on the region: places in three letters or more, within 120 km of Thun; the far ones are a zoom away */
    const core = sure.filter(([, e]) => nLetters(e) >= 3 && best(e) && best(e).km != null && best(e).km <= 120);
    const pts = (core.length > 5 ? core : shown).map(([, e]) => e.g);
    if (pts.length) m.fitBounds(L.latLngBounds(pts), { padding: [20, 20], maxZoom: 10 }); else m.setView([46.758, 7.628], 8);
  }

  /* ---------- keywords: Sankey (keyword -> its most frequent companions -> decades) ----------
     Adapted from the St. Gallen viewer's drawSankey: plain SVG, no library; columns
     of boxes, bands as filled cubic curves; one neutral tone, the band under the
     pointer turns red. Periods are decades (dates/dates.jsonl). */
  const kwHref = (k) => "#/keyword/" + encodeURIComponent(k);
  const kwSearch = (...ks) => "#/search?" + ks.map((k) => "kw=" + encodeURIComponent(k)).join("&");
  function kwLetters(k) { return state.index.letters.filter((l) => (l.k || []).includes(k)); }
  /* a keyword on more than half the letters (Schultheiss: it is in nearly every address)
     says nothing about a companion: left out of the companions and not the default */
  const commonKw = () => {
    if (!state.kwCommon) state.kwCommon = new Set([...state.kw.entries()].filter(([, n]) => n > state.index.letters.length / 2).map(([k]) => k));
    return state.kwCommon;
  };
  function companions(k, mine) {
    const co = new Map(), skip = commonKw();
    for (const l of mine) for (const x of l.k) if (x !== k && !skip.has(x)) co.set(x, (co.get(x) || 0) + 1);
    return [...co.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "de"));
  }
  function tipAt(rect, html) {
    hideTip();
    tipEl = document.createElement("div");
    tipEl.className = "tip";
    tipEl.innerHTML = html;
    tipEl.style.pointerEvents = "none";
    document.body.appendChild(tipEl);
    tipEl.style.left = Math.max(8, Math.min(window.innerWidth - tipEl.offsetWidth - 8, rect.left)) + "px";
    tipEl.style.top = (rect.bottom + 6 + tipEl.offsetHeight > window.innerHeight ? rect.top - tipEl.offsetHeight - 6 : rect.bottom + 6) + "px";
  }
  function drawSankey(el, k, nComp = 8) {
    const mine = kwLetters(k);
    const comps = companions(k, mine).slice(0, nComp).map(([x]) => x);
    if (!comps.length) { el.innerHTML = `<p class="muted small">${T("No other keyword is given with this one.", "Kein anderes Schlagwort ist mit diesem vergeben.")}</p>`; return; }
    const W = 760, GAP = 6, PADY = 4;
    const decOf = (l) => (l.y ? Math.floor(l.y / 10) * 10 : null);
    const decs = [...new Set(mine.filter((l) => comps.some((c) => l.k.includes(c))).map(decOf))].sort((a, b) => (a ?? 1e9) - (b ?? 1e9));
    const periods = decs.map((d) => ({ id: d == null ? "pu" : "p" + d, lo: d, label: d == null ? T("undated", "undatiert") : T(`${d}s`, `${d}er`) }));
    const pOf = (l) => periods.find((p) => p.lo === decOf(l));
    const flow1 = comps.map((c) => ({ c, n: mine.filter((l) => l.k.includes(c)).length }));
    const flow2 = [];
    for (const c of comps) for (const l of mine) {
      if (!l.k.includes(c)) continue;
      const p = pOf(l), f = flow2.find((x) => x.c === c && x.p === p);
      if (f) f.n++; else flow2.push({ c, p, n: 1 });
    }
    const total = flow1.reduce((a, f) => a + f.n, 0);
    const maxNodes = Math.max(comps.length, periods.length);
    const scale = (Math.max(260, maxNodes * 24) - 2 * PADY - GAP * (maxNodes - 1)) / total;
    const X = [150, 400, 640], NW = 12, MIN = 13;   // a box gets at least MIN px of room, so that labels do not overlap
    const col = (items, size) => {
      let y = 0;
      const out = items.map((it) => { const h = size(it) * scale, r = { it, y, h }; y += Math.max(h, MIN) + GAP; return r; });
      out.total = y - GAP;
      return out;
    };
    const cIn = new Map(flow1.map((f) => [f.c, f.n]));
    const pIn = new Map(periods.map((p) => [p, flow2.filter((f) => f.p === p).reduce((a, f) => a + f.n, 0)]));
    const cols = [col([k], () => total), col(comps, (c) => cIn.get(c)), col(periods, (p) => pIn.get(p))];
    const H = Math.max(...cols.map((c) => c.total)) + 2 * PADY;
    cols.forEach((c) => { const off = (H - c.total) / 2; c.forEach((r) => { r.y += off; }); });
    const [[nK], nC, nP] = cols;
    const band = (x0, y0, x1, y1, h) => { const mx = (x0 + x1) / 2; return `M${x0},${y0}C${mx},${y0} ${mx},${y1} ${x1},${y1}L${x1},${y1 + h}C${mx},${y1 + h} ${mx},${y0 + h} ${x0},${y0 + h}Z`; };
    const decQ = (p) => (p.lo == null ? "" : "&dec=" + p.lo);
    let svg = "", yK = nK.y;
    nC.forEach((nc) => {
      svg += `<a href="${kwSearch(k, nc.it)}"><path class="sk-band" data-c="${esc(nc.it)}" data-tip="${esc(k)} + ${esc(nc.it)}: ${num(cIn.get(nc.it))} ${P(cIn.get(nc.it), "letter", "letters", "Brief", "Briefe")}" d="${band(X[0] + NW, yK, X[1], nc.y, nc.h)}"/></a>`;
      yK += nc.h;
    });
    const outY = new Map(nC.map((nc) => [nc.it, nc.y])), inY = new Map(nP.map((np) => [np.it, np.y]));
    for (const nc of nC) for (const np of nP) {
      const f = flow2.find((x) => x.c === nc.it && x.p === np.it);
      if (!f) continue;
      const h = f.n * scale;
      svg += `<a href="${kwSearch(k, nc.it)}${decQ(np.it)}"><path class="sk-band" data-c="${esc(nc.it)}" data-p="${np.it.id}" data-tip="${esc(k)} + ${esc(nc.it)}, ${esc(np.it.label)}: ${num(f.n)} ${P(f.n, "letter", "letters", "Brief", "Briefe")}" d="${band(X[1] + NW, outY.get(nc.it), X[2], inY.get(np.it), h)}"/></a>`;
      outY.set(nc.it, outY.get(nc.it) + h); inY.set(np.it, inY.get(np.it) + h);
    }
    const node = (x, n, label, href, cls, data, anchor) => `<a href="${href}"><rect class="sk-node ${cls}" ${data} x="${x}" y="${n.y}" width="${NW}" height="${Math.max(1, n.h)}" rx="2"/>
      <text class="sk-lab" x="${anchor === "end" ? x - 6 : x + NW + 6}" y="${n.y + n.h / 2}" text-anchor="${anchor}" dominant-baseline="middle">${label}</text></a>`;
    svg += node(X[0], nK, esc(k), kwSearch(k), "key", "", "end");
    nC.forEach((nc) => { svg += node(X[1], nc, `${esc(nc.it)} <tspan class="sk-n">${num(cIn.get(nc.it))}</tspan>`, kwHref(nc.it), "", `data-c="${esc(nc.it)}"`, "start"); });
    nP.forEach((np) => { svg += node(X[2], np, `${esc(np.it.label)} <tspan class="sk-n">${num(pIn.get(np.it))}</tspan>`, kwSearch(k) + decQ(np.it), "", `data-p="${np.it.id}"`, "start"); });
    el.innerHTML = `<div class="sankeywrap"><svg class="sankey" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(T(`Sankey: ${k} to its companions and their decades`, `Sankey: ${k} zu seinen Begleitern und deren Jahrzehnten`))}">${svg}</svg></div>`;
    const svgEl = el.querySelector("svg");
    const lit = (c, p) => svgEl.querySelectorAll(".sk-band").forEach((b) => {
      const on = (!c || b.dataset.c === c) && (!p || b.dataset.p === p || (!b.dataset.p && !c));
      b.classList.toggle("hl", on && !!(c || p));
      b.classList.toggle("dim", !on && !!(c || p));
    });
    svgEl.addEventListener("mouseover", (ev) => {
      const b = ev.target.closest(".sk-band"), a = ev.target.closest("a"), n = a && a.querySelector(".sk-node");
      if (b) { lit(b.dataset.c, b.dataset.p); tipAt(b.getBoundingClientRect(), esc(b.dataset.tip)); return; }
      if (n && n.dataset.c) lit(n.dataset.c, null);
      else if (n && n.dataset.p) svgEl.querySelectorAll(".sk-band").forEach((x) => {
        const on = x.dataset.p === n.dataset.p || (!x.dataset.p && !!svgEl.querySelector(`.sk-band[data-p="${n.dataset.p}"][data-c="${CSS.escape(x.dataset.c)}"]`));
        x.classList.toggle("hl", on); x.classList.toggle("dim", !on);
      });
    });
    svgEl.addEventListener("mouseleave", () => { lit(null, null); hideTip(); });
  }
  function sankeyHtml() {
    if (!state.kw.size) return "";
    const terms = [...state.kw.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "de"));
    const cur = state.kw.has(state.skKey) ? state.skKey : (terms.find(([k]) => !commonKw().has(k)) || terms[0])[0];
    return `<section class="overview skov" aria-labelledby="sk-h">
      <h2 id="sk-h">${T("A keyword, its companions, their decades", "Ein Schlagwort, seine Begleiter, ihre Jahrzehnte")}</h2>
      <div class="tl-zoomhead"><label for="skk" class="small">${T("Keyword", "Schlagwort")}</label>
        <select id="skk" lang="de">${terms.map(([k, n]) => `<option value="${esc(k)}" ${k === cur ? "selected" : ""}>${esc(k)} (${num(n)})</option>`).join("")}</select>
        <a class="small" href="${kwHref(cur)}">${T("keyword page", "Seite des Schlagworts")} →</a></div>
      <div id="sankey" data-k="${esc(cur)}"></div>
      <p class="small muted">${T(`From the keyword to the keywords most often given with it, and on to the decades of those letters. A band's width is the number of letters that carry both; a letter with several of these companions counts once with each. A click on a band or a box opens those letters in the search. ${[...commonKw()].map((x) => "«" + esc(x) + "»").join(", ")} ${commonKw().size ? "(on more than half of all letters, in nearly every address) is left out of the companions. " : ""}Keywords are machine-assigned and unchecked; the years are read by rule.`,
        `Vom Schlagwort zu den Schlagwörtern, die am häufigsten mit ihm vergeben sind, und weiter zu den Jahrzehnten dieser Briefe. Die Breite eines Bands ist die Zahl der Briefe mit beiden; ein Brief mit mehreren dieser Begleiter zählt bei jedem. Ein Klick auf ein Band oder ein Feld öffnet diese Briefe in der Suche. ${[...commonKw()].map((x) => "«" + esc(x) + "»").join(", ")} ${commonKw().size ? "(auf mehr als der Hälfte aller Briefe, in fast jeder Anrede) ist bei den Begleitern weggelassen. " : ""}Die Schlagwörter sind maschinell vergeben und ungeprüft; die Jahre nach Regeln gelesen.`)}</p>
    </section>`;
  }

  function showKeyword(k) {
    setNav("keywords");
    const mine = kwLetters(k);
    if (!mine.length) { app.innerHTML = `<p>${T("No letter has the keyword", "Kein Brief hat das Schlagwort")} «${esc(k)}». <a href="#/">${T("Overview", "Übersicht")}</a></p>`; return; }
    const co = companions(k, mine).slice(0, 24);
    const by = new Map();
    for (const l of mine) if (l.y) { const d = Math.floor(l.y / 10) * 10; by.set(d, (by.get(d) || 0) + 1); }
    const decs = [...by.keys()].sort((a, b) => a - b), top = Math.max(1, ...by.values());
    const rows = mine.slice().sort((a, b) => (a.y || 9999) - (b.y || 9999));
    app.innerHTML = `
      <section class="intro">
        <div class="muted small"><a href="#/keywords">${T("Keywords", "Schlagwörter")}</a> · <a href="#/keywords/network?focus=${encodeURIComponent(k)}">${T("in the network", "im Netzwerk")}</a></div>
        <h1 lang="de">${esc(k)}</h1>
        <p>${T(`${num(mine.length)} ${P(mine.length, "letter", "letters", "", "")} with this keyword (machine-assigned, unchecked).`, `${num(mine.length)} ${P(mine.length, "", "", "Brief", "Briefe")} mit diesem Schlagwort (maschinell vergeben, ungeprüft).`)}
          <a href="${kwSearch(k)}">${T("Open in the search", "In der Suche öffnen")}</a></p>
      </section>
      <section class="pane sankeypane"><h2>${T("Companions over time", "Begleiter über die Zeit")}</h2><div id="sankey"></div></section>
      <div class="kwcols">
        <section class="pane"><h2>${T("Over time", "Über die Zeit")}</h2>
          <div class="kwbars" role="table" aria-label="${T("Letters per decade", "Briefe pro Jahrzehnt")}">${decs.map((d) => `<a href="${kwSearch(k)}&dec=${d}" role="row"><span class="yr">${d}</span><span class="bar"><i style="width:${Math.round((100 * by.get(d)) / top)}%"></i></span><span class="n">${num(by.get(d))}</span></a>`).join("")}</div>
          <p class="muted small">${T("Letters with this keyword per decade; a click opens them in the search.", "Briefe mit diesem Schlagwort pro Jahrzehnt; ein Klick öffnet sie in der Suche.")}</p></section>
        <section class="pane"><h2>${T("Often together with", "Oft zusammen mit")}</h2>
          <div class="kw" lang="de">${co.map(([x, n]) => `<a href="${kwHref(x)}">${esc(x)} <span class="n">${num(n)}</span></a>`).join("")}</div>
          <p class="muted small">${T("The number: letters that carry both keywords.", "Die Zahl: Briefe, die beide Schlagwörter tragen.")}</p></section>
      </div>
      <h2>${T("Letters", "Briefe")}</h2>
      <div class="list">${rows.map((l) => letterRow(l)).join("")}</div>`;
    drawSankey(document.getElementById("sankey"), k, 10);
  }

  /* ---------- keywords: heatmap and index ----------
     Adapted from the St. Gallen viewer (showKeywords): keyword × twenty years, a
     count or the share of the period's letters; all keywords here are machine-assigned. */
  const KW_BIN = 20, KW_THIN = 10;
  function kwData() {
    // a year outside the series (1300–1700) is a misreading: such a letter counts as undated
    const letters = state.index.letters.filter((l) => l.k && l.k.length)
      .map((l) => ({ ...l, y: l.y >= 1300 && l.y <= 1700 ? l.y : null, kw: l.k }));
    const count = new Map();
    for (const m of letters) for (const k of m.kw) count.set(k, (count.get(k) || 0) + 1);
    const ys = letters.map((m) => m.y).filter(Boolean);
    const b0 = Math.floor(Math.min(...ys) / KW_BIN) * KW_BIN, b1 = Math.floor(Math.max(...ys) / KW_BIN) * KW_BIN;
    const bins = [];
    for (let lo = b0; lo <= b1; lo += KW_BIN) bins.push(lo);
    const binOf = (y) => (y ? bins.indexOf(Math.floor(y / KW_BIN) * KW_BIN) : -1);
    const totals = bins.map(() => 0);
    for (const m of letters) { const b = binOf(m.y); if (b >= 0) totals[b]++; }
    return { letters, count, bins, binOf, totals };
  }
  /* the letters of a keyword in a twenty-year period: the search takes decades */
  const kwPeriod = (k, lo) => `${kwSearch(k)}&dec=${lo}&dec=${lo + 10}`;
  const heat = (v) => (v > 0 ? `color-mix(in oklab, var(--brand) ${Math.round(12 + 88 * Math.sqrt(Math.min(1, v)))}%, var(--panel))` : "transparent");

  function showKeywords() {
    setNav("keywords");
    if (!state.kw.size) { app.innerHTML = `<p>${T("Keywords will follow.", "Schlagwörter folgen.")}</p>`; return; }
    const f = state.kwView = state.kwView || { top: 40, sort: "count", mode: "n", q: "" };
    const d = kwData();
    const all = [...d.count.entries()];
    const per = Math.round(d.letters.reduce((a, m) => a + m.kw.length, 0) / d.letters.length);
    const voc = state.index.vocabulary;
    app.innerHTML = `
      <section class="intro">
        <h1>${T("Keywords", "Schlagwörter")}</h1>
        <p>${T(`${num(d.letters.length)} letters have keywords, ${num(all.length)} different terms, about ${per} per letter. A language model assigned them from the machine-drafted regests, choosing from the ${voc ? num(voc.terms) : ""} keywords of the St. Gallen Missives edition; unchecked.
          The heatmap shows in how many letters of each twenty years a keyword stands; a click on a cell opens those letters in the search, a click on a keyword its page with the Sankey of its companions.`,
          `${num(d.letters.length)} Briefe haben Schlagwörter, ${num(all.length)} verschiedene, etwa ${per} pro Brief. Ein Sprachmodell hat sie aus den maschinell entworfenen Regesten vergeben, gewählt aus den ${voc ? num(voc.terms) : ""} Schlagwörtern der Edition der St. Galler Missiven; ungeprüft.
          Die Heatmap zeigt, in wie vielen Briefen von je zwanzig Jahren ein Schlagwort steht; ein Klick auf eine Zelle öffnet diese Briefe in der Suche, ein Klick auf ein Schlagwort seine Seite mit dem Sankey seiner Begleiter.`)}</p>
        <p><a href="#/keywords/network">${T("Keyword network →", "Netzwerk der Schlagwörter →")}</a></p>
      </section>
      <div class="filters">
        <input id="kq" type="search" placeholder="${T("Find a keyword…", "Schlagwort finden…")}" value="${esc(f.q)}" aria-label="${T("Find a keyword", "Schlagwort finden")}">
        <select id="ktop" aria-label="${T("How many", "Wie viele")}">
          ${[20, 40, 80, 0].map((n) => `<option value="${n}" ${f.top === n ? "selected" : ""}>${n ? T(`${n} most frequent`, `${n} häufigste`) : T("all", "alle")}</option>`).join("")}
        </select>
        <select id="ksort" aria-label="${T("Order", "Reihenfolge")}">
          <option value="count" ${f.sort === "count" ? "selected" : ""}>${T("by frequency", "nach Häufigkeit")}</option>
          <option value="time" ${f.sort === "time" ? "selected" : ""}>${T("by period of most use", "nach Zeit des Schwerpunkts")}</option>
          <option value="alpha" ${f.sort === "alpha" ? "selected" : ""}>${T("alphabetically", "alphabetisch")}</option>
        </select>
        <div class="seg" id="kmode" role="group" aria-label="${T("Value", "Wert")}">
          ${[["n", T("Letters", "Briefe")], ["share", T("Share of the period", "Anteil am Zeitraum")]].map(([v, l]) =>
            `<button type="button" data-v="${v}" aria-pressed="${f.mode === v}" class="${f.mode === v ? "on" : ""}">${l}</button>`).join("")}
        </div>
      </div>
      <div class="heatwrap" id="heat"></div>
      <p class="muted small" id="hnote"></p>
      <h2>${T("All keywords", "Alle Schlagwörter")}</h2>
      <div class="kwindex" id="kwindex" lang="de"></div>`;
    const centre = (k) => {  // mean year of a keyword's letters, for "by period"
      let s = 0, n = 0;
      for (const m of d.letters) if (m.y && m.kw.includes(k)) { s += m.y; n++; }
      return n ? s / n : 0;
    };
    const cells = new Map();
    for (const m of d.letters) {
      const b = d.binOf(m.y);
      if (b < 0) continue;
      for (const k of m.kw) { if (!cells.has(k)) cells.set(k, d.bins.map(() => 0)); cells.get(k)[b]++; }
    }
    const draw = () => {
      const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
      let rows = all.filter(([k]) => words.every((w) => k.toLowerCase().includes(w))).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "de"));
      if (f.top && !words.length) rows = rows.slice(0, f.top);
      if (f.sort === "alpha") rows.sort((a, b) => a[0].localeCompare(b[0], "de"));
      if (f.sort === "time") rows.sort((a, b) => centre(a[0]) - centre(b[0]));
      const val = (k, b) => { const n = (cells.get(k) || [])[b] || 0; return f.mode === "n" ? n : (d.totals[b] ? n / d.totals[b] : 0); };
      // a share over a handful of letters says nothing: those periods stay out of the colour scale
      const thin = (b) => f.mode === "share" && d.totals[b] < KW_THIN;
      let top = 0;
      // a keyword on more than half the letters (Schultheiss) would pale every other row: it gets the top colour
      for (const [k] of rows) if (!commonKw().has(k)) d.bins.forEach((_, b) => { if (!thin(b)) top = Math.max(top, val(k, b)); });
      if (!top) for (const [k] of rows) d.bins.forEach((_, b) => { if (!thin(b)) top = Math.max(top, val(k, b)); });
      const fmt = (v) => (f.mode === "n" ? num(v) : `${Math.round(v * 100)} %`);
      const cols = `grid-template-columns: minmax(120px, 13rem) repeat(${d.bins.length}, minmax(30px, 1fr)) 3.2rem;`;
      document.getElementById("heat").innerHTML = rows.length ? `
        <div class="heat" style="${cols}" role="table" aria-label="${T("Keywords by twenty years", "Schlagwörter nach zwanzig Jahren")}">
          <div class="hh" role="columnheader"></div>
          ${d.bins.map((lo) => `<div class="hh" role="columnheader">${lo}<span>–${String(lo + KW_BIN - 1).slice(2)}</span></div>`).join("")}
          <div class="hh hn" role="columnheader">${T("all", "alle")}</div>
          <div class="hk muted" role="rowheader">${T("letters with keywords", "Briefe mit Schlagwörtern")}</div>
          ${d.totals.map((n, b) => `<div class="htot${thin(b) ? " thin" : ""}">${num(n)}</div>`).join("")}
          <div class="hn muted">${num(d.letters.length)}</div>
          ${rows.map(([k, n]) => `
            <a class="hk" role="rowheader" href="${kwHref(k)}" lang="de">${esc(k)}</a>
            ${d.bins.map((lo, b) => {
              const v = val(k, b), c = (cells.get(k) || [])[b] || 0;
              return `<a class="hc${thin(b) ? " thin" : ""}" role="cell" href="${c ? kwPeriod(k, lo) : kwHref(k)}" style="background:${thin(b) ? "" : heat(top ? v / top : 0)}"
                data-tip="${esc(k)} · ${lo}–${lo + KW_BIN - 1}: ${c} ${P(c, "letter", "letters", "Brief", "Briefe")} ${T("of", "von")} ${d.totals[b]}${d.totals[b] ? ` (${Math.round(100 * c / d.totals[b])} %)` : ""}"
                aria-label="${esc(k)} ${lo}–${lo + KW_BIN - 1}: ${c}">${c && rows.length <= 40 ? `<span>${c}</span>` : ""}</a>`;
            }).join("")}
            <div class="hn">${num(n)}</div>`).join("")}
        </div>` : `<p class="muted">${T("No keyword matches.", "Kein Schlagwort passt.")}</p>`;
      const common = [...commonKw()].map((x) => "«" + esc(x) + "»").join(", ");
      document.getElementById("hnote").innerHTML = `<span class="hlegend"><span>${f.mode === "n" ? "0" : "0 %"}</span><i></i><span>${fmt(top)}</span></span>
        ${f.mode === "n" ? T("Number of letters in twenty years.", "Anzahl Briefe in zwanzig Jahren.") : T(`Share of the period's letters with keywords: evens out that the collection holds far more letters from some periods than from others. Periods with fewer than ${KW_THIN} letters are hatched and left out of the colours: one letter there would count as a large share.`, `Anteil an den verschlagworteten Briefen des Zeitraums: gleicht aus, dass die Sammlung aus manchen Zeiten viel mehr Briefe hat als aus anderen. Zeiträume mit weniger als ${KW_THIN} Briefen sind schraffiert und nicht eingefärbt: ein einziger Brief wäre dort schon ein grosser Anteil.`)}
        ${T(`Years are read by rule from the date line of the regest draft; ${num(d.letters.filter((m) => !m.y).length)} undated letters are counted only in "all".`, `Die Jahre sind nach Regeln aus der Datumszeile des Regestentwurfs gelesen; ${num(d.letters.filter((m) => !m.y).length)} undatierte Briefe zählen nur unter «alle».`)}
        ${common ? T(`${common} stands on more than half of all letters (in nearly every address); it is left out of the colour scale and shown at full strength.`, `${common} steht auf mehr als der Hälfte aller Briefe (in fast jeder Anrede); es ist aus der Farbskala genommen und voll eingefärbt.`) : ""}`;
    };
    // the index below: every keyword, A–Z, with its count
    const byLetter = new Map();
    for (const [k, n] of [...all].sort((a, b) => a[0].localeCompare(b[0], "de"))) {
      const l = k[0].toUpperCase();
      if (!byLetter.has(l)) byLetter.set(l, []);
      byLetter.get(l).push([k, n]);
    }
    document.getElementById("kwindex").innerHTML = [...byLetter].map(([l, ks]) => `
      <section><h3>${esc(l)}</h3><div class="kw">${ks.map(([k, n]) => `<a href="${kwHref(k)}">${esc(k)} <span class="n">${num(n)}</span></a>`).join("")}</div></section>`).join("");
    const heatEl = document.getElementById("heat");
    heatEl.addEventListener("mouseover", (ev) => {
      const c = ev.target.closest(".hc");
      if (!c) return;
      tipAt(c.getBoundingClientRect(), esc(c.dataset.tip));
    });
    heatEl.addEventListener("mouseleave", hideTip);
    document.getElementById("kq").addEventListener("input", (ev) => { f.q = ev.target.value; draw(); });
    document.getElementById("ktop").addEventListener("change", (ev) => { f.top = +ev.target.value; draw(); });
    document.getElementById("ksort").addEventListener("change", (ev) => { f.sort = ev.target.value; draw(); });
    document.getElementById("kmode").addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-v]");
      if (!b) return;
      f.mode = b.dataset.v;
      document.querySelectorAll("#kmode button").forEach((x) => { const on = x === b; x.classList.toggle("on", on); x.setAttribute("aria-pressed", on); });
      draw();
    });
    draw();
  }

  /* ---------- keyword network ----------
     From the St. Gallen viewer: keywords as nodes, letters they share as edges,
     weighted by the cosine of the two letter sets (shared / √(a·b)) so that the
     most frequent keywords do not tie to everything; each keeps its five strongest
     ties (shared in at least three letters). Groups by modularity (Louvain);
     layout by d3-force, computed once from d3's fixed start, the same on every visit. */
  let d3Loading = null;
  function loadD3() {
    if (window.d3) return Promise.resolve();
    d3Loading = d3Loading || new Promise((res, rej) => {
      const sc = document.createElement("script");
      sc.src = "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js";
      sc.onload = res; sc.onerror = () => rej(new Error("d3"));
      document.head.appendChild(sc);
    });
    return d3Loading;
  }

  function kwGraph(d, min) {
    const count = new Map([...d.count].filter(([, n]) => n >= min));
    const names = [...count.keys()].sort((a, b) => count.get(b) - count.get(a) || a.localeCompare(b, "de"));
    const idx = new Map(names.map((n, i) => [n, i]));
    const pair = new Map();
    for (const m of d.letters) {
      const ks = m.kw.filter((x) => idx.has(x)).map((x) => idx.get(x)).sort((a, b) => a - b);
      for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
        const key = ks[i] * 10000 + ks[j];
        pair.set(key, (pair.get(key) || 0) + 1);
      }
    }
    const cand = [];
    for (const [key, c] of pair) {
      if (c < 3) continue;
      const a = Math.floor(key / 10000), b = key % 10000;
      cand.push({ a, b, c, w: c / Math.sqrt(count.get(names[a]) * count.get(names[b])) });
    }
    const best = names.map(() => []);
    for (const e of cand) { best[e.a].push(e); best[e.b].push(e); }
    const keep = new Set();
    best.forEach((es) => es.sort((x, y) => y.w - x.w).slice(0, 5).forEach((e) => keep.add(e)));
    const edges = [...keep];
    const adj = names.map(() => []);
    for (const e of edges) { adj[e.a].push([e.b, e.w]); adj[e.b].push([e.a, e.w]); }
    const lab = louvain(names.length, edges.map((e) => [e.a, e.b, e.w]), 1.0);
    const nodes = names.map((n, i) => ({ id: i, name: n, n: count.get(n), g: lab[i], deg: adj[i].length }));
    const groups = new Map();
    for (const nd of nodes) if (nd.deg) { if (!groups.has(nd.g)) groups.set(nd.g, []); groups.get(nd.g).push(nd); }
    const glist = [...groups.values()].filter((g) => g.length >= 3).sort((a, b) => b.reduce((s, x) => s + x.n, 0) - a.reduce((s, x) => s + x.n, 0));
    return { nodes: nodes.filter((nd) => nd.deg), isolated: nodes.filter((nd) => !nd.deg), edges, groups: glist, adj, names };
  }

  /* Groups by modularity (Louvain): move each node to the neighbouring group that
     gains most, until nothing moves; then treat each group as one node and repeat.
     Fixed visiting order, so the groups are the same on every visit. */
  function louvain(n, wedges, gamma) {
    let member = Array.from({ length: n }, (_, i) => i);
    let size = n, E = wedges;
    for (let level = 0; level < 6; level++) {
      const adj = Array.from({ length: size }, () => new Map());
      const k = new Array(size).fill(0);
      let m2 = 0;
      for (const [a, b, w] of E) {
        if (a === b) { k[a] += 2 * w; m2 += 2 * w; adj[a].set(a, (adj[a].get(a) || 0) + 2 * w); continue; }
        adj[a].set(b, (adj[a].get(b) || 0) + w); adj[b].set(a, (adj[b].get(a) || 0) + w);
        k[a] += w; k[b] += w; m2 += 2 * w;
      }
      if (!m2) break;
      const com = Array.from({ length: size }, (_, i) => i), tot = k.slice();
      let moved = true, any = false;
      for (let pass = 0; moved && pass < 50; pass++) {
        moved = false;
        for (let i = 0; i < size; i++) {
          const ci = com[i];
          const kin = new Map();
          for (const [j, w] of adj[i]) if (j !== i) kin.set(com[j], (kin.get(com[j]) || 0) + w);
          tot[ci] -= k[i];
          let bestC = ci, gain = (kin.get(ci) || 0) - gamma * tot[ci] * k[i] / m2;
          for (const [c, w] of kin) {
            const g = w - gamma * tot[c] * k[i] / m2;
            if (g > gain + 1e-12 || (Math.abs(g - gain) <= 1e-12 && c < bestC)) { bestC = c; gain = g; }
          }
          tot[bestC] += k[i];
          if (bestC !== ci) { com[i] = bestC; moved = true; any = true; }
        }
      }
      if (!any) break;
      const ids = new Map();
      com.forEach((c) => { if (!ids.has(c)) ids.set(c, ids.size); });
      member = member.map((s0) => ids.get(com[s0]));
      const agg = new Map();
      for (const [a, b, w] of E) {
        const x = ids.get(com[a]), y = ids.get(com[b]);
        const key = Math.min(x, y) * 100000 + Math.max(x, y);
        agg.set(key, (agg.get(key) || 0) + w);
      }
      E = [...agg].map(([key, w]) => [Math.floor(key / 100000), key % 100000, w]);
      size = ids.size;
    }
    return member;
  }

  async function showKeywordNetwork(params) {
    setNav("keywords");
    if (!state.kw.size) { app.innerHTML = `<p>${T("Keywords will follow.", "Schlagwörter folgen.")}</p>`; return; }
    app.innerHTML = `<p class="muted">${T("Loading…", "Wird geladen…")}</p>`;
    const d = kwData();
    try { await loadD3(); } catch { app.innerHTML = `<p>${T("The network needs the d3 library, which could not be loaded.", "Das Netzwerk braucht die Bibliothek d3, die nicht geladen werden konnte.")}</p>`; return; }
    const f = state.netView = state.netView || { min: 25 };  // Thun has more letters than St. Gallen: 15+ is a hairball
    const focus = params.get("focus") || "";
    if (focus && (d.count.get(focus) || 0) < f.min) f.min = Math.max(3, d.count.get(focus) || 3);
    const g = kwGraph(d, f.min);
    app.innerHTML = `
      <section class="intro">
        <div class="muted small"><a href="#/keywords">${T("Keywords", "Schlagwörter")}</a></div>
        <h1>${T("Keyword network", "Netzwerk der Schlagwörter")}</h1>
        <p>${T(`Keywords given to the same letters stand close together. A line joins two keywords that share at least three letters; each keeps its five strongest ties, measured against how frequent both are (so that «Schultheiss» does not tie to everything). Circle size: number of letters. The groups on the right are found from the ties alone; point at one to see it. The keywords are machine-assigned and unchecked.`,
          `Schlagwörter, die denselben Briefen gegeben sind, stehen nah beieinander. Eine Linie verbindet zwei Schlagwörter, die mindestens drei Briefe teilen; jedes behält seine fünf stärksten Verbindungen, gemessen an der Häufigkeit beider (damit «Schultheiss» nicht mit allem verbunden ist). Kreisgrösse: Anzahl Briefe. Die Gruppen rechts sind allein aus den Verbindungen gefunden; Zeiger darauf zeigt sie. Die Schlagwörter sind maschinell vergeben und ungeprüft.`)}</p>
      </section>
      <div class="filters">
        <select id="nmin" aria-label="${T("Keywords shown", "Gezeigte Schlagwörter")}">
          ${[5, 8, 15, 25, 50].map((n) => `<option value="${n}" ${f.min === n ? "selected" : ""}>${T(`keywords in ${n}+ letters`, `Schlagwörter in ${n}+ Briefen`)}</option>`).join("")}
          ${[5, 8, 15, 25, 50].includes(f.min) ? "" : `<option value="${f.min}" selected>${T(`keywords in ${f.min}+ letters`, `Schlagwörter in ${f.min}+ Briefen`)}</option>`}
        </select>
        <input id="nq" type="search" placeholder="${T("Find a keyword…", "Schlagwort finden…")}" value="${esc(focus)}" aria-label="${T("Find a keyword", "Schlagwort finden")}" list="nlist">
        <datalist id="nlist">${g.nodes.map((n) => `<option value="${esc(n.name)}">`).join("")}</datalist>
        <span class="muted small">${num(g.nodes.length)} ${T("keywords", "Schlagwörter")}, ${num(g.edges.length)} ${T("ties", "Verbindungen")}${g.isolated.length ? T(`; ${g.isolated.length} without a tie left out`, `; ${g.isolated.length} ohne Verbindung weggelassen`) : ""}</span>
      </div>
      <div class="netcols">
        <section class="pane netpane"><div id="net"></div><p class="muted small">${T("Drag to move, scroll or pinch to zoom; a click on a keyword opens it.", "Ziehen verschiebt, Scrollen oder Zwei-Finger-Geste zoomt; ein Klick auf ein Schlagwort öffnet es.")}</p></section>
        <aside class="pane netgroups"><h2>${T("Groups", "Gruppen")}</h2><ol id="ngroups" lang="de">${g.groups.map((gr) => `
          <li data-g="${gr[0].g}"><b>${gr.slice(0, 3).map((x) => esc(x.name)).join(" · ")}</b> <span class="muted small">${gr.length} ${T("keywords", "Schlagwörter")}</span>
          <div class="small muted">${gr.slice(3, 12).map((x) => `<a href="${kwHref(x.name)}">${esc(x.name)}</a>`).join(", ")}${gr.length > 12 ? " …" : ""}</div></li>`).join("")}</ol></aside>
      </div>`;
    document.getElementById("nmin").addEventListener("change", (ev) => { f.min = +ev.target.value; showKeywordNetwork(new URLSearchParams()); });
    const nodes = g.nodes.map((n) => ({ ...n, r: 3 + 1.15 * Math.sqrt(n.n) }));
    const byIdx = new Map(nodes.map((n) => [n.id, n]));
    const links = g.edges.map((e) => ({ source: e.a, target: e.b, w: e.w, c: e.c }));
    const sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id((n) => n.id).distance((l) => 30 + 80 * (1 - l.w)).strength((l) => 0.15 + 0.6 * l.w))
      .force("charge", d3.forceManyBody().strength(-120))
      .force("collide", d3.forceCollide((n) => n.r + 2))
      .force("x", d3.forceX(0).strength(0.04)).force("y", d3.forceY(0).strength(0.06))
      .stop();
    for (let i = 0; i < 400; i++) sim.tick();
    const xs = d3.extent(nodes, (n) => n.x), ys = d3.extent(nodes, (n) => n.y);
    const pad = 60;
    const vb = [xs[0] - pad, ys[0] - pad, xs[1] - xs[0] + 2 * pad, ys[1] - ys[0] + 2 * pad];
    const labelled = new Set(nodes.slice().sort((a, b) => b.n - a.n).slice(0, 30).map((n) => n.id));
    const svg = d3.select("#net").append("svg").attr("class", "net").attr("viewBox", vb.join(" ")).attr("role", "img")
      .attr("aria-label", T("Network of keywords", "Netzwerk der Schlagwörter"));
    const root = svg.append("g");
    // labels stay 12 px on screen whatever the viewBox scale and the zoom
    let zk = 1;
    const fit = () => {
      const px = svg.node().getBoundingClientRect().width / vb[2] || 1;
      root.selectAll("text").attr("font-size", 12 / (px * zk)).attr("stroke-width", 3 / (px * zk));
      root.selectAll("text").attr("y", (n) => n.y - n.r - 3 / (px * zk));
    };
    svg.call(d3.zoom().scaleExtent([0.5, 8]).on("zoom", (ev) => { root.attr("transform", ev.transform); zk = ev.transform.k; fit(); }));
    const lk = root.append("g").attr("class", "n-links").selectAll("line").data(links).join("line")
      .attr("x1", (l) => l.source.x).attr("y1", (l) => l.source.y).attr("x2", (l) => l.target.x).attr("y2", (l) => l.target.y)
      .attr("stroke-width", (l) => 0.6 + 2.4 * l.w);
    const nd = root.append("g").attr("class", "n-nodes").selectAll("a").data(nodes).join("a").attr("href", (n) => kwHref(n.name));
    nd.append("circle").attr("cx", (n) => n.x).attr("cy", (n) => n.y).attr("r", (n) => n.r);
    nd.append("text").attr("x", (n) => n.x).attr("y", (n) => n.y - n.r - 3).attr("text-anchor", "middle")
      .attr("class", (n) => (labelled.has(n.id) ? "n-lab" : "n-lab n-hidden")).text((n) => n.name);
    fit();
    if (state.netFit) window.removeEventListener("resize", state.netFit);
    state.netFit = () => { if (document.body.contains(svg.node())) fit(); };
    window.addEventListener("resize", state.netFit);
    const nbr = new Map(nodes.map((n) => [n.id, new Set([n.id, ...g.adj[n.id].map(([j]) => j)])]));
    const show = (ids, hot) => {
      nd.classed("dim", (n) => ids && !ids.has(n.id)).classed("hot", (n) => hot && hot.has(n.id))
        .select("text").classed("n-hidden", (n) => !(labelled.has(n.id) || (ids && ids.has(n.id))));
      lk.classed("dim", (l) => ids && !(ids.has(l.source.id) && ids.has(l.target.id))).classed("hot", (l) => ids && ids.has(l.source.id) && ids.has(l.target.id));
    };
    nd.on("mouseenter", (ev, n) => {
      show(nbr.get(n.id), new Set([n.id]));
      const ties = g.adj[n.id].slice().sort((a, b) => b[1] - a[1]).slice(0, 5).map(([j]) => esc(byIdx.get(j)?.name || g.names[j]));
      tipAt(ev.currentTarget.getBoundingClientRect(), `<b>${esc(n.name)}</b> ${num(n.n)} ${P(n.n, "letter", "letters", "Brief", "Briefe")}<div class="muted">${T("closest", "am nächsten")}: ${ties.join(", ")}</div>`);
    }).on("mouseleave", () => { show(null, null); hideTip(); });
    const groupIds = (gid) => new Set(nodes.filter((n) => n.g === gid).map((n) => n.id));
    document.getElementById("ngroups").addEventListener("mouseover", (ev) => {
      const li = ev.target.closest("li[data-g]");
      if (li) { const ids = groupIds(+li.dataset.g); show(ids, ids); }
    });
    document.getElementById("ngroups").addEventListener("mouseleave", () => show(null, null));
    const q = document.getElementById("nq");
    const find = () => {
      const n = nodes.find((x) => x.name.toLowerCase() === q.value.trim().toLowerCase());
      if (n) show(nbr.get(n.id), new Set([n.id])); else show(null, null);
    };
    q.addEventListener("input", find);
    if (focus) find();
  }

  /* the register entries this letter names (automatic tagging of one machine reading) */
  function fillLetterNames(id) {
    const el = document.getElementById("lreg");
    if (!el || !state.reg) return;
    const mine = state.regByLetter.get(id);
    if (!mine) { el.innerHTML = ""; return; }
    const part = (f, label) => {
      const ids = mine[f].slice().sort((a, b) => state.reg.entries[b].m - state.reg.entries[a].m);
      if (!ids.length) return "";
      return `<span class="kwlab">${label}:</span>${ids.slice(0, 12).map((x) => `<a href="#/entry/${encodeURIComponent(x)}" class="r-${f}">${esc(state.reg.entries[x].n)}</a>`).join("")}${ids.length > 12 ? `<span class="muted small">+${ids.length - 12}</span>` : ""}`;
    };
    const html = [part("pl", T("Places", "Orte")), part("per", T("Persons", "Personen")), part("org", T("Organisations", "Organisationen"))].filter(Boolean);
    el.innerHTML = html.length ? `<div class="kw kwl regl">${html.join("")}</div><p class="small muted">${T("Names found by the automatic tagging (hmBERT, qwen3.8, gpt-oss) of the Gemini 4 Argon reading and joined into the generated register; unchecked.", "Namen, die die automatische Auszeichnung (hmBERT, qwen3.8, gpt-oss) in der Lesung von Gemini 4 Argon gefunden hat, ins generierte Register zusammengeführt; ungeprüft.")}</p>` : "";
  }

  /* ---------- letters ---------- */
  const draftMark = () => `<span class="badge auto" title="${T("Drafted by a language model from an uncorrected machine reading", "Von einem Sprachmodell aus einer unkorrigierten maschinellen Lesung entworfen")}">${T("machine draft", "Maschinenentwurf")}</span>`;

  function letterRow(l, extra = "", href = `#/letter/${encodeURIComponent(l.id)}/1`) {
    return `<div class="row lrow">
      <span class="th">${l.tk ? `<img src="${thumb(l.tk)}" alt="" loading="lazy" width="44" height="60">` : ""}</span>
      <span class="num">${T("No.", "Nr.")} ${esc(l.nr)}</span>
      <span class="body"><a class="who" href="${href}">${esc(titleOf(l))}</a>
        <span class="small muted">${l.y ? `${esc(shortDate(l))} · ` : ""}${num(l.n)} ${P(l.n, "page", "pages", "Seite", "Seiten")}${l.x ? ` + ${num(l.x)} ${P(l.x, "further scan", "further scans", "weitere Aufnahme", "weitere Aufnahmen")}` : ""}</span>
        ${l.h ? `<span class="reg">${esc(l.h)} ${draftMark()}</span>` : ""}${extra}</span>
    </div>`;
  }

  function showList() {
    setNav("letters");
    const letters = state.index.letters;
    const shelves = [...new Set(letters.map((l) => l.shelf))];
    const drafted = letters.filter((l) => l.h).length;
    app.innerHTML = `
      <section class="intro">
        <h1>${T("The Thun Missives, read by machines", "Die Thuner Missiven, von Maschinen gelesen")}</h1>
        <p>${T(`Letters received by the town of Thun in the 15th and 16th centuries, many from the Schultheiss and council of Bern,
          kept in the Burgerarchiv Thun: ${num(letters.length)} letters on ${num(state.index.pages)} pages, each page with its image and ${machineReaders()}.
          There is no edition: nothing here is a checked transcription. 139 pages also have a hand transcription from a course of 2016/17.`,
          `Briefe an die Stadt Thun aus dem 15. und 16. Jahrhundert, viele von Schultheiss und Rat von Bern, im Burgerarchiv Thun:
          ${num(letters.length)} Briefe auf ${num(state.index.pages)} Seiten, jede Seite mit ihrem Bild und ${machineReaders()}.
          Es gibt keine Edition: Nichts hier ist eine geprüfte Transkription. 139 Seiten haben zudem eine Handtranskription aus einem Kurs von 2016/17.`)}</p>
        <p class="small muted">${DIGI()} ${T("The letters were told apart by the file names of the scans, which carry the shelfmark and number.",
          "Die Briefe sind nach den Dateinamen der Aufnahmen getrennt, die Signatur und Nummer tragen.")}
          ${drafted ? T(`${num(drafted)} letters have a heading and regest drafted by a language model: machine drafts, unchecked.`,
            `${num(drafted)} Briefe haben eine von einem Sprachmodell entworfene Überschrift und ein Regest: Maschinenentwürfe, ungeprüft.`) : ""}</p>
      </section>
      <div class="ovgrid">${timelineHtml()}${keywordsHtml()}</div>
      ${mapHtml()}${sankeyHtml()}
      <div class="filters">
        <input id="q" type="search" placeholder="${T("Filter by shelfmark, number, sender, recipient…", "Nach Signatur, Nummer, Absender, Empfänger filtern…")}" value="${esc(state.filter)}" aria-label="${T("Filter letters", "Briefe filtern")}">
        <span id="count" class="muted small"></span>
        <a class="small" href="#/search">${T("Search the text →", "Im Text suchen →")}</a>
      </div>
      <nav class="shelves small" aria-label="${T("Shelfmarks", "Signaturen")}">${shelves.map((s) => `<a href="#/" data-shelf="${esc(s)}">BAT ${esc(s)}</a>`).join("")}</nav>
      <div id="list"></div>`;
    const q = document.getElementById("q");
    const draw = () => {
      state.filter = q.value;
      const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
      const rows = words.length ? letters.filter((l) => {
        const hay = [l.id, titleOf(l), `BAT ${l.shelf}, Nr. ${l.nr}`, l.h || "", l.s || "", l.r || "", l.y || ""].join(" ").toLowerCase();
        return words.every((w) => hay.includes(w));
      }) : letters;
      document.getElementById("count").textContent = `${num(rows.length)} ${P(rows.length, "letter", "letters", "Brief", "Briefe")}`;
      document.getElementById("list").innerHTML = shelves.map((s) => {
        const ls = rows.filter((l) => l.shelf === s);
        if (!ls.length) return "";
        return `<h2 class="shelf" id="shelf-${esc(s)}">BAT ${esc(s)} <span class="muted small">${num(ls.length)} ${P(ls.length, "letter", "letters", "Brief", "Briefe")}</span></h2>
          <div class="list">${ls.map((l) => letterRow(l)).join("")}</div>`;
      }).join("") || `<p class="empty">${T("No letter matches.", "Kein Brief passt.")}</p>`;
    };
    q.addEventListener("input", draw);
    const tl = app.querySelector(".tl");
    if (tl) {
      ["mouseover", "focusin"].forEach((e) => tl.addEventListener(e, tlTip));
      ["mouseout", "focusout"].forEach((e) => tl.addEventListener(e, (ev) => { if (!ev.relatedTarget || !ev.relatedTarget.closest || !ev.relatedTarget.closest(".tl-bar")) hideTip(); }));
      const z = document.getElementById("tl-zoom");
      z && z.addEventListener("change", () => { state.zoom = +z.value; const y = window.scrollY; hideTip(); showList(); window.scrollTo(0, y); const z2 = document.getElementById("tl-zoom"); z2 && z2.focus(); });
    }
    destroyMaps();
    drawOverviewMap();
    const mp = document.getElementById("mapposs");
    mp && mp.addEventListener("change", () => { state.mapPoss = mp.checked; destroyMaps(); drawOverviewMap(); });
    const sk = document.getElementById("sankey"), skk = document.getElementById("skk");
    if (sk && skk) {
      drawSankey(sk, skk.value);
      skk.addEventListener("change", () => {
        state.skKey = skk.value;
        drawSankey(sk, skk.value);
        const a = skk.parentElement.querySelector("a");
        if (a) a.href = kwHref(skk.value);
      });
    }
    app.querySelector(".shelves").addEventListener("click", (ev) => {
      const a = ev.target.closest("[data-shelf]");
      if (!a) return;
      ev.preventDefault();
      const h = document.getElementById("shelf-" + a.dataset.shelf);
      h && h.scrollIntoView();
    });
    draw();
  }

  function machineReaders() {
    const names = state.readers.filter((r) => r.id !== "hand-2017").map((r) => esc(loc(r, "label")));
    if (!names.length) return T("no reading yet", "noch keiner Lesung");
    const list = names.length > 1 ? names.slice(0, -1).join(", ") + T(" and ", " und ") + names[names.length - 1] : names[0];
    return P(names.length, `the reading of ${list}`, `the readings of ${list}`, `der Lesung von ${list}`, `den Lesungen von ${list}`);
  }

  /* ---------- readers ---------- */
  function showReaders() {
    setNav("readers");
    const rs = state.readers;
    const pairs = [];
    rs.forEach((a, i) => rs.slice(i + 1).forEach((b) => { const d = (a.disagreement || {})[b.id]; if (d) pairs.push([a, b, d]); }));
    app.innerHTML = `
      <section class="prose">
        <h1>${T("Readers", "Leser")}</h1>
        <p>${T(`Every reader here is a machine, and none has been checked against a transcription: there is no edition and no ground truth
          for these letters. The viewer therefore shows no error rates.`,
          `Jeder Leser hier ist eine Maschine, und keiner ist an einer Transkription geprüft: Für diese Briefe gibt es weder Edition noch Ground Truth.
          Der Viewer zeigt darum keine Fehlerraten.`)}</p>
      </section>
      <div class="scroll"><table class="scores">
        <thead><tr><th>${T("Reader", "Leser")}</th><th>${T("Kind", "Art")}</th><th>${T("Pages read", "Seiten gelesen")}</th><th>${T("About", "Beschreibung")}</th></tr></thead>
        <tbody>${rs.map((r) => `
          <tr><td><b>${esc(loc(r, "label"))}</b><div class="muted small"><code>${esc(r.id)}</code></div></td><td>${esc(loc(r, "kind"))}</td>
          <td class="n">${num(r.pages_read || 0)} / ${num(state.index.pages)}</td>
          <td class="small">${esc(loc(r, "about"))}${r.caveat ? `<div class="caveat">${esc(loc(r, "caveat"))}</div>` : ""}</td></tr>`).join("")}
        </tbody></table></div>
      <section class="prose">
        <h2>${T("Disagreement between readers", "Abweichung zwischen Lesern")}</h2>
        <p class="muted small">${T(`Where two readers have read the same page: Levenshtein edits between their texts ÷ the length of the longer one, whitespace collapsed, summed over the pages both read.
          This is <b>disagreement, never quality</b>: it does not say which of the two is right, and a model that invents fluent text disagrees exactly as much as one that reads badly.`,
          `Wo zwei Leser dieselbe Seite gelesen haben: Levenshtein-Änderungen zwischen ihren Texten ÷ die Länge des längeren, Leerraum zusammengefasst, summiert über die Seiten, die beide gelesen haben.
          Das ist <b>Abweichung, nie Qualität</b>: Es sagt nicht, welcher der beiden recht hat, und ein Modell, das flüssigen Text erfindet, weicht genauso stark ab wie eines, das schlecht liest.`)}</p>
        ${pairs.length ? `<div class="scroll"><table class="scores"><thead><tr><th>${T("Reader", "Leser")}</th><th>${T("Reader", "Leser")}</th><th>${T("Disagreement", "Abweichung")}</th><th>${T("Pages both read", "Von beiden gelesen")}</th></tr></thead>
          <tbody>${pairs.sort((x, y) => x[2].value - y[2].value).map(([a, b, d]) => `<tr><td>${esc(loc(a, "label"))}</td><td>${esc(loc(b, "label"))}</td><td class="n">${pct(d.value)}</td><td class="n">${num(d.pages)}</td></tr>`).join("")}</tbody></table></div>`
          : `<p class="empty">${T("Only one reader so far: nothing to compare yet.", "Bisher nur ein Leser: noch nichts zu vergleichen.")}</p>`}
      </section>`;
  }

  function showAbout() {
    setNav("about");
    app.innerHTML = LANG === "de" ? `<section class="prose">
      <h1>Über diese Seite</h1>
      <p>Eine Demonstration der <a href="https://www.dh.unibe.ch/" target="_blank" rel="noopener">Digital Humanities der Universität Bern</a>
      an den Thuner Missiven: Briefe an die Stadt Thun aus dem 15. und 16. Jahrhundert, viele von Schultheiss und Rat von Bern, im Burgerarchiv Thun (BAT).
      Die Seiten liegen in der Transkribus-Sammlung 2329424 («BAT Thuner Missiven neu»), 36 Dokumente nach Signatur (663 bis 666.1) und Briefnummern.</p>
      <h2>Was zu sehen ist</h2>
      <ul>
        <li><b>Briefe mit ihren Bildern.</b> Die Digitalisierung erfolgte durch die Universität Zürich (Lehrstuhl Prof. Simon Teuscher). Die Bilder werden von Transkribus ausgeliefert (IIIF) und lassen sich vergrössern.</li>
        <li><b>Die Einheit ist der Brief.</b> Die Briefe sind nach den Dateinamen der Aufnahmen getrennt, die Signatur, Nummer und Seite tragen (z. B. <code>BAT_666.1_500_r.png</code>: BAT 666.1, Nr. 500, Recto). Einige Briefe sind ein zweites Mal aufgenommen; diese Aufnahmen stehen nach den Seiten als «weitere Aufnahme».</li>
        <li><b>St. Gallen.</b> Zwischen den Thuner und den <a href="https://dhbern.github.io/sg-missiven-data/" target="_blank" rel="noopener">St. Galler Missiven</a> wurde kein gleicher Brief und keine Antwort gefunden (Vergleich vom 15.11.2026, auf der Argon-Lesung wiederholt am 18.11.2026). Wo zwei Briefe dasselbe Ereignis betreffen, steht ein Hinweis beim Brief. In Thun liegt ein Brief aus St. Gallen von 1412 (<a href="#/letter/bat_663_176/1">BAT 663, Nr. 176</a>). In St. Gallen liegt ein Brief aus Thun von 1632 (<a href="https://dhbern.github.io/sg-missiven-data/#/letter/stasg_missiv_unedited_02887/1" target="_blank" rel="noopener">Nr. 2887</a>), später als die Thuner Briefe hier.</li>
        <li><b>Keine Edition; Handtranskriptionen für 139 Seiten.</b> Es gibt keine geprüfte Edition. 139 Seiten aus 126 Briefen sind 2016/17 in einem Kurs von Hand in Transkribus transkribiert worden; sie stehen als Leser «Handtranskription (2017)» an erster Stelle, ungeprüft. An ihnen gemessen liegt Gemini 4 Argon bei 12,8 % Zeichenfehlern, PyLaia bei 16,4 %, Gemini 3.8 Flash bei 19,7 % (<a href="https://github.com/DHBern/thun-missiven-data/blob/main/docs/GROUND_TRUTH.md" target="_blank" rel="noopener">docs/GROUND_TRUTH.md</a>). Alle anderen Seiten haben nur maschinelle Lesungen, unkorrigiert.</li>
        <li><b>Überschriften und Regesten sind Maschinenentwürfe.</b> Ein offenes Sprachmodell (Qwen3.8-27B auf dem GPUStack der Universität Bern) entwirft sie aus der besten vorhandenen Lesung eines Briefs, mit Briefen der St. Galler Edition als Stilvorlagen. Niemand hat sie geprüft; Namen und Daten können falsch sein. Briefe ohne Entwurf zeigen keinen.</li>
        <li><b>Lesungen vergleichen</b>: Wo eine Seite mehrere Lesungen hat, zeigt «Vergleichen mit …» Wort für Wort, was die eine Lesung hat und die andere nicht. Die Prozentzahl ist <i>Abweichung, nie Qualität</i>.</li>
        <li><b>Suche</b> im Text einer Lesung, Brief für Brief, mit «Schreibvarianten zulassen» (u/v/w, i/y/j, ſ/s, Doppelbuchstaben, ů/uo/u, ä/ae/a, Worttrennung am Zeilenende) und Facetten nach Signatur, Jahrzehnt und Jahr, Schlagwort, genanntem Ort, genannter Person und Organisation (Register), Absender, Empfänger und Regest.</li>
        <li><b>Daten.</b> Jahr und Tag jedes Briefs sind nach Regeln aus der Datumszeile gelesen, die der Regestentwurf aus einer maschinellen Lesung zitiert (<code>scripts/dates.py</code>). Ein aus einem Fest berechneter Tag ist julianisch; wo vom Jahr nur die letzten Ziffern geschrieben sind, stammt das Jahrhundert von den benachbarten datierten Briefen und ist unsicher. Schlagwörter vergibt ein Sprachmodell aus den Regestentwürfen, gewählt aus dem Vokabular der St. Galler Edition; ungeprüft.</li>
        <li><b>Register, Karte und Sankey.</b> Personen, Orte und Organisationen sind in der Lesung von Gemini 4 Argon nach dem Verfahren der St. Galler Missiven ausgezeichnet: das Modell der St. Galler Edition (hmBERT) und qwen3.8-27b schlagen vor, gpt-oss-120b entscheidet. An Thun ist das nicht gemessen. Daraus ist ein Register automatisch generiert (<code>scripts/register.py</code>): Schreibungen zusammengeführt, Personen nur innerhalb von 30 Jahren, jeder Eintrag mit dem HLS, der SSRQ, der Königsfelder Edition und den St. Galler Missiven abgeglichen und die Kandidaten nach den Regeln aus St. Gallen als sicher, wahrscheinlich oder möglich eingestuft. Koordinaten stammen nur von einem solchen Kandidaten, nie aus dem Namen allein. Die Übersicht zeigt die Orte auf einer Karte und ein Sankey-Diagramm vom Schlagwort zu seinen Begleitern und deren Jahrzehnten. Die Seite <a href="#/keywords">Schlagwörter</a> zeigt jedes Schlagwort nach zwanzig Jahren (Heatmap, als Anzahl oder Anteil) und ein <a href="#/keywords/network">Netzwerk</a> der Schlagwörter, die oft zusammen vergeben sind, beides nach dem Vorbild der St. Galler Missiven. Nichts davon ist geprüft; eine Stichprobe steht in <a href="https://github.com/DHBern/thun-missiven-data/blob/main/docs/REGISTER.md" target="_blank" rel="noopener">docs/REGISTER.md</a>.</li>
      </ul>
      <h2>Geplant</h2>
      <p>Weitere Leser: ein feinjustiertes Qwen3.5-4B (Kurrent, ganze Seiten), kraken und TrOCR; Regestentwürfe für alle Briefe. Eine von Hand ausgezeichnete Stichprobe, an der sich die Auszeichnung und das Register an Thun messen lassen (docs/NER_REGISTER_PLAN.md).</p>
      <h2>Daten und Code</h2>
      <p><a href="https://github.com/DHBern/thun-missiven-data" target="_blank" rel="noopener">github.com/DHBern/thun-missiven-data</a> – die Lesungen liegen in <code>readings/</code>, eine JSON-Zeile pro Seite und Leser, die Briefe in <code>readings/letters.tsv</code>, die Regestentwürfe in <code>regests/drafts.jsonl</code>. Der Viewer ist aus dem der <a href="https://dhbern.github.io/sg-missiven-data/" target="_blank" rel="noopener">St. Galler Missiven</a> abgeleitet.</p>
    </section>` : `<section class="prose">
      <h1>About</h1>
      <p>A demonstration by <a href="https://www.dh.unibe.ch/" target="_blank" rel="noopener">Digital Humanities, University of Bern</a>,
      on the Thun Missives: letters received by the town of Thun in the 15th and 16th centuries, many from the Schultheiss and council of Bern, kept in the Burgerarchiv Thun (BAT).
      The pages are in Transkribus collection 2329424 ("BAT Thuner Missiven neu"), 36 documents by shelfmark (663 to 666.1) and letter numbers.</p>
      <h2>What you see</h2>
      <ul>
        <li><b>Letters with their images.</b> The letters were digitised by the University of Zurich (Chair of Prof. Simon Teuscher). The images are served by Transkribus (IIIF) and can be zoomed.</li>
        <li><b>The unit is the letter.</b> The letters were told apart by the file names of the scans, which carry shelfmark, number and side (e.g. <code>BAT_666.1_500_r.png</code>: BAT 666.1, no. 500, recto). Some letters were scanned a second time; those scans follow the pages as "further scan".</li>
        <li><b>St. Gallen.</b> No letter was found in both the Thun and the <a href="https://dhbern.github.io/sg-missiven-data/" target="_blank" rel="noopener">St. Gallen Missives</a>, and none that answers one in the other (compared 15.11.2026, repeated on the Argon reading 18.11.2026). Where two letters concern the same event, a hint stands with the letter. Thun holds a letter from St. Gallen of 1412 (<a href="#/letter/bat_663_176/1">BAT 663, no. 176</a>). St. Gallen holds a letter from Thun of 1632 (<a href="https://dhbern.github.io/sg-missiven-data/#/letter/stasg_missiv_unedited_02887/1" target="_blank" rel="noopener">no. 2887</a>), later than the Thun letters here.</li>
        <li><b>No edition; hand transcriptions for 139 pages.</b> There is no checked edition. 139 pages of 126 letters were transcribed by hand in Transkribus in a course in 2016/17; they are the first reader, "Hand transcription (2017)", unchecked. Measured against them, Gemini 4 Argon has 12.8 % character errors, PyLaia 16.4 %, Gemini 3.8 Flash 19.7 % (<a href="https://github.com/DHBern/thun-missiven-data/blob/main/docs/GROUND_TRUTH.md" target="_blank" rel="noopener">docs/GROUND_TRUTH.md</a>). All other pages have machine readings only, uncorrected.</li>
        <li><b>Headings and regests are machine drafts.</b> An open language model (Qwen3.8-27B on the University of Bern's GPUStack) drafts them from the best reading a letter has, with letters of the St. Gallen edition as style examples. Nobody has checked them; names and dates may be wrong. Letters without a draft show none.</li>
        <li><b>Compare readings</b>: where a page has more than one reading, "Compare with …" marks word by word what one reading has and the other lacks. The percentage is <i>disagreement, never quality</i>.</li>
        <li><b>Search</b> in the text of one reading, letter by letter, with "tolerant spelling" (u/v/w, i/y/j, ſ/s, doubled letters, ů/uo/u, ä/ae/a, words broken at the line end) and facets for shelfmark, decade and year, keyword, place, person and organisation named (register), sender, recipient and regest.</li>
        <li><b>Dates.</b> Each letter's year and day are read by rule from the date line that the regest draft quotes from a machine reading (<code>scripts/dates.py</code>). A day computed from a feast is Julian; where only the last digits of the year are written, the century comes from the neighbouring dated letters and is uncertain. Keywords are assigned by a language model from the regest drafts, chosen from the St. Gallen edition's vocabulary; unchecked.</li>
        <li><b>Register, map and Sankey.</b> Persons, places and organisations are tagged on the Gemini 4 Argon reading by the St. Gallen Missives' method: the St. Gallen edition's model (hmBERT) and qwen3.8-27b propose, gpt-oss-120b decides. It is not measured on Thun. A register is generated from the tags (<code>scripts/register.py</code>): spellings joined, persons only within 30 years, every entry matched against HLS, the SSRQ, the Königsfelden edition and the St. Gallen Missives, the candidates graded certain, likely or possible by St. Gallen's rules. Coordinates come only from such a candidate, never from a name alone. The overview shows the places on a map and a Sankey from a keyword to its companions and their decades. The <a href="#/keywords">Keywords</a> page shows each keyword by twenty years (heatmap, as a count or a share) and a <a href="#/keywords/network">network</a> of the keywords often given together, both after the St. Gallen Missives. None of it is checked; a spot check is in <a href="https://github.com/DHBern/thun-missiven-data/blob/main/docs/REGISTER.md" target="_blank" rel="noopener">docs/REGISTER.md</a>.</li>
      </ul>
      <h2>Planned</h2>
      <p>More readers: a fine-tuned Qwen3.5-4B (Kurrent, whole pages), kraken and TrOCR; regest drafts for every letter. A hand-tagged sample on which the tagging and the register can be measured on Thun (docs/NER_REGISTER_PLAN.md).</p>
      <h2>Data and code</h2>
      <p><a href="https://github.com/DHBern/thun-missiven-data" target="_blank" rel="noopener">github.com/DHBern/thun-missiven-data</a> — the readings are in <code>readings/</code>, one JSON line per page and reader, the letters in <code>readings/letters.tsv</code>, the regest drafts in <code>regests/drafts.jsonl</code>. The viewer is derived from the <a href="https://dhbern.github.io/sg-missiven-data/" target="_blank" rel="noopener">St. Gallen Missives</a> viewer.</p>
    </section>`;
  }

  /* ---------- search ---------- */
  /* Full text over the letters, in the reading of one reader. The text is
     sharded per reader (site/data/search/<reader>/text-N.json: letter id ->
     its page texts) and loaded, in parallel, only once a query is typed.
     Without a query the facets alone select letters. The whole search lives
     in the URL. */
  const FACETS = [
    { k: "sh", en: "Shelfmark", de: "Signatur" },
    { k: "dec", en: "Decade", de: "Jahrzehnt" },
    { k: "yr", en: "Year", de: "Jahr" },
    { k: "kw", en: "Keyword (machine)", de: "Schlagwort (maschinell)" },
    { k: "pl", en: "Place named (automatic)", de: "Genannter Ort (automatisch)" },
    { k: "per", en: "Person named (automatic)", de: "Genannte Person (automatisch)" },
    { k: "org", en: "Organisation named (automatic)", de: "Genannte Organisation (automatisch)" },
    { k: "snd", en: "Sender (draft)", de: "Absender (Entwurf)" },
    { k: "rcp", en: "Recipient (draft)", de: "Empfänger (Entwurf)" },
    { k: "dr", en: "Regest", de: "Regest" },
  ];
  const BIG = new Set(["pl", "per", "org"]);
  const texts = new Map();   // reader -> Promise<{letter id: [page texts]}>
  const normed = new Map();  // reader|tol -> Map(letter id -> [normalised page texts])
  let searchTimer = null;

  function searchTexts(reader) {
    if (!texts.has(reader)) {
      const n = state.index.search[reader] || 0;
      texts.set(reader, Promise.all(Array.from({ length: n }, (_, i) => json(`data/search/${encodeURIComponent(reader)}/text-${i}.json`)))
        .then((shards) => Object.assign({}, ...shards)));
    }
    return texts.get(reader);
  }

  /* Normalise for matching, keeping for every output character the position it
     came from (for highlighting). Tolerant: the old spelling's variants count as
     one: u/v/w, i/y/j, ſ/s, doubled letters, ů = uo = u, ä = ae = a, and a word
     broken at the line end. */
  function normText(str, tol) {
    let out = "", map = [], last = " ";
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (tol && (c === "-" || c === "¬" || c === "=") && /^[ \t]*\n/.test(str.slice(i + 1, i + 4))) {
        while (i + 1 < str.length && str[i + 1] !== "\n") i++;
        i++; // the line break: the word continues on the next line
        continue;
      }
      let d = c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace("ß", "ss").replace("ſ", "s");
      if (tol) d = d.replace(/[vw]/g, "u").replace(/[yj]/g, "i");
      for (let ch of d) {
        if (!/[a-z0-9]/.test(ch)) ch = " ";
        if (ch === " " && last === " ") continue;
        if (tol && ch !== " " && ch === last) continue;
        if (tol && ((ch === "e" && /[aou]/.test(last)) || (ch === "o" && last === "u"))) continue;
        out += ch; map.push(i); last = ch;
      }
    }
    return { s: out, map };
  }

  function parseQuery(q, tol) {
    const terms = [];
    q.replace(/"([^"]+)"|(\S+)/g, (_, ph, w) => { const t = normText(ph || w, tol).s.trim(); if (t) terms.push(t); });
    return terms;
  }

  function snippet(text, terms, tol) {
    const { s: t, map } = normText(text, tol);
    const spans = [];
    for (const x of terms) { let i = t.indexOf(x); while (i >= 0 && spans.length < 40) { spans.push([map[i], map[i + x.length - 1] + 1]); i = t.indexOf(x, i + x.length); } }
    spans.sort((a, b) => a[0] - b[0]);
    if (!spans.length) return "";
    const a = Math.max(0, spans[0][0] - 70), b = Math.min(text.length, spans[0][1] + 110);
    let out = "", at = a;
    for (const [x, y] of spans) { if (x < at || y > b) continue; out += esc(text.slice(at, x)) + `<mark>${esc(text.slice(x, y))}</mark>`; at = y; }
    out += esc(text.slice(at, b));
    return (a > 0 ? "…" : "") + out.replace(/\n/g, " / ") + (b < text.length ? "…" : "") + (spans.length > 1 ? ` <span class="muted">(${spans.length}×)</span>` : "");
  }

  /* a letter's values for a facet: one, or none, or (keywords) several */
  function facetValues(l, k) {
    const one = (v) => (v ? [v] : []);
    if (k === "sh") return one(l.shelf);
    if (k === "dec") return one(l.y ? String(Math.floor(l.y / 10) * 10) : "");
    if (k === "yr") return one(l.y ? String(l.y) : "");
    if (k === "kw") return l.k || [];
    if (k === "pl" || k === "per" || k === "org") return ((state.regByLetter && state.regByLetter.get(l.id)) || {})[k] || [];
    if (k === "snd") return one(l.s);
    if (k === "rcp") return one(l.r);
    if (k === "dr") return [l.h ? "yes" : "no"];
    return [];
  }
  function facetLabel(k, v) {
    if (k === "sh") return "BAT " + v;
    if (k === "dec") return T(`${v}s`, `${v}er`);
    if (k === "dr") return v === "yes" ? T("Machine draft", "Maschinenentwurf") : T("None yet", "noch keines");
    if ((k === "pl" || k === "per" || k === "org") && state.reg) {
      const e = state.reg.entries[v];
      return e ? e.n + (k === "per" && e.y ? ` (${e.y[0]}${e.y[1] !== e.y[0] ? "–" + e.y[1] : ""})` : "") : v;
    }
    return v;
  }

  async function showSearch(params) {
    setNav("search");
    if (["pl", "per", "org"].some((k) => params.has(k)) || state.index.registers) await loadRegisters();
    const readers = state.readers.filter((r) => state.index.search[r.id]);
    const ui = { q: params.get("q") || "", tol: params.get("tol") !== "0", shown: 50, ff: {},
                 reader: readers.some((r) => r.id === params.get("r")) ? params.get("r") : (readers.some((r) => r.id === state.reader) ? state.reader : (readers[0] || {}).id) };
    const sel = Object.fromEntries(FACETS.map((f) => [f.k, new Set(params.getAll(f.k))]));
    const shelfOrder = [...new Set(state.index.letters.map((l) => l.shelf))];
    app.innerHTML = `
      <section class="intro">
        <h1>${T("Search", "Suche")}</h1>
        <p>${T(`The text of every letter as one machine read it. These are uncorrected readings: a word the machine misread is not found under its right spelling, so try variants, or let the search tolerate spelling variants.
              Without words, the facets alone select letters.`,
              `Der Text jedes Briefs, wie eine Maschine ihn gelesen hat. Die Lesungen sind unkorrigiert: Ein falsch gelesenes Wort wird unter seiner richtigen Schreibung nicht gefunden; Varianten versuchen oder Schreibvarianten zulassen.
              Ohne Suchwort wählen die Facetten allein Briefe aus.`)}</p>
        <p class="small muted">${T("Decade and year are read by rule from the date line of the machine-drafted regest (an abbreviated year takes its century from neighbouring letters and is uncertain); sender and recipient come from the regest drafts; keywords were assigned by a language model from those drafts. All machine-made, unchecked.",
          "Jahrzehnt und Jahr sind nach Regeln aus der Datumszeile des Regestentwurfs gelesen (ein abgekürztes Jahr nimmt sein Jahrhundert von benachbarten Briefen und ist unsicher); Absender und Empfänger stammen aus den Regestentwürfen; die Schlagwörter hat ein Sprachmodell aus diesen Entwürfen vergeben. Alles maschinell, ungeprüft.")}</p>
      </section>
      <div class="sbar">
        <input id="sq" type="search" value="${esc(ui.q)}" placeholder="${T('Words or "a phrase" in the text…', 'Wörter oder «eine Wendung» im Text…')}" aria-label="${T("Search the text", "Text durchsuchen")}">
        <label class="small"><input type="checkbox" id="stol" ${ui.tol ? "checked" : ""}> ${T("tolerant spelling", "Schreibvarianten zulassen")}</label>
        <select id="sr" aria-label="${T("Reading to search", "Lesung, in der gesucht wird")}">${readers.map((r) => `<option value="${esc(r.id)}" ${r.id === ui.reader ? "selected" : ""}>${T("in", "in")} ${esc(loc(r, "label"))}</option>`).join("")}</select>
        <button type="button" id="sreset" class="linkish">${T("Reset", "Zurücksetzen")}</button>
      </div>
      <div class="search">
        <div class="facetwrap">
          <button type="button" id="ftoggle" class="ftoggle" aria-expanded="false" aria-controls="facets">${T("Facets", "Facetten")} <span id="fsel"></span></button>
          <aside class="facets" id="facets" aria-label="${T("Facets", "Facetten")}"></aside>
        </div>
        <section class="results"><p id="scount" class="muted small"></p><div id="sres" class="list"></div></section>
      </div>`;
    const $ = (id) => document.getElementById(id);
    const toUrl = () => {
      const u = new URLSearchParams();
      if (ui.q) u.set("q", ui.q);
      if (!ui.tol) u.set("tol", "0");
      if (ui.reader && ui.reader !== (readers[0] || {}).id) u.set("r", ui.reader);
      for (const f of FACETS) for (const v of sel[f.k]) u.append(f.k, v);
      const h = "#/search" + (u.toString() ? "?" + u : "");
      if (location.hash !== h) history.replaceState(null, "", location.pathname + location.search + h);
    };
    const sortVals = (k, counts) => [...counts.entries()].sort((a, b) => {
      if (k === "sh") return shelfOrder.indexOf(a[0]) - shelfOrder.indexOf(b[0]);
      if (k === "dec" || k === "yr") return +a[0] - +b[0];
      if (k === "dr") return a[0] === "yes" ? -1 : 1;
      return b[1] - a[1] || a[0].localeCompare(b[0], "de");
    });

    const run = async () => {
      toUrl();
      const terms = parseQuery(ui.q, ui.tol);
      const nSel = FACETS.reduce((n, f) => n + sel[f.k].size, 0);
      let base;
      if (terms.length && ui.reader) {
        $("scount").textContent = T("Loading the texts…", "Die Texte werden geladen…");
        const all = await searchTexts(ui.reader);
        const nk = ui.reader + "|" + ui.tol;
        if (!normed.has(nk)) normed.set(nk, new Map());
        const cache = normed.get(nk);
        base = [];
        for (const l of state.index.letters) {
          const pages = all[l.id];
          if (!pages) continue;
          if (!cache.has(l.id)) cache.set(l.id, pages.map((t) => normText(t, ui.tol).s));
          const ns = cache.get(l.id);
          if (!terms.every((x) => ns.some((t) => t.includes(x)))) continue;
          const at = Math.max(0, ns.findIndex((t) => t.includes(terms[0])));
          base.push({ l, page: at + 1, text: pages[at] });
        }
      } else if (nSel) {
        base = state.index.letters.map((l) => ({ l }));
      } else {
        $("facets").innerHTML = facetsHtml(state.index.letters.map((l) => ({ l })), () => true);
        $("fsel").textContent = "";
        $("scount").textContent = "";
        $("sres").innerHTML = `<p class="empty">${readers.length ? T("Type a word to search, or choose a facet.", "Ein Wort eingeben oder eine Facette wählen.") : T("No reading to search yet.", "Noch keine Lesung zum Durchsuchen.")}</p>`;
        return;
      }
      /* several keywords: letters with all of them; any other facet: with any of the values */
      const passes = (h, except) => FACETS.every((f) => f.k === except || !sel[f.k].size
        || (f.k === "kw" ? [...sel.kw].every((v) => facetValues(h.l, "kw").includes(v)) : facetValues(h.l, f.k).some((v) => sel[f.k].has(v))));
      const rows = base.filter((h) => passes(h, null));
      $("fsel").textContent = nSel ? `(${nSel} ${T("selected", "gewählt")})` : "";
      $("facets").innerHTML = facetsHtml(base, passes);
      $("scount").innerHTML = `${num(rows.length)} ${P(rows.length, "letter", "letters", "Brief", "Briefe")}` + (terms.length ? `${T(" with ", " mit ")}` +
        (ui.q.match(/"[^"]+"|\S+/g) || []).map((t) => `<b>${esc(t)}</b>`).join(" + ") + ` · ${esc(readerLabel(ui.reader))}` : "");
      const draw = () => {
        $("sres").innerHTML = rows.slice(0, ui.shown).map((h) => {
          if (!h.text) return letterRow(h.l);
          const href = `#/letter/${encodeURIComponent(h.l.id)}/${h.page}/${encodeURIComponent(ui.reader)}`;
          return letterRow(h.l, `<a class="hit" href="${href}">${snippet(h.text, terms, ui.tol)}</a>`, href);
        }).join("") + (rows.length > ui.shown ? `<button type="button" class="linkish" id="smore">${T(`Show ${Math.min(50, rows.length - ui.shown)} more of ${rows.length - ui.shown}`, `${Math.min(50, rows.length - ui.shown)} weitere von ${rows.length - ui.shown} zeigen`)}</button>` : "")
          + (!rows.length ? `<p class="empty">${T("No letter matches. Remove a facet or a word, or allow spelling variants.", "Kein Brief passt. Eine Facette oder ein Wort entfernen oder Schreibvarianten zulassen.")}</p>` : "");
        const more = $("smore");
        more && more.addEventListener("click", () => { ui.shown += 50; draw(); });
      };
      draw();
    };

    function facetsHtml(base, passes) {
      return FACETS.map((f) => {
        const counts = new Map();
        for (const h of base) if (passes(h, f.k === "kw" ? null : f.k)) for (const v of facetValues(h.l, f.k)) counts.set(v, (counts.get(v) || 0) + 1);
        for (const v of sel[f.k]) if (!counts.has(v)) counts.set(v, 0);
        let vals = sortVals(f.k, counts);
        if (!vals.length) return "";
        const ff = (ui.ff[f.k] || "").toLowerCase();
        const nAll = vals.length;
        /* the register facets are long: the 150 most frequent (and the chosen), or those matching the filter */
        if (BIG.has(f.k) && vals.length > 150) {
          vals = vals.filter(([v], i) => sel[f.k].has(v) || (ff ? facetLabel(f.k, v).toLowerCase().includes(ff) : i < 150)).slice(0, 300);
        }
        /* the year list is long: open once a decade or a year is chosen */
        const open = BIG.has(f.k) ? sel[f.k].size || ff : f.k !== "yr" || sel.yr.size || sel.dec.size;
        return `<details class="facet" ${open ? "open" : ""} data-k="${f.k}"><summary>${T(f.en, f.de)}${sel[f.k].size ? ` <span class="badge">${sel[f.k].size}</span>` : ""} <span class="muted small">${nAll}</span></summary>
          ${nAll > 12 ? `<input class="ffilter" type="search" data-ff="${f.k}" value="${esc(ui.ff[f.k] || "")}" placeholder="${T("Filter…", "Filtern…")}" aria-label="${T("Filter", "Filtern")} ${T(f.en, f.de)}">` : ""}
          <ul>${vals.map(([v, n]) => `<li ${ff && !facetLabel(f.k, v).toLowerCase().includes(ff) ? "hidden" : ""}><label class="${n ? "" : "zero"}"><input type="checkbox" data-k="${f.k}" value="${esc(v)}" ${sel[f.k].has(v) ? "checked" : ""}>
            <span class="fl">${esc(facetLabel(f.k, v))}</span><span class="fc">${num(n)}</span></label></li>`).join("")}</ul></details>`;
      }).join("");
    }

    const later = (f, ms = 250) => { clearTimeout(searchTimer); searchTimer = setTimeout(f, ms); };
    $("sq").addEventListener("input", () => { ui.q = $("sq").value; ui.shown = 50; later(run); });
    $("stol").addEventListener("change", () => { ui.tol = $("stol").checked; run(); });
    $("sr").addEventListener("change", () => { ui.reader = $("sr").value; run(); });
    $("sreset").addEventListener("click", () => { location.hash = "#/search"; });
    $("ftoggle").addEventListener("click", () => {
      const open = $("facets").classList.toggle("shown");
      $("ftoggle").setAttribute("aria-expanded", String(open));
    });
    $("facets").addEventListener("change", (ev) => {
      const box = ev.target.closest("input[type=checkbox][data-k]");
      if (!box) return;
      box.checked ? sel[box.dataset.k].add(box.value) : sel[box.dataset.k].delete(box.value);
      ui.shown = 50;
      run();
    });
    $("facets").addEventListener("input", (ev) => {
      const inp = ev.target.closest("input[data-ff]");
      if (!inp) return;
      ui.ff[inp.dataset.ff] = inp.value;
      if (BIG.has(inp.dataset.ff)) {  // the long lists are filtered by drawing them again
        const k = inp.dataset.ff;
        later(async () => {
          await run();
          const again = document.querySelector(`input[data-ff="${k}"]`);
          if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
        }, 200);
        return;
      }
      const w = inp.value.toLowerCase();
      inp.closest(".facet").querySelectorAll("li").forEach((li) => { li.hidden = !!w && !li.querySelector(".fl").textContent.toLowerCase().includes(w); });
    });
    await run();
  }

  /* ---------- letter ---------- */
  async function getLetter(id) {
    const pos = state.pos.get(id);
    if (pos == null) return null;
    const c = Math.floor(pos / state.index.chunk);
    if (!state.chunks.has(c)) state.chunks.set(c, json(`data/letters/${c}.json`));
    return (await state.chunks.get(c)).find((l) => l.id === id) || null;
  }

  let cur = null;   // the page on screen, for the arrow keys
  function pageKeys(ev) {
    if (!cur || ev.target.closest("input, select, textarea") || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const to = ev.key === "ArrowLeft" ? cur.prev : ev.key === "ArrowRight" ? cur.next : null;
    if (to) { location.hash = to; ev.preventDefault(); }
  }

  async function showLetter(id, pageNo, readerId) {
    setNav("letters");
    cur = null;
    loadRegisters().then(() => fillLetterNames(id));  // the names of this letter, and the entity view's links
    let letter = null;
    try { letter = await getLetter(id); } catch { letter = null; }
    if (!letter) { destroyOsd(); app.innerHTML = `<p>${T("No letter", "Kein Brief")} ${esc(id)}. <a href="#/">${T("All letters", "Alle Briefe")}</a></p>`; return; }
    const pages = letter.pages;
    pageNo = Math.min(Math.max(pageNo || 1, 1), pages.length);
    const page = pages[pageNo - 1];
    if (readerId && state.readers.some((r) => r.id === readerId)) { state.reader = readerId; store.set("reader", readerId); }
    let reader = state.reader;
    if (!page.readings[reader]) {
      const first = state.readers.find((x) => page.readings[x.id]);
      if (first) reader = first.id;
    }

    const pos = state.pos.get(id);
    const prevL = state.index.letters[pos - 1], nextL = state.index.letters[pos + 1];
    const href = (lid, n) => `#/letter/${encodeURIComponent(lid)}/${n}`;
    const prev = pageNo > 1 ? href(id, pageNo - 1) : prevL ? href(prevL.id, 1) : null;
    const next = pageNo < pages.length ? href(id, pageNo + 1) : nextL ? href(nextL.id, 1) : null;
    cur = { prev, next };
    state.view = { page, reader };   // the lines on the image follow the page and reader on screen
    const showImg = store.get("image", true);
    const main = pages.filter((p) => !p.extra).length;
    const pgBtn = (p, i) => `<a class="pg ${i + 1 === pageNo ? "on" : ""}" href="${href(id, i + 1)}" ${i + 1 === pageNo ? 'aria-current="page"' : ""}>${esc(pageLabel(p))}</a>`;

    const keepImage = showImg && state.osd && app.querySelector("#osd") && app.dataset.tk === page.tk;
    const html = `
      <div class="letter ${showImg ? "" : "noimgpane"}">
        <section class="pane textpane">
          <div class="lnav">
            ${prevL ? `<a href="${href(prevL.id, 1)}">← ${esc(titleOf(prevL))}</a>` : "<span></span>"}
            <a href="#/">${T("All letters", "Alle Briefe")}</a>
            ${nextL ? `<a href="${href(nextL.id, 1)}">${esc(titleOf(nextL))} →</a>` : "<span></span>"}
          </div>
          <div class="muted small">${T("Transkribus page", "Transkribus-Seite")} ${esc(page.key)}</div>
          <h1>${esc(titleOf(letter))}</h1>
          ${dateBlock(letter.date)}
          ${kwChips(letter.keywords)}
          ${state.index.registers ? `<div id="lreg" class="lreg"></div>` : ""}
          ${draftBlock(letter.draft, letter.date)}
          ${linksBlock(letter.links)}
          <div class="pages"><span class="lbl">${T("Page", "Seite")}</span>${pages.slice(0, main).map(pgBtn).join("")}
            ${pages.length > main ? `<span class="lbl extra-lbl">${T("Further scan", "Weitere Aufnahme")}</span>${pages.slice(main).map((p, i) => pgBtn(p, main + i)).join("")}` : ""}
            <button type="button" class="linkish imgtoggle" id="imgtoggle" aria-pressed="${showImg}">${showImg ? T("Hide image", "Bild ausblenden") : T("Show image", "Bild zeigen")}</button>
          </div>
          <div class="readers" role="tablist" aria-label="${T("Readings", "Lesungen")}">${readerButtons(page, reader)}</div>
          ${modeSelect(page, reader)}
          <div id="reading">${readingHtml(page, reader)}</div>
        </section>
        ${showImg ? `<section class="pane imgpane">
          <div id="osd" role="img" aria-label="${T("Image of", "Bild von")} ${esc(titleOf(letter))}, ${esc(sideLabel(page.side))}"></div>
          <div class="imgbar"><span><b>${esc(pageLabel(page))}</b>${page.extra ? ` · ${T("further scan", "weitere Aufnahme")}` : ""} <span class="muted">· ${esc(page.img)}</span></span><span id="imglink"></span></div>
          <p class="imgcredit small muted">${DIGI()}</p>
        </section>` : ""}
      </div>
      <footer class="foot">${T("Burgerarchiv Thun · digitised by the University of Zurich (Chair of Prof. Simon Teuscher) · machine readings, uncorrected · DH Bern",
        "Burgerarchiv Thun · Digitalisierung Universität Zürich (Lehrstuhl Prof. Simon Teuscher) · maschinelle Lesungen, unkorrigiert · DH Bern")}</footer>`;

    if (keepImage) {
      app.querySelector(".textpane").outerHTML = new DOMParser().parseFromString(html, "text/html").querySelector(".textpane").outerHTML;
    } else {
      destroyOsd();
      app.innerHTML = html;
      if (showImg) { app.dataset.tk = page.tk; openImage(page); }
    }

    app.querySelectorAll(".rd").forEach((b) => b.addEventListener("click", () => {
      if (b.disabled) return;
      location.hash = `${href(id, pageNo)}/${encodeURIComponent(b.dataset.reader)}`;
    }));
    document.getElementById("imgtoggle").addEventListener("click", () => { store.set("image", !showImg); destroyOsd(); route(); });
    const m = document.getElementById("t-mode");
    m && m.addEventListener("change", () => { state.mode = m.value; store.set("mode", m.value); route(); });
    const det = app.querySelector("details.regest");
    det && det.addEventListener("toggle", () => store.set("regest", det.open));
    const rd = document.getElementById("reading");
    rd.addEventListener("mouseover", entTip);
    rd.addEventListener("click", entTip);
    rd.addEventListener("mouseover", onLineHover);
    rd.addEventListener("mouseleave", () => { if (!pinned) clearRows(); });
    rd.addEventListener("click", onLineClick);
    clearRows();
    if (state.reg) fillLetterNames(id);
  }

  /* A heading and regest drafted by a language model from an uncorrected
     machine reading: always marked as such, with the reading and the model. */
  /* Hints to letters in other collections (links/*.json): what the relation is, and a link. */
  function linksBlock(links) {
    if (!links || !links.length) return "";
    const name = { "st-gallen": T("St. Gallen Missives", "St. Galler Missiven") };
    return `<details class="regest links" open><summary>${T("Related letters in other collections", "Bezüge zu anderen Sammlungen")}</summary>
      ${links.map((l) => `<p>${esc(LANG === "en" ? l.en : l.de)}<br>
        <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(name[l.collection] || l.collection)}${l.label ? ` · ${esc(l.label)}` : ""} ↗</a></p>`).join("")}
    </details>`;
  }

  function draftBlock(d, dt) {
    if (!d) return "";
    /* the date line and the year are shown above, read by rule (dates.py); here only
       where the drafting model's own year differs from that */
    const ruled = dt && (dt.date_text || dt.year);
    const when = (ruled ? [d.place] : [d.place, d.date_text]).filter(Boolean).map(esc).join(", ");
    const yr = ruled ? (d.year && d.year !== dt.year ? T(`the drafting model read the year as ${esc(d.year)}`, `das Sprachmodell las das Jahr als ${esc(d.year)}`) : "")
      : d.year ? T(`year read as ${esc(d.year)} (unchecked)`, `Jahr gelesen als ${esc(d.year)} (ungeprüft)`) : "";
    return `<details class="regest draft" ${store.get("regest", true) ? "open" : ""}>
      <summary>${T("Regest — machine draft", "Regest – Maschinenentwurf")}</summary>
      ${d.heading ? `<div class="meta"><span class="parties">${esc(d.heading)}</span></div>` : ""}
      ${when || yr ? `<p class="small muted">${when}${yr ? `${when ? " · " : ""}${yr}` : ""}</p>` : ""}
      <p lang="de">${esc(d.regest)}</p>
      <p class="small muted">${T(`Heading and regest drafted by ${esc(d.model || "a language model")} from the uncorrected reading ${esc(readerLabel(d.reader))}, not checked by anyone${LANG === "en" ? "; in German" : ""}. Names and dates may be wrong.`,
        `Überschrift und Regest entworfen von ${esc(d.model || "einem Sprachmodell")} aus der unkorrigierten Lesung ${esc(readerLabel(d.reader))}, von niemandem geprüft. Namen und Daten können falsch sein.`)}</p>
    </details>`;
  }

  function readerButtons(page, current) {
    return state.readers.map((r) => {
      const rd = page.readings[r.id];
      const lines = rd && rd.text ? rd.text.split("\n").length : 0;
      const badge = rd ? `<span class="cer">${rd.text ? `${lines} ${P(lines, "line", "lines", "Zeile", "Zeilen")}` : T("empty", "leer")}</span>` : "";
      return `<button class="rd ${r.id === current ? "on" : ""}" role="tab" aria-selected="${r.id === current}" data-reader="${esc(r.id)}" ${rd ? "" : `disabled title="${T("not read on this page", "auf dieser Seite nicht gelesen")}"`}>
        <span>${esc(loc(r, "label"))}<span class="k">${esc(loc(r, "kind"))}</span></span>${badge}</button>`;
    }).join("");
  }

  /* the ways a reading can be shown on this page: the text, the entities (if a
     tagging exists), or a comparison with each other reading of the page */
  function modes(page, reader) {
    const out = [["plain", T("Text only", "Nur Text")]];
    if (hasEnts(page, reader)) out.push(["ents", T("Entities", "Entitäten")]);
    for (const r of state.readers) if (r.id !== reader && page.readings[r.id] && page.readings[r.id].text) out.push(["cmp:" + r.id, T(`Compare with ${loc(r, "label")}`, `Vergleichen mit ${loc(r, "label")}`)]);
    return out;
  }
  function modeFor(page, reader) {
    const ms = modes(page, reader);
    return ms.some(([id]) => id === state.mode) ? state.mode : "plain";
  }
  function modeSelect(page, reader) {
    const ms = modes(page, reader);
    if (ms.length < 2) return "";
    const cur = modeFor(page, reader);
    return `<div class="viewmode"><label for="t-mode">${T("View", "Ansicht")}</label>
      <select id="t-mode">${ms.map(([id, label]) => `<option value="${esc(id)}" ${id === cur ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></div>`;
  }

  function disagreement(page, a, b) {
    const d = page.dis || {};
    return d[`${a}|${b}`] ?? d[`${b}|${a}`];
  }

  function readingHtml(page, readerId) {
    const r = state.readers.find((x) => x.id === readerId);
    if (!r) return `<p class="empty">${T("No reading of this page yet.", "Von dieser Seite gibt es noch keine Lesung.")}</p>`;
    const head = `${r.about ? `<p class="about-reader">${esc(loc(r, "about"))}</p>` : ""}${r.caveat ? `<p class="caveat">${esc(loc(r, "caveat"))}</p>` : ""}`;
    const rd = page.readings[readerId];
    if (!rd) return head + `<p class="empty">${T("Not read on this page.", "Auf dieser Seite nicht gelesen.")}</p>`;
    if (!rd.text) return head + `<p class="empty">${T("Empty reading: the machine found no text on this page.", "Leere Lesung: Die Maschine hat auf dieser Seite keinen Text gefunden.")}</p>`;
    const trunc = rd.truncated ? `<p class="caveat">${T("This reading hit the model's length limit and stops early.", "Diese Lesung hat die Längengrenze des Modells erreicht und bricht vorzeitig ab.")}</p>` : "";
    const mode = modeFor(page, readerId);
    let body, note = "";
    if (mode.startsWith("cmp:")) {
      const other = mode.slice(4);
      const x = disagreement(page, readerId, other);
      note = `<p class="cmp-note small">${T(`<ins>green</ins>: words this reading has and ${esc(readerLabel(other))} has not; <del>red</del>: words of ${esc(readerLabel(other))} missing here.`,
        `<ins>grün</ins>: Wörter, die diese Lesung hat und ${esc(readerLabel(other))} nicht; <del>rot</del>: Wörter von ${esc(readerLabel(other))}, die hier fehlen.`)}
        ${x != null ? T(` The two disagree on ${pct(x)} of the characters of this page — disagreement, not quality: neither is a reference.`,
          ` Die beiden weichen auf dieser Seite in ${pct(x)} der Zeichen voneinander ab – Abweichung, nicht Qualität: Keine der beiden ist eine Referenz.`) : ""}</p>`;
      body = diffHtml(page.readings[other].text, rd.text);
    } else if (mode === "ents") {
      body = entHtml(rd.text, page.ents[readerId]);
    } else body = esc(rd.text);
    return head + trunc + note + (mode === "ents" ? legend() : "") + lineNote(rd.ln, page) +
      `<div class="text ${mode === "ents" ? "ents" : ""}">${numberLines(body)}</div>`;
  }

  function numberLines(body) {
    return body.split("\n").map((l, i) => `<span class="line" data-i="${i}"><span class="ln">${i + 1}</span>${l}</span>`).join("");
  }

  /* ---------- lines on the image (docs/LINES.md) ----------
     Adapted from the St. Gallen viewer. build_site.py gives a page with
     Transkribus lines `rows` (each TextLine's outline: x, y, x, y, … in
     ten-thousandths of the image width, the unit of OpenSeadragon's overlays)
     and every reading `ln`: per line the rows it is linked to (empty where no
     link was good enough). Pointing at a line shows its row on the image,
     pointing at the image shows the line; a click (a tap) on a line also brings
     the image to it, a click on the image brings the text to the line. */
  function lineNote(ln, page) {
    if (!ln || !page.rows) return "";
    const lines = ln.length, linked = ln.filter((x) => x.length).length;
    return `<p class="line-note small muted">${T(`${linked} of ${lines} lines linked to the image: point at or tap a line, or the image.`,
      `${linked} von ${lines} Zeilen mit dem Bild verknüpft: auf eine Zeile oder ins Bild zeigen oder tippen.`)}</p>`;
  }
  function currentLn() {
    const v = state.view || {};
    if (!v.page || !v.page.rows) return null;
    const rd = v.page.readings[v.reader];
    return (rd && rd.ln) || null;
  }
  function rowBox(poly) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k + 1 < poly.length; k += 2) {
      x0 = Math.min(x0, poly[k]); x1 = Math.max(x1, poly[k]);
      y0 = Math.min(y0, poly[k + 1]); y1 = Math.max(y1, poly[k + 1]);
    }
    return [x0, y0, x1, y1];
  }
  const imageOpen = () => !!(state.osd && state.osd.world.getItemCount() && window.OpenSeadragon);
  let hlEls = [], pinned = false, pinUntil = 0;
  function clearRows() {
    hlEls.forEach((el) => state.osd && state.osd.removeOverlay(el));
    hlEls = [];
    pinned = false;
    app.querySelectorAll("#reading .line.hl").forEach((el) => el.classList.remove("hl"));
  }
  function showRows(rows) {
    const v = state.view || {};
    if (!imageOpen() || !v.page || !v.page.rows) return;
    for (const j of rows) {
      const poly = v.page.rows[j];
      if (!poly) continue;
      const [x0, y0, x1, y1] = rowBox(poly);
      const w = x1 - x0, h = y1 - y0;
      if (w <= 0 || h <= 0) continue;
      const el = document.createElement("div");
      el.className = "row-hl";
      const pts = [];
      for (let k = 0; k + 1 < poly.length; k += 2) pts.push(`${poly[k] - x0},${poly[k + 1] - y0}`);
      el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polygon points="${pts.join(" ")}"/></svg>`;
      state.osd.addOverlay({ element: el, location: new OpenSeadragon.Rect(x0 / 1e4, y0 / 1e4, w / 1e4, h / 1e4) });
      hlEls.push(el);
    }
  }
  function lineRows(line) {
    const ln = currentLn();
    return (line && ln && ln[+line.dataset.i]) || [];
  }
  /* after a click the line stays shown until another line is pointed at */
  function onLineHover(ev) {
    const line = ev.target.closest(".line[data-i]");
    if (line && line.classList.contains("hl")) return;
    // the page scrolling to the image after a click or a tap passes over other lines
    if (pinned && (!lineRows(line).length || performance.now() < pinUntil)) return;
    clearRows();
    const rows = lineRows(line);
    if (!rows.length) return;
    line.classList.add("hl");
    showRows(rows);
  }
  /* a click or a tap on a line: keep it shown and bring the image to it, gently
     (the line across most of the viewer, a few lines above and below) */
  function onLineClick(ev) {
    if (ev.target.closest(".ent, a, button")) return;
    const line = ev.target.closest(".line[data-i]");
    const rows = lineRows(line);
    if (!rows.length) return;
    clearRows();
    line.classList.add("hl");
    showRows(rows);
    pinned = true;
    pinUntil = performance.now() + 1500;
    if (!imageOpen()) return;
    const v = state.view, bs = rows.map((j) => rowBox(v.page.rows[j]));
    const x0 = Math.min(...bs.map((b) => b[0])), y0 = Math.min(...bs.map((b) => b[1]));
    const x1 = Math.max(...bs.map((b) => b[2])), y1 = Math.max(...bs.map((b) => b[3]));
    const w = Math.max(x1 - x0, 2500), h = y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const vw = w * 1.25, vh = Math.max(h * 5, vw * 0.25);
    state.osd.viewport.fitBoundsWithConstraints(new OpenSeadragon.Rect((cx - vw / 2) / 1e4, (cy - vh / 2) / 1e4, vw / 1e4, vh / 1e4));
    const img = document.getElementById("osd");
    if (img && stacked()) img.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  /* the image below the text (narrow screens): a click on the image does not
     scroll the text away from it, and a tap on a line brings the image up */
  function stacked() {
    const t = app.querySelector(".textpane"), i = app.querySelector(".imgpane");
    return !!(t && i && i.getBoundingClientRect().top >= t.getBoundingClientRect().bottom - 1);
  }
  function inPoly(x, y, p) {
    let inside = false;
    for (let a = 0, b = p.length - 2; a < p.length; b = a, a += 2) {
      if ((p[a + 1] > y) !== (p[b + 1] > y) && x < (p[b] - p[a]) * (y - p[a + 1]) / (p[b + 1] - p[a + 1]) + p[a]) inside = !inside;
    }
    return inside;
  }
  function rowAt(pt) {
    const v = state.view || {};
    if (!v.page || !v.page.rows) return -1;
    const x = pt.x * 1e4, y = pt.y * 1e4;
    let hit = -1, area = Infinity;
    v.page.rows.forEach((poly, j) => {
      const b = rowBox(poly);
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3] || !inPoly(x, y, poly)) return;
      const a = (b[2] - b[0]) * (b[3] - b[1]);
      if (a < area) { hit = j; area = a; }
    });
    return hit;
  }
  function linesOfRow(j) {
    const ln = currentLn();
    if (!ln || j < 0) return [];
    return [...app.querySelectorAll("#reading .line[data-i]")].filter((el) => (ln[+el.dataset.i] || []).includes(j));
  }
  function hlRow(j) {
    clearRows();
    const els = linesOfRow(j);
    if (!els.length) return [];
    els.forEach((el) => el.classList.add("hl"));
    showRows([j]);
    return els;
  }
  function trackImage(osd) {
    let last = -2;
    const tracker = new OpenSeadragon.MouseTracker({
      element: osd.canvas,
      moveHandler: (e) => {
        if (state.osd !== osd) return;
        const j = rowAt(osd.viewport.pointFromPixel(e.position));
        if (j === last) return;
        last = j;
        if (pinned && (performance.now() < pinUntil || !linesOfRow(j).length)) return;
        hlRow(j);
      },
      leaveHandler: () => { last = -2; if (!pinned) clearRows(); },
    });
    osd.addHandler("canvas-click", (e) => {
      if (!e.quick || state.osd !== osd) return;
      const j = rowAt(osd.viewport.pointFromPixel(e.position));
      last = j;
      const els = hlRow(j);
      pinned = els.length > 0;
      if (els.length && !stacked()) els[0].scrollIntoView({ block: "center", behavior: "smooth" });
    });
    osd.addHandler("destroy", () => tracker.destroy());
  }

  /* word diff: tokens of the reading against tokens of another reading (LCS) */
  function diffHtml(ref, hyp) {
    const tok = (s) => s.split(/(\s+)/).filter((t) => t !== "");
    const a = tok(ref).filter((t) => !/^\s+$/.test(t));
    const bAll = tok(hyp);
    const b = bAll.filter((t) => !/^\s+$/.test(t));
    const n = a.length, m = b.length;
    if (n * m > 4e6) return esc(hyp);
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const seps = []; { let k = -1; for (const t of bAll) { if (/^\s+$/.test(t)) { seps[k] = (seps[k] || "") + t; } else { k++; } } }
    let i = 0, j = 0, out = "", pendingDel = [];
    const flushDel = () => { if (pendingDel.length) { out += `<del>${esc(pendingDel.join(" "))}</del> `; pendingDel = []; } };
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { flushDel(); out += esc(b[j]) + (seps[j] ?? ""); i++; j++; }
      else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { flushDel(); out += `<ins>${esc(b[j])}</ins>` + (seps[j] ?? ""); j++; }
      else { pendingDel.push(a[i]); i++; }
    }
    flushDel();
    return out.replace(/ \n/g, "\n");
  }

  /* ---------- image (IIIF on files.transkribus.eu) ---------- */
  function destroyOsd() { if (state.osd) { state.osd.destroy(); state.osd = null; } delete app.dataset.tk; }
  function noImage(msg) {
    const el = document.getElementById("osd");
    if (el) el.innerHTML = `<p class="noimg">${msg}</p>`;
  }
  /* Transkribus' info.json lists `sizes`; with `sizes` OpenSeadragon 4.1 stops
     at a thumbnail (as on the St. Gallen IIIF server), so it is dropped. */
  async function openImage(page) {
    if (!page.tk) { noImage(T("No image for this page.", "Kein Bild zu dieser Seite.")); return; }
    if (!window.OpenSeadragon) { noImage(T("The image viewer did not load.", "Der Bildbetrachter wurde nicht geladen.")); return; }
    const base = IIIF + encodeURIComponent(page.tk);
    noImage(T("Loading the image from Transkribus…", "Das Bild wird von Transkribus geladen…"));
    let info = null;
    try { info = await json(`${base}/info.json`); } catch { info = null; }
    if (app.dataset.tk !== page.tk || !document.getElementById("osd")) return;
    if (!info) { noImage(T("The image could not be loaded from Transkribus.", "Das Bild konnte nicht von Transkribus geladen werden.")); return; }
    info["@id"] = base;
    delete info.sizes;
    document.getElementById("osd").innerHTML = "";
    state.osd = OpenSeadragon({
      id: "osd",
      prefixUrl: "https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/",
      tileSources: info,
      showNavigator: true, navigatorPosition: "BOTTOM_RIGHT",
      gestureSettingsMouse: { clickToZoom: false },
      crossOriginPolicy: "Anonymous",
    });
    trackImage(state.osd);
    const el = document.getElementById("imglink");
    if (el) el.innerHTML = `<a href="${esc(base)}/full/max/0/default.jpg" target="_blank" rel="noopener">${T("Full image", "Ganzes Bild")} ↗</a>`;
  }

  /* ---------- entities (hook: entities/<reader>.jsonl, none yet) ---------- */
  function hasEnts(page, reader) { return !!(page.ents && page.ents[reader] && page.ents[reader].length); }
  function legend() {
    return `<div class="legend"><span class="per"><i></i>${T("person", "Person")}</span><span class="org"><i></i>${T("organisation", "Organisation")}</span><span class="place"><i></i>${T("place", "Ort")}</span><span class="date"><i></i>${T("date", "Datum")}</span></div>`;
  }
  function entHtml(text, ents) {
    const sorted = [...ents].sort((a, b) => a.start - b.start);
    let out = "", at = 0;
    for (const e of sorted) {
      if (e.start < at) continue;
      out += esc(text.slice(at, e.start));
      const attrs = `class="ent ${esc(e.type)}" data-ref="${esc(e.ref || e.when || "")}" data-role="${esc(e.role || "")}" data-reg="${esc(e.reg || "")}"`;
      out += `<span ${attrs}>${text.slice(e.start, e.end).split("\n").map(esc).join(`</span>\n<span ${attrs}>`)}</span>`;
      at = e.end;
    }
    return out + esc(text.slice(at));
  }
  let tipEl = null;
  function hideTip() { if (tipEl) { tipEl.remove(); tipEl = null; } }
  document.addEventListener("click", (ev) => { if (tipEl && !tipEl.contains(ev.target) && !ev.target.closest(".ent")) hideTip(); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") hideTip(); });
  function entTip(ev) {
    const el = ev.target.closest(".ent");
    if (!el) return;
    const kind = [...el.classList].find((c) => ["per", "place", "org", "date"].includes(c));
    const kn = { per: T("Person", "Person"), place: T("Place", "Ort"), org: T("Organisation", "Organisation"), date: T("Date", "Datum") }[kind] || "";
    const ref = el.dataset.ref, reg = el.dataset.reg, re = reg && state.reg && state.reg.entries[reg];
    let body = `<b>${esc(kn)}${T(" · automatic", " · automatisch")}</b>`;
    if (reg) body += `<a href="#/entry/${encodeURIComponent(reg)}">${T("Register", "Register")}: ${esc(re ? re.n : reg)}</a>${re && re.c && re.c[0] ? `<div class="muted">${esc(re.c[0].label)}? (${esc(GRADE()[re.c[0].grade])})</div>` : ""}`;
    else if (kind === "date") body += ref ? esc(ref) : "";
    else body += `<span class="muted">${T("not in the register", "nicht im Register")}</span>`;
    if (ref && kind !== "date" && !/^https?:/.test(ref)) body += `<div class="muted small">${T("tagger's St. Gallen link", "St. Galler Link der Auszeichnung")}: ${esc(ref)}</div>`;
    if (el.dataset.role) body += `<div class="muted">${T("role", "Rolle")}: ${esc(el.dataset.role)}</div>`;
    hideTip();
    tipEl = document.createElement("div");
    tipEl.className = "tip";
    tipEl.innerHTML = body;
    document.body.appendChild(tipEl);
    const r = el.getBoundingClientRect();
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    tipEl.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left)) + "px";
    tipEl.style.top = (r.bottom + 6 + h > window.innerHeight ? r.top - h - 6 : r.bottom + 6) + "px";
  }

  boot().catch((err) => { app.innerHTML = `<p>${T("Could not load the data", "Die Daten konnten nicht geladen werden")}: ${esc(err.message)}</p>`; });
})();
