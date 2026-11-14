/* Thun Missives — readings viewer. No build step, no framework.
   Forked from the St. Gallen Missives viewer (DHBern/sg-missiven-data) and cut
   down: no edition, no scores, no registers, no images. The unit is the page,
   grouped by Transkribus document in shelfmark order. */
(() => {
  "use strict";
  const app = document.getElementById("app");
  const state = { index: null, readers: null, chunks: new Map(), filter: "" };
  const store = {
    get(k, d) { try { const v = localStorage.getItem("thm:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("thm:" + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  state.reader = store.get("reader", "");
  state.mode = store.get("mode", "plain");

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
    const nav = { docs: T("Documents", "Dokumente"), search: T("Search", "Suche"), readers: T("Readers", "Leser"), about: T("About", "Über") };
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
    route();
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (x) => (x == null ? "–" : (x * 100).toFixed(1).replace(".", LANG === "de" ? "," : ".") + " %");
  const json = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(p + ": " + r.status); return r.json(); });
  const docById = (id) => state.index.docs.find((d) => d.id === id);
  /* "BAT 663.1, Nr. 350–399" */
  const docLabel = (d) => `BAT ${d.shelf}${d.range ? `, ${T("no.", "Nr.")} ${d.range}` : ""}`;
  const readerLabel = (id) => { const r = state.readers.find((x) => x.id === id); return r ? loc(r, "label") : id; };

  async function boot() {
    [state.index, state.readers] = await Promise.all([json("data/index.json"), json("data/readers.json")]);
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
    if (parts[0] === "search") return showSearch(new URLSearchParams(qs || ""));
    if (parts[0] === "doc" && parts[1]) return showPage(parts[1], +(parts[2] || 0), parts[3]);
    if (parts[0] === "readers") return showReaders();
    if (parts[0] === "about") return showAbout();
    return showList();
  }

  /* ---------- documents ---------- */
  function noImages() {
    return T(`No page images are shown: the rights of the Burgerarchiv Thun to publish them are not cleared. Only the machines' text is public.`,
      `Seitenbilder werden nicht gezeigt: Die Rechte des Burgerarchivs Thun an ihrer Veröffentlichung sind nicht geklärt. Öffentlich ist nur der Text der Maschinen.`);
  }

  function showList() {
    setNav("docs");
    const docs = state.index.docs;
    const shelves = [...new Set(docs.map((d) => d.shelf))];
    app.innerHTML = `
      <section class="intro">
        <h1>${T("The Thun Missives, read by machines", "Die Thuner Missiven, von Maschinen gelesen")}</h1>
        <p>${T(`Letters received by the town of Thun in the 15th and 16th centuries, many from the Schultheiss and council of Bern,
          kept in the Burgerarchiv Thun: ${num(state.index.pages)} pages in ${docs.length} volumes and bundles. Every page is shown with ${machineReaders()}.
          There is no edition: nothing here is a checked transcription, and no reading is scored.`,
          `Briefe an die Stadt Thun aus dem 15. und 16. Jahrhundert, viele von Schultheiss und Rat von Bern, im Burgerarchiv Thun:
          ${num(state.index.pages)} Seiten in ${docs.length} Bänden und Faszikeln. Jede Seite erscheint mit ${machineReaders()}.
          Es gibt keine Edition: Nichts hier ist eine geprüfte Transkription, und keine Lesung wird bewertet.`)}</p>
        <p class="caveat">${noImages()} ${T("Where a page begins or ends a letter is not known; the unit is the page.", "Wo ein Brief beginnt oder endet, ist nicht bekannt; die Einheit ist die Seite.")}</p>
      </section>
      <div class="filters">
        <input id="q" type="search" placeholder="${T("Filter by shelfmark or number…", "Nach Signatur oder Nummer filtern…")}" value="${esc(state.filter)}" aria-label="${T("Filter documents", "Dokumente filtern")}">
        <span id="count" class="muted small"></span>
        <a class="small" href="#/search">${T("Search the text →", "Im Text suchen →")}</a>
      </div>
      <div id="list"></div>`;
    const q = document.getElementById("q");
    const draw = () => {
      state.filter = q.value;
      const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
      const rows = docs.filter((d) => words.every((w) => [d.id, docLabel(d)].join(" ").toLowerCase().includes(w)));
      document.getElementById("count").textContent = `${rows.length} ${P(rows.length, "document", "documents", "Dokument", "Dokumente")}, ${num(rows.reduce((s, d) => s + d.pages.length, 0))} ${T("pages", "Seiten")}`;
      document.getElementById("list").innerHTML = shelves.map((s) => {
        const ds = rows.filter((d) => d.shelf === s);
        if (!ds.length) return "";
        return `<h2 class="shelf">BAT ${esc(s)}</h2><div class="list">${ds.map((d) => `
          <a class="row doc" href="#/doc/${encodeURIComponent(d.id)}/${d.pages[0]}">
            <span class="num">${d.range ? esc(d.range) : "–"}</span>
            <span class="date">${num(d.pages.length)} ${P(d.pages.length, "page", "pages", "Seite", "Seiten")}</span>
            <span><span class="who">${esc(docLabel(d))}</span>
            <span class="reg">${esc(d.id)} · ${state.readers.map((r) => `${esc(loc(r, "label"))}: ${num(d.read[r.id] || 0)}`).join(" · ")}</span></span>
          </a>`).join("")}</div>`;
      }).join("") || `<p class="empty">${T("No document matches.", "Kein Dokument passt.")}</p>`;
    };
    q.addEventListener("input", draw);
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
      <h2>Was zu sehen ist – und was nicht</h2>
      <ul>
        <li><b>Nur Text, keine Bilder.</b> Die Rechte des Burgerarchivs Thun an der Veröffentlichung der Seitenbilder sind nicht geklärt; die Bilder werden darum weder gezeigt noch weitergegeben. Veröffentlicht sind allein die maschinellen Lesungen.</li>
        <li><b>Keine Edition, keine Ground Truth.</b> Keine Seite ist von Menschen transkribiert oder geprüft. Die erste Lesung ist die automatische Lesung in Transkribus (PyLaia, Modell «Medieval_Scripts_M2.4»), unkorrigiert.</li>
        <li><b>Die Einheit ist die Seite.</b> Wo ein Brief beginnt oder endet, ist noch nicht bestimmt. Die Seiten stehen nach Dokument in Signaturfolge.</li>
        <li><b>Lesungen vergleichen</b>: Wo eine Seite mehrere Lesungen hat, zeigt «Vergleichen mit …» Wort für Wort, was die eine Lesung hat und die andere nicht. Die Prozentzahl ist <i>Abweichung, nie Qualität</i>.</li>
        <li><b>Suche</b> im Text einer Lesung, mit «Schreibvarianten zulassen» (u/v/w, i/y/j, ſ/s, Doppelbuchstaben, ů/uo/u, ä/ae/a, Worttrennung am Zeilenende).</li>
      </ul>
      <h2>Geplant</h2>
      <p>Weitere Leser: Gemini 4 Argon, Gemini 3.8 Flash, ein feinjustiertes Qwen3.5-4B (Kurrent, ganze Seiten), kraken und TrOCR. Danach die automatische Auszeichnung von Personen, Orten und Daten (NER) und ihre Verknüpfung mit Normdaten.</p>
      <h2>Daten und Code</h2>
      <p><a href="https://github.com/DHBern/thun-missiven-data" target="_blank" rel="noopener">github.com/DHBern/thun-missiven-data</a> – die Lesungen liegen in <code>readings/</code>, eine JSON-Zeile pro Seite und Leser. Der Viewer ist aus dem der <a href="https://dhbern.github.io/sg-missiven-data/" target="_blank" rel="noopener">St. Galler Missiven</a> abgeleitet.</p>
    </section>` : `<section class="prose">
      <h1>About</h1>
      <p>A demonstration by <a href="https://www.dh.unibe.ch/" target="_blank" rel="noopener">Digital Humanities, University of Bern</a>,
      on the Thun Missives: letters received by the town of Thun in the 15th and 16th centuries, many from the Schultheiss and council of Bern, kept in the Burgerarchiv Thun (BAT).
      The pages are in Transkribus collection 2329424 ("BAT Thuner Missiven neu"), 36 documents by shelfmark (663 to 666.1) and letter numbers.</p>
      <h2>What you see — and what you don't</h2>
      <ul>
        <li><b>Text only, no images.</b> The rights of the Burgerarchiv Thun to publish the page images are not cleared, so the images are neither shown nor passed on. Only the machine readings are published.</li>
        <li><b>No edition, no ground truth.</b> No page has been transcribed or checked by a person. The first reading is the automatic one in Transkribus (PyLaia, model "Medieval_Scripts_M2.4"), uncorrected.</li>
        <li><b>The unit is the page.</b> Where a letter begins or ends has not been determined yet. Pages are listed by document in shelfmark order.</li>
        <li><b>Compare readings</b>: where a page has more than one reading, "Compare with …" marks word by word what one reading has and the other lacks. The percentage is <i>disagreement, never quality</i>.</li>
        <li><b>Search</b> in the text of one reading, with "tolerant spelling" (u/v/w, i/y/j, ſ/s, doubled letters, ů/uo/u, ä/ae/a, words broken at the line end).</li>
      </ul>
      <h2>Planned</h2>
      <p>More readers: Gemini 4 Argon, Gemini 3.8 Flash, a fine-tuned Qwen3.5-4B (Kurrent, whole pages), kraken and TrOCR. Then automatic tagging of persons, places and dates (NER) and linking them to authority files.</p>
      <h2>Data and code</h2>
      <p><a href="https://github.com/DHBern/thun-missiven-data" target="_blank" rel="noopener">github.com/DHBern/thun-missiven-data</a> — the readings are in <code>readings/</code>, one JSON line per page and reader. The viewer is derived from the <a href="https://dhbern.github.io/sg-missiven-data/" target="_blank" rel="noopener">St. Gallen Missives</a> viewer.</p>
    </section>`;
  }

  /* ---------- search ---------- */
  /* Full text over the pages of one reader. The text is sharded per reader
     (site/data/search/<reader>/text-N.json) and loaded, in parallel, only once
     a query is typed. The whole search lives in the URL. */
  const FACETS = [
    { k: "sh", en: "Shelfmark", de: "Signatur" },
    { k: "doc", en: "Document", de: "Dokument" },
  ];
  const texts = new Map();   // reader -> Promise<{key: text}>
  let searchTimer = null;
  const docOfKey = (k) => k.replace(/_p\d+$/, "");
  const pageOfKey = (k) => +(/_p(\d+)$/.exec(k) || [0, 0])[1];

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

  async function showSearch(params) {
    setNav("search");
    const readers = state.readers.filter((r) => state.index.search[r.id]);
    const ui = { q: params.get("q") || "", tol: params.get("tol") !== "0", shown: 50,
                 reader: readers.some((r) => r.id === params.get("r")) ? params.get("r") : (readers.some((r) => r.id === state.reader) ? state.reader : (readers[0] || {}).id) };
    const sel = Object.fromEntries(FACETS.map((f) => [f.k, new Set(params.getAll(f.k))]));
    app.innerHTML = `
      <section class="intro">
        <h1>${T("Search", "Suche")}</h1>
        <p>${T(`The text of every page as one machine read it. These are uncorrected readings: a word the machine misread is not found under its right spelling, so try variants, or let the search tolerate spelling variants.`,
              `Der Text jeder Seite, wie eine Maschine ihn gelesen hat. Die Lesungen sind unkorrigiert: Ein falsch gelesenes Wort wird unter seiner richtigen Schreibung nicht gefunden; Varianten versuchen oder Schreibvarianten zulassen.`)}</p>
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
    const facetValue = (key, k) => (k === "doc" ? docOfKey(key) : (docById(docOfKey(key)) || {}).shelf || "");
    const facetLabel = (k, v) => (k === "doc" ? (docById(v) ? docLabel(docById(v)) : v) : "BAT " + v);
    const order = new Map(state.index.docs.map((d, i) => [d.id, i]));

    const run = async () => {
      toUrl();
      const terms = parseQuery(ui.q, ui.tol);
      if (!terms.length || !ui.reader) {
        $("facets").innerHTML = "";
        $("scount").textContent = "";
        $("sres").innerHTML = `<p class="empty">${readers.length ? T("Type a word to search.", "Ein Wort eingeben, um zu suchen.") : T("No reading to search yet.", "Noch keine Lesung zum Durchsuchen.")}</p>`;
        return;
      }
      $("scount").textContent = T("Loading the texts…", "Die Texte werden geladen…");
      const all = await searchTexts(ui.reader);
      const base = [];
      for (const [key, text] of Object.entries(all)) {
        const t = normText(text, ui.tol).s;
        if (terms.every((x) => t.includes(x))) base.push({ key, text });
      }
      base.sort((a, b) => order.get(docOfKey(a.key)) - order.get(docOfKey(b.key)) || pageOfKey(a.key) - pageOfKey(b.key));
      const passes = (h, except) => FACETS.every((f) => f.k === except || !sel[f.k].size || sel[f.k].has(facetValue(h.key, f.k)));
      const rows = base.filter((h) => passes(h, null));
      const nSel = FACETS.reduce((n, f) => n + sel[f.k].size, 0);
      $("fsel").textContent = nSel ? `(${nSel} ${T("selected", "gewählt")})` : "";
      $("facets").innerHTML = FACETS.map((f) => {
        const counts = new Map();
        for (const h of base) if (passes(h, f.k)) { const v = facetValue(h.key, f.k); counts.set(v, (counts.get(v) || 0) + 1); }
        for (const v of sel[f.k]) if (!counts.has(v)) counts.set(v, 0);
        const vals = [...counts.entries()].sort((a, b) => (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0) || a[0].localeCompare(b[0], "de", { numeric: true }));
        if (!vals.length) return "";
        return `<details class="facet" open data-k="${f.k}"><summary>${T(f.en, f.de)}${sel[f.k].size ? ` <span class="badge">${sel[f.k].size}</span>` : ""} <span class="muted small">${vals.length}</span></summary>
          <ul>${vals.map(([v, n]) => `<li><label class="${n ? "" : "zero"}"><input type="checkbox" data-k="${f.k}" value="${esc(v)}" ${sel[f.k].has(v) ? "checked" : ""}>
            <span class="fl">${esc(facetLabel(f.k, v))}</span><span class="fc">${n}</span></label></li>`).join("")}</ul></details>`;
      }).join("");
      $("scount").innerHTML = `${num(rows.length)} ${P(rows.length, "page", "pages", "Seite", "Seiten")}${T(" with ", " mit ")}` +
        (ui.q.match(/"[^"]+"|\S+/g) || []).map((t) => `<b>${esc(t)}</b>`).join(" + ") + ` · ${esc(readerLabel(ui.reader))}`;
      const draw = () => {
        $("sres").innerHTML = rows.slice(0, ui.shown).map((h) => {
          const d = docById(docOfKey(h.key)) || { shelf: "", range: "", id: docOfKey(h.key) };
          const p = pageOfKey(h.key);
          const href = `#/doc/${encodeURIComponent(d.id)}/${p}/${encodeURIComponent(ui.reader)}`;
          return `<div class="row srow">
            <span class="num"><a href="${href}">${T("p.", "S.")} ${p}</a></span>
            <span class="date small">${esc(d.id)}</span>
            <span><a class="who" href="${href}">${esc(docLabel(d))}, ${T("page", "Seite")} ${p}</a>
            <a class="hit" href="${href}">${snippet(h.text, terms, ui.tol)}</a></span></div>`;
        }).join("") + (rows.length > ui.shown ? `<button type="button" class="linkish" id="smore">${T(`Show ${Math.min(50, rows.length - ui.shown)} more of ${rows.length - ui.shown}`, `${Math.min(50, rows.length - ui.shown)} weitere von ${rows.length - ui.shown} zeigen`)}</button>` : "")
          + (!rows.length ? `<p class="empty">${T("No page matches. Remove a facet or a word, or allow spelling variants.", "Keine Seite passt. Eine Facette oder ein Wort entfernen oder Schreibvarianten zulassen.")}</p>` : "");
        const more = $("smore");
        more && more.addEventListener("click", () => { ui.shown += 50; draw(); });
      };
      draw();
    };

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
    await run();
  }

  /* ---------- page ---------- */
  async function getPage(doc, pageNr) {
    const i = doc.pages.indexOf(pageNr);
    const c = Math.floor(i / state.index.chunk);
    const k = `${doc.id}/${c}`;
    if (!state.chunks.has(k)) state.chunks.set(k, json(`data/pages/${encodeURIComponent(doc.id)}/${c}.json`));
    return (await state.chunks.get(k))[String(pageNr)];
  }

  let cur = null;   // the page on screen, for the arrow keys
  function pageKeys(ev) {
    if (!cur || ev.target.closest("input, select, textarea") || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const to = ev.key === "ArrowLeft" ? cur.prev : ev.key === "ArrowRight" ? cur.next : null;
    if (to) { location.hash = to; ev.preventDefault(); }
  }

  async function showPage(docId, pageNr, readerId) {
    setNav("docs");
    cur = null;
    const doc = docById(docId);
    if (!doc) { app.innerHTML = `<p>${T("No document", "Kein Dokument")} ${esc(docId)}. <a href="#/">${T("All documents", "Alle Dokumente")}</a></p>`; return; }
    if (!doc.pages.includes(pageNr)) pageNr = doc.pages[0];
    const page = await getPage(doc, pageNr);
    if (readerId && state.readers.some((r) => r.id === readerId)) { state.reader = readerId; store.set("reader", readerId); }
    let reader = state.reader;
    if (!page.readings[reader]) {
      const first = state.readers.find((x) => page.readings[x.id]);
      if (first) reader = first.id;
    }

    const di = state.index.docs.indexOf(doc);
    const pi = doc.pages.indexOf(pageNr);
    const prevDoc = state.index.docs[di - 1], nextDoc = state.index.docs[di + 1];
    const href = (d, p) => `#/doc/${encodeURIComponent(d.id)}/${p}`;
    const prev = pi > 0 ? href(doc, doc.pages[pi - 1]) : prevDoc ? href(prevDoc, prevDoc.pages[prevDoc.pages.length - 1]) : null;
    const next = pi < doc.pages.length - 1 ? href(doc, doc.pages[pi + 1]) : nextDoc ? href(nextDoc, nextDoc.pages[0]) : null;
    cur = { prev, next };

    app.innerHTML = `
      <div class="pageview">
        <section class="pane textpane">
          <div class="lnav">
            ${prevDoc ? `<a href="${href(prevDoc, prevDoc.pages[0])}">← ${esc(docLabel(prevDoc))}</a>` : "<span></span>"}
            <a href="#/">${T("All documents", "Alle Dokumente")}</a>
            ${nextDoc ? `<a href="${href(nextDoc, nextDoc.pages[0])}">${esc(docLabel(nextDoc))} →</a>` : "<span></span>"}
          </div>
          <div class="muted small">${esc(doc.id)} · ${esc(page.key)}</div>
          <h1>${esc(docLabel(doc))} · ${T("page", "Seite")} ${pageNr}</h1>
          <div class="pager">
            ${prev ? `<a class="pg" href="${prev}" aria-label="${T("Previous page", "Vorherige Seite")}">←</a>` : `<span class="pg off">←</span>`}
            <label class="small">${T("Page", "Seite")} <select id="pgsel" aria-label="${T("Go to page", "Zu Seite")}">${doc.pages.map((p) => `<option value="${p}" ${p === pageNr ? "selected" : ""}>${p}</option>`).join("")}</select> ${T("of", "von")} ${doc.pages.length}</label>
            ${next ? `<a class="pg" href="${next}" aria-label="${T("Next page", "Nächste Seite")}">→</a>` : `<span class="pg off">→</span>`}
            <span class="muted small">${T("arrow keys ← → turn the page", "Pfeiltasten ← → blättern")}</span>
          </div>
          <p class="noimg-note small">${noImages()}</p>
          <div class="readers" role="tablist" aria-label="${T("Readings", "Lesungen")}">${readerButtons(page, reader)}</div>
          ${modeSelect(page, reader)}
          <div id="reading">${readingHtml(page, reader)}</div>
        </section>
      </div>
      <footer class="foot">${T("Burgerarchiv Thun · machine readings, uncorrected · DH Bern", "Burgerarchiv Thun · maschinelle Lesungen, unkorrigiert · DH Bern")}</footer>`;

    app.querySelectorAll(".rd").forEach((b) => b.addEventListener("click", () => {
      if (b.disabled) return;
      location.hash = `#/doc/${encodeURIComponent(doc.id)}/${pageNr}/${encodeURIComponent(b.dataset.reader)}`;
    }));
    document.getElementById("pgsel").addEventListener("change", (ev) => { location.hash = href(doc, +ev.target.value); });
    const m = document.getElementById("t-mode");
    m && m.addEventListener("change", () => { state.mode = m.value; store.set("mode", m.value); route(); });
    const rd = document.getElementById("reading");
    rd.addEventListener("mouseover", entTip);
    rd.addEventListener("click", entTip);
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
    return head + trunc + note + (mode === "ents" ? legend() : "") + `<div class="text ${mode === "ents" ? "ents" : ""}">${numberLines(body)}</div>`;
  }

  function numberLines(body) {
    return body.split("\n").map((l, i) => `<span class="line"><span class="ln">${i + 1}</span>${l}</span>`).join("");
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
