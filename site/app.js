/* Thun Missives — readings viewer. No build step, no framework.
   Forked from the St. Gallen Missives viewer (DHBern/sg-missiven-data): no
   edition, no scores, no registers. The unit is the letter (readings/letters.tsv,
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
    const nav = { letters: T("Letters", "Briefe"), search: T("Search", "Suche"), readers: T("Readers", "Leser"), about: T("About", "Über") };
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
    const how = HOW[dt.how] ? T(...HOW[dt.how]) : (dt.how || "");
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
    const row = ([k, c]) => `<a class="kwrow" href="#/search?kw=${encodeURIComponent(k)}"><span class="kl" lang="de">${esc(k)}</span><span class="kb"><i style="width:${(c / max) * 100}%"></i></span><span class="kn">${num(c)}</span></a>`;
    const TOP = 40;
    return `<section class="overview kwov" aria-labelledby="kw-h">
      <h2 id="kw-h">${T("Keywords", "Schlagwörter")}</h2>
      <p class="small muted">${T(`${num(withKw)} of ${num(ls.length)} letters have keywords, ${num(terms.length)} different terms. A language model assigned them from the machine-drafted regests, choosing from the ${num(voc.terms)} keywords of the St. Gallen Missives edition; unchecked. Click a keyword to search its letters.`,
        `${num(withKw)} von ${num(ls.length)} Briefen haben Schlagwörter, ${num(terms.length)} verschiedene. Ein Sprachmodell hat sie aus den maschinell entworfenen Regesten vergeben, gewählt aus den ${num(voc.terms)} Schlagwörtern der Edition der St. Galler Missiven; ungeprüft. Ein Klick auf ein Schlagwort sucht seine Briefe.`)}</p>
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
    const [path, qs] = location.hash.replace(/^#\/?/, "").split("?");
    const parts = path.split("/").map(decodeURIComponent);
    if (parts[0] !== "letter") { destroyOsd(); cur = null; }
    if (parts[0] === "search") return showSearch(new URLSearchParams(qs || ""));
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
          There is no edition: nothing here is a checked transcription, and no reading is scored.`,
          `Briefe an die Stadt Thun aus dem 15. und 16. Jahrhundert, viele von Schultheiss und Rat von Bern, im Burgerarchiv Thun:
          ${num(letters.length)} Briefe auf ${num(state.index.pages)} Seiten, jede Seite mit ihrem Bild und ${machineReaders()}.
          Es gibt keine Edition: Nichts hier ist eine geprüfte Transkription, und keine Lesung wird bewertet.`)}</p>
        <p class="small muted">${DIGI()} ${T("The letters were told apart by the file names of the scans, which carry the shelfmark and number.",
          "Die Briefe sind nach den Dateinamen der Aufnahmen getrennt, die Signatur und Nummer tragen.")}
          ${drafted ? T(`${num(drafted)} letters have a heading and regest drafted by a language model: machine drafts, unchecked.`,
            `${num(drafted)} Briefe haben eine von einem Sprachmodell entworfene Überschrift und ein Regest: Maschinenentwürfe, ungeprüft.`) : ""}</p>
      </section>
      <div class="ovgrid">${timelineHtml()}${keywordsHtml()}</div>
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
    const names = state.readers.map((r) => esc(loc(r, "label")));
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
        <li><b>St. Gallen.</b> Zwischen den Thuner und den <a href="https://dhbern.github.io/sg-missiven-data/" target="_blank" rel="noopener">St. Galler Missiven</a> wurde kein gleicher Brief und keine Antwort gefunden (Vergleich vom 15.11.2026). Wo zwei Briefe dasselbe Ereignis betreffen, steht ein Hinweis beim Brief. In St. Gallen liegt ein Brief aus Thun von 1632 (<a href="https://dhbern.github.io/sg-missiven-data/#/letter/stasg_missiv_unedited_02887/1" target="_blank" rel="noopener">Nr. 2887</a>), später als die Thuner Briefe hier.</li>
        <li><b>Keine Edition, keine Ground Truth.</b> Keine Seite ist von Menschen transkribiert oder geprüft. Die erste Lesung ist die automatische Lesung in Transkribus (PyLaia, Modell «Medieval_Scripts_M2.4»), unkorrigiert.</li>
        <li><b>Überschriften und Regesten sind Maschinenentwürfe.</b> Ein offenes Sprachmodell (Qwen3.8-27B auf dem GPUStack der Universität Bern) entwirft sie aus der besten vorhandenen Lesung eines Briefs, mit Briefen der St. Galler Edition als Stilvorlagen. Niemand hat sie geprüft; Namen und Daten können falsch sein. Briefe ohne Entwurf zeigen keinen.</li>
        <li><b>Lesungen vergleichen</b>: Wo eine Seite mehrere Lesungen hat, zeigt «Vergleichen mit …» Wort für Wort, was die eine Lesung hat und die andere nicht. Die Prozentzahl ist <i>Abweichung, nie Qualität</i>.</li>
        <li><b>Suche</b> im Text einer Lesung, Brief für Brief, mit «Schreibvarianten zulassen» (u/v/w, i/y/j, ſ/s, Doppelbuchstaben, ů/uo/u, ä/ae/a, Worttrennung am Zeilenende) und Facetten nach Signatur, Jahrzehnt und Jahr, Schlagwort, Absender, Empfänger und Regest.</li>
        <li><b>Daten.</b> Jahr und Tag jedes Briefs sind nach Regeln aus der Datumszeile gelesen, die der Regestentwurf aus einer maschinellen Lesung zitiert (<code>scripts/dates.py</code>). Ein aus einem Fest berechneter Tag ist julianisch; wo vom Jahr nur die letzten Ziffern geschrieben sind, stammt das Jahrhundert von den benachbarten datierten Briefen und ist unsicher. Schlagwörter vergibt ein Sprachmodell aus den Regestentwürfen, gewählt aus dem Vokabular der St. Galler Edition; ungeprüft.</li>
      </ul>
      <h2>Geplant</h2>
      <p>Weitere Leser: Gemini 4 Argon, Gemini 3.8 Flash, ein feinjustiertes Qwen3.5-4B (Kurrent, ganze Seiten), kraken und TrOCR; Regestentwürfe für alle Briefe. Danach die automatische Auszeichnung von Personen, Orten und Daten (NER) und ihre Verknüpfung mit Normdaten.</p>
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
        <li><b>St. Gallen.</b> No letter was found in both the Thun and the <a href="https://dhbern.github.io/sg-missiven-data/" target="_blank" rel="noopener">St. Gallen Missives</a>, and none that answers one in the other (compared 15.11.2026). Where two letters concern the same event, a hint stands with the letter. St. Gallen holds a letter from Thun of 1632 (<a href="https://dhbern.github.io/sg-missiven-data/#/letter/stasg_missiv_unedited_02887/1" target="_blank" rel="noopener">no. 2887</a>), later than the Thun letters here.</li>
        <li><b>No edition, no ground truth.</b> No page has been transcribed or checked by a person. The first reading is the automatic one in Transkribus (PyLaia, model "Medieval_Scripts_M2.4"), uncorrected.</li>
        <li><b>Headings and regests are machine drafts.</b> An open language model (Qwen3.8-27B on the University of Bern's GPUStack) drafts them from the best reading a letter has, with letters of the St. Gallen edition as style examples. Nobody has checked them; names and dates may be wrong. Letters without a draft show none.</li>
        <li><b>Compare readings</b>: where a page has more than one reading, "Compare with …" marks word by word what one reading has and the other lacks. The percentage is <i>disagreement, never quality</i>.</li>
        <li><b>Search</b> in the text of one reading, letter by letter, with "tolerant spelling" (u/v/w, i/y/j, ſ/s, doubled letters, ů/uo/u, ä/ae/a, words broken at the line end) and facets for shelfmark, decade and year, keyword, sender, recipient and regest.</li>
        <li><b>Dates.</b> Each letter's year and day are read by rule from the date line that the regest draft quotes from a machine reading (<code>scripts/dates.py</code>). A day computed from a feast is Julian; where only the last digits of the year are written, the century comes from the neighbouring dated letters and is uncertain. Keywords are assigned by a language model from the regest drafts, chosen from the St. Gallen edition's vocabulary; unchecked.</li>
      </ul>
      <h2>Planned</h2>
      <p>More readers: Gemini 4 Argon, Gemini 3.8 Flash, a fine-tuned Qwen3.5-4B (Kurrent, whole pages), kraken and TrOCR; regest drafts for every letter. Then automatic tagging of persons, places and dates (NER) and linking them to authority files.</p>
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
    { k: "snd", en: "Sender (draft)", de: "Absender (Entwurf)" },
    { k: "rcp", en: "Recipient (draft)", de: "Empfänger (Entwurf)" },
    { k: "dr", en: "Regest", de: "Regest" },
  ];
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
    if (k === "snd") return one(l.s);
    if (k === "rcp") return one(l.r);
    if (k === "dr") return [l.h ? "yes" : "no"];
    return [];
  }
  function facetLabel(k, v) {
    if (k === "sh") return "BAT " + v;
    if (k === "dec") return T(`${v}s`, `${v}er`);
    if (k === "dr") return v === "yes" ? T("Machine draft", "Maschinenentwurf") : T("None yet", "noch keines");
    return v;
  }

  async function showSearch(params) {
    setNav("search");
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
      const passes = (h, except) => FACETS.every((f) => f.k === except || !sel[f.k].size || facetValues(h.l, f.k).some((v) => sel[f.k].has(v)));
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
        for (const h of base) if (passes(h, f.k)) for (const v of facetValues(h.l, f.k)) counts.set(v, (counts.get(v) || 0) + 1);
        for (const v of sel[f.k]) if (!counts.has(v)) counts.set(v, 0);
        const vals = sortVals(f.k, counts);
        if (!vals.length) return "";
        const ff = (ui.ff[f.k] || "").toLowerCase();
        /* the year list is long: open once a decade or a year is chosen */
        const open = f.k !== "yr" || sel.yr.size || sel.dec.size;
        return `<details class="facet" ${open ? "open" : ""} data-k="${f.k}"><summary>${T(f.en, f.de)}${sel[f.k].size ? ` <span class="badge">${sel[f.k].size}</span>` : ""} <span class="muted small">${vals.length}</span></summary>
          ${vals.length > 12 ? `<input class="ffilter" type="search" data-ff="${f.k}" value="${esc(ui.ff[f.k] || "")}" placeholder="${T("Filter…", "Filtern…")}" aria-label="${T("Filter", "Filtern")} ${T(f.en, f.de)}">` : ""}
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
      const attrs = `class="ent ${esc(e.type)}" data-ref="${esc(e.ref || e.when || "")}" data-role="${esc(e.role || "")}"`;
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
    const ref = el.dataset.ref;
    let body = `<b>${esc(kn)}${T(" · automatic", " · automatisch")}</b>`;
    body += ref ? (/^https?:/.test(ref) ? `<a href="${esc(ref)}" target="_blank" rel="noopener">${esc(ref)}</a>` : esc(ref)) : `<span class="muted">${T("not linked", "nicht verknüpft")}</span>`;
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
