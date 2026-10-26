/* MVM Gázkeret Lovelace kártya – automatikusan betöltődik az integrációval. */
const GK_VERSION = "1.0.0";

const fmt = (v, d = 1) =>
  v === null || v === undefined || isNaN(v)
    ? "–"
    : Number(v).toLocaleString("hu-HU", { minimumFractionDigits: d, maximumFractionDigits: d });
const ft = (v) => (v === null || v === undefined ? "–" : Math.round(v).toLocaleString("hu-HU") + " Ft");
const HU_M = ["jan.", "feb.", "márc.", "ápr.", "máj.", "jún.", "júl.", "aug.", "szept.", "okt.", "nov.", "dec."];
const dshort = (iso) => {
  if (!iso) return "–";
  const [, m, d] = iso.split("-").map(Number);
  return `${HU_M[m - 1]} ${d}.`;
};
const hrs = (h) => {
  if (h === null || h === undefined) return "–";
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return hh >= 100 ? `${fmt(h, 0)} ó` : `${hh} ó ${mm} p`;
};

const STATUS = {
  boost: { color: "#2e9e5b", icon: "mdi:fire", label: "Rásegíthetsz gázzal" },
  ok: { color: "#2b7de9", icon: "mdi:check-circle", label: "Jó ütemben" },
  warn: { color: "#e3a008", icon: "mdi:alert", label: "Közel a kerethez" },
  over_expected: { color: "#e8590c", icon: "mdi:alert-octagon", label: "Túllépés várható" },
  over: { color: "#d63939", icon: "mdi:fire-alert", label: "Keret túllépve" },
};

class GazkeretCard extends HTMLElement {
  constructor() {
    super();
    this._tab = "napi";
    this._sig = "";
    this.attachShadow({ mode: "open" });
  }

  static getStubConfig(hass) {
    const e = Object.keys(hass.states).find(
      (k) => k.startsWith("sensor.") && hass.states[k].attributes.p_quota !== undefined && hass.states[k].attributes.controls
    );
    return { entity: e || "sensor.mvm_gazkeret_allapot" };
  }

  static getConfigElement() {
    return document.createElement("gazkeret-card-editor");
  }

  setConfig(config) {
    this._config = { title: "Gázkeret", ...config };
  }

  getCardSize() {
    return 9;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6 };
  }

  set hass(hass) {
    this._hass = hass;
    const id = this._entityId();
    const st = id ? hass.states[id] : undefined;
    const ctrl = st?.attributes?.controls || {};
    const sig =
      (st ? st.last_updated : "none") +
      this._tab +
      Object.values(ctrl)
        .map((e) => (e && hass.states[e] ? hass.states[e].state : ""))
        .join("|");
    if (sig === this._sig) return;
    this._sig = sig;
    this._render(st);
  }

  _entityId() {
    if (this._config?.entity && this._hass.states[this._config.entity]) return this._config.entity;
    return Object.keys(this._hass.states).find(
      (k) => k.startsWith("sensor.") && this._hass.states[k].attributes.p_quota !== undefined && this._hass.states[k].attributes.controls
    );
  }

  /* ---------------------------------------------------------------- render */
  _render(st) {
    if (!st) {
      this.shadowRoot.innerHTML = `<ha-card><div class="pad">Nem találom a Gázkeret állapot szenzort. Add meg a kártyában: <code>entity: sensor.mvm_gazkeret_allapot</code></div></ha-card>`;
      return;
    }
    const a = st.attributes;
    const s = STATUS[a.status] || STATUS.ok;
    const c = a.controls || {};
    const on = (k) => c[k] && this._hass.states[c[k]]?.state === "on";

    const alerts = [];
    if (a.comm_fault)
      alerts.push(["#d63939", "mdi:lan-disconnect", "Nincs kapcsolat a kazánnal (OTGW)! A kazán ilyenkor magától fűthet."]);
    if (a.blocked)
      alerts.push(["#d63939", "mdi:fire-off", a.block_reason === "auto" ? "A kazán fűtése automatikusan tiltva – elfogyott az olcsó keret." : "A kazán fűtése kézzel tiltva."]);
    if (a.boiler_fault)
      alerts.push(["#e8590c", "mdi:wrench", `A kazán hibát jelez${a.boiler_fault_code ? ` (kód: ${a.boiler_fault_code})` : ""}.`]);
    if (a.reading_overdue)
      alerts.push(["#e3a008", "mdi:clipboard-text-clock", "Esedékes a gázóra leolvasás – rögzítsd lent."]);
    if (on("away")) alerts.push(["#6f42c1", "mdi:home-export-outline", "Távoli mód bekapcsolva."]);

    this.shadowRoot.innerHTML = `
      <style>${this._css(s.color)}</style>
      <ha-card>
        <div class="head">
          <div class="title"><ha-icon icon="mdi:meter-gas"></ha-icon>${this._config.title}</div>
          <div class="pill"><ha-icon icon="${s.icon}"></ha-icon>${s.label}</div>
        </div>
        ${alerts.map(([col, ic, t]) => `<div class="alert" style="--ac:${col}"><ha-icon icon="${ic}"></ha-icon><span>${t}</span></div>`).join("")}
        <div class="advice">${a.advice || ""}</div>

        <div class="hero">
          ${this._gauge(a)}
          <div class="legend">
            <div class="lg"><i style="background:var(--gk-c)"></i>Elfogyasztva <b>${fmt(a.p_used)} m³</b></div>
            <div class="lg"><i class="dash"></i>Várható <b>${fmt(a.p_proj)} m³</b></div>
            <div class="lg"><i class="tick"></i>Cél (${fmt(a.target_pct, 0)}%) <b>${fmt(a.p_target)} m³</b></div>
            <div class="lg muted">Időszak: ${dshort(a.p_start)} – ${dshort(a.p_end)} · még ${a.p_days_left} nap</div>
          </div>
        </div>

        <div class="tiles">
          <div class="tile">
            <div class="tl">Ma fogyott</div>
            <div class="tv">${fmt(a.today, 1)} <small>m³</small></div>
            <div class="ts">${a.today > a.allow_today ? `<span class="bad">több a napi keretnél</span>` : `még ${fmt(Math.max(0, a.allow_today - a.today), 1)} m³ fér bele`}</div>
          </div>
          <div class="tile">
            <div class="tl">Napi keret</div>
            <div class="tv">${fmt(a.allow_today, 1)} <small>m³</small></div>
            <div class="ts">cél: ${fmt(a.target_today, 1)} m³ / nap</div>
          </div>
          <div class="tile">
            <div class="tl">Várható számla</div>
            <div class="tv">${ft(a.p_bill)}</div>
            <div class="ts">eddig: ${ft(a.p_cost)}</div>
          </div>
          <div class="tile">
            <div class="tl">Éves keret</div>
            <div class="tv">${fmt(a.y_pct, 0)}<small>%</small></div>
            <div class="ts">${fmt(a.y_used, 0)} / ${fmt(a.y_quota, 0)} m³</div>
          </div>
        </div>

        <div class="tabs">
          ${[["napi", "30 nap"], ["eves", "Év"], ["szamla", "Számla"], ["szerviz", "Szerviz"]]
            .map(([k, l]) => `<button class="tab ${this._tab === k ? "on" : ""}" data-tab="${k}">${l}</button>`)
            .join("")}
        </div>
        <div class="tabbody">${this._tabBody(a)}</div>

        <div class="controls">
          ${this._toggle("auto_block", "mdi:fire-off", "Automatikus tiltás túllépéskor", on("auto_block"))}
          ${this._toggle("away", "mdi:home-export-outline", "Távoli mód", on("away"))}
          ${this._toggle("notify", "mdi:bell-ring", "Értesítések", on("notify"))}
        </div>
        <div class="actions">
          <button class="act primary" data-act="reading"><ha-icon icon="mdi:clipboard-edit"></ha-icon>Leolvasás rögzítése</button>
          ${a.blocked
            ? `<button class="act" data-act="btn_unblock"><ha-icon icon="mdi:fire"></ha-icon>Tiltás feloldása</button>`
            : `<button class="act" data-act="btn_block"><ha-icon icon="mdi:fire-off"></ha-icon>Kazán tiltása</button>`}
          <button class="act" data-act="btn_reset"><ha-icon icon="mdi:restart"></ha-icon>OTGW újraindítás</button>
        </div>
        <div class="foot">
          <span><ha-icon icon="${a.comm_fault ? "mdi:lan-disconnect" : "mdi:lan-connect"}"></ha-icon>OTGW: ${a.otgw_status}</span>
          <span><ha-icon icon="mdi:fire${a.flame_on ? "" : "-off"}"></ha-icon>Láng: ${a.flame_on ? "ég" : "nem ég"}</span>
          <span>Óraállás: ${a.meter !== null && a.meter !== undefined ? fmt(a.meter, 3) + " m³" : "add meg a leolvasást"}</span>
        </div>
      </ha-card>`;

    this.shadowRoot.querySelectorAll("[data-tab]").forEach((b) =>
      b.addEventListener("click", () => {
        this._tab = b.dataset.tab;
        this._sig = "";
        this.hass = this._hass;
      })
    );
    this.shadowRoot.querySelectorAll("[data-toggle]").forEach((b) =>
      b.addEventListener("click", () => {
        const e = c[b.dataset.toggle];
        if (e) this._hass.callService("switch", "toggle", { entity_id: e });
      })
    );
    this.shadowRoot.querySelectorAll("[data-act]").forEach((b) =>
      b.addEventListener("click", () => this._action(b.dataset.act, a))
    );
    this.shadowRoot.querySelectorAll("[data-more]").forEach((b) =>
      b.addEventListener("click", () => this._moreInfo(b.dataset.more))
    );
  }

  _toggle(key, icon, label, isOn) {
    return `<button class="tg ${isOn ? "on" : ""}" data-toggle="${key}">
      <ha-icon icon="${icon}"></ha-icon><span>${label}</span><i class="sw"><b></b></i></button>`;
  }

  /* ---------------------------------------------------------------- gauge */
  _gauge(a) {
    const R = 70, CX = 90, CY = 90, START = 135, SWEEP = 270;
    const max = Math.max(a.p_quota, a.p_proj, a.p_used) * 1.0 || 1;
    const scale = Math.max(1, max / (a.p_quota || 1));
    const ang = (v) => START + (SWEEP * Math.min(v, (a.p_quota || 1) * scale)) / ((a.p_quota || 1) * scale);
    const pt = (deg, r = R) => {
      const rad = (deg * Math.PI) / 180;
      return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
    };
    const arc = (from, to, r = R) => {
      if (to - from < 0.5) return "";
      const [x1, y1] = pt(from, r);
      const [x2, y2] = pt(to, r);
      return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    };
    const quotaEnd = ang(a.p_quota);
    const usedEnd = ang(a.p_used);
    const projEnd = ang(a.p_proj);
    const tgt = ang(a.p_target);
    const [t1x, t1y] = pt(tgt, R - 12);
    const [t2x, t2y] = pt(tgt, R + 12);
    const [q1x, q1y] = pt(quotaEnd, R - 12);
    const [q2x, q2y] = pt(quotaEnd, R + 12);
    const remaining = a.p_remaining;
    return `
      <svg viewBox="0 0 180 170" class="gauge" role="img" aria-label="Időszaki keret">
        <path d="${arc(START, START + SWEEP)}" class="g-bg"/>
        ${quotaEnd < START + SWEEP ? `<path d="${arc(quotaEnd, START + SWEEP)}" class="g-over-zone"/>` : ""}
        <path d="${arc(START, projEnd)}" class="g-proj"/>
        <path d="${arc(START, usedEnd)}" class="g-used"/>
        <line x1="${t1x}" y1="${t1y}" x2="${t2x}" y2="${t2y}" class="g-tgt"/>
        ${scale > 1 ? `<line x1="${q1x}" y1="${q1y}" x2="${q2x}" y2="${q2y}" class="g-q"/>` : ""}
        <text x="90" y="80" class="g-big">${fmt(Math.abs(remaining), 0)}</text>
        <text x="90" y="98" class="g-unit">${remaining >= 0 ? "m³ olcsó gáz maradt" : "m³ a keret felett"}</text>
        <text x="90" y="118" class="g-small">${fmt(a.p_pct, 0)}% · keret ${fmt(a.p_quota, 0)} m³</text>
      </svg>`;
  }

  /* ---------------------------------------------------------------- tabs */
  _tabBody(a) {
    if (this._tab === "eves") return this._yearChart(a);
    if (this._tab === "szamla") return this._bill(a);
    if (this._tab === "szerviz") return this._service(a);
    return this._dailyChart(a);
  }

  _dailyChart(a) {
    const days = a.last30 || [];
    if (!days.length) return `<div class="muted pad">Még nincs adat.</div>`;
    const W = 320, H = 130, PB = 18, PT = 8;
    const max = Math.max(1, ...days.map((d) => Math.max(d.used, d.quota))) * 1.15;
    const bw = W / days.length;
    const y = (v) => PT + (H - PB - PT) * (1 - v / max);
    const bars = days
      .map((d, i) => {
        if (!d.tracked) return "";
        const over = d.used > d.quota;
        const h = Math.max(0, H - PB - y(d.used));
        return `<rect x="${(i * bw + 1.5).toFixed(1)}" y="${y(d.used).toFixed(1)}" width="${(bw - 3).toFixed(1)}" height="${h.toFixed(1)}" rx="2" class="${over ? "b-over" : "b-ok"}"><title>${dshort(d.date)}: ${fmt(d.used, 1)} m³ (keret ${fmt(d.quota, 1)})</title></rect>`;
      })
      .join("");
    const line = days.map((d, i) => `${i ? "L" : "M"}${(i * bw + bw / 2).toFixed(1)} ${y(d.quota).toFixed(1)}`).join(" ");
    const labels = [0, 10, 20, 29]
      .map((i) => days[i] && `<text x="${(i * bw + bw / 2).toFixed(1)}" y="${H - 4}" class="ax" text-anchor="${i === 0 ? "start" : i === 29 ? "end" : "middle"}" style="text-anchor:${i === 0 ? "start" : i === 29 ? "end" : "middle"}">${dshort(days[i].date)}</text>`)
      .join("");
    const tracked = days.filter((d) => d.tracked);
    const sumU = tracked.reduce((s, d) => s + d.used, 0);
    const sumQ = tracked.reduce((s, d) => s + d.quota, 0);
    return `
      <svg viewBox="0 0 ${W} ${H}" class="chart">${bars}<path d="${line}" class="q-line"/>${labels}</svg>
      <div class="chart-legend"><span><i class="sq ok"></i>napi fogyasztás</span><span><i class="sq over"></i>keret felett</span><span><i class="ln"></i>jelleggörbe napi kerete</span></div>
      <div class="note">Mért napokon: ${fmt(sumU, 0)} m³ fogyott, a jelleggörbe szerint ${fmt(sumQ, 0)} m³ járt volna. 7 napos átlag: ${fmt(a.avg7, 1)} m³/nap.</div>`;
  }

  _yearChart(a) {
    const ms = a.months || [];
    const W = 320, H = 150, PB = 18, PT = 8;
    const max = Math.max(1, ...ms.map((m) => Math.max(m.quota, m.used || 0))) * 1.1;
    const gw = W / ms.length;
    const y = (v) => PT + (H - PB - PT) * (1 - v / max);
    const g = ms
      .map((m, i) => {
        const x = i * gw;
        const q = `<rect x="${(x + 3).toFixed(1)}" y="${y(m.quota).toFixed(1)}" width="${(gw / 2 - 3).toFixed(1)}" height="${(H - PB - y(m.quota)).toFixed(1)}" rx="2" class="b-quota"><title>${m.label}: keret ${fmt(m.quota, 0)} m³</title></rect>`;
        const u =
          m.used === null
            ? ""
            : `<rect x="${(x + gw / 2).toFixed(1)}" y="${y(m.used).toFixed(1)}" width="${(gw / 2 - 3).toFixed(1)}" height="${(H - PB - y(m.used)).toFixed(1)}" rx="2" class="${m.used > m.quota ? "b-over" : "b-ok"}${m.partial ? " partial" : ""}"><title>${m.label}: ${fmt(m.used, 0)} m³${m.partial ? " (részleges adat)" : ""}</title></rect>`;
        return `${q}${u}<text x="${(x + gw / 2).toFixed(1)}" y="${H - 4}" class="ax ${m.current ? "cur" : ""}">${m.label}</text>`;
      })
      .join("");
    const gap = a.y_cheap_left_to_target;
    return `
      <svg viewBox="0 0 ${W} ${H}" class="chart">${g}</svg>
      <div class="chart-legend"><span><i class="sq quota"></i>olcsó keret</span><span><i class="sq ok"></i>fogyasztás</span><span><i class="sq over"></i>keret felett</span></div>
      <div class="kv">
        <div><span>Kedvezményes év</span><b>${dshort(a.y_start)} – ${dshort(a.y_end)}</b></div>
        <div><span>Eddig fogyott</span><b>${fmt(a.y_used, 0)} m³ (${fmt(a.y_pct, 0)}%)</b></div>
        <div><span>Várható év végéig</span><b>${fmt(a.y_proj, 0)} m³ (${fmt(a.y_proj_pct, 0)}%)</b></div>
        <div><span>Éves olcsó keret</span><b>${fmt(a.y_quota, 0)} m³</b></div>
      </div>
      <div class="note ${gap > 0 ? "good" : ""}">${
        gap > 0
          ? `A ${fmt(a.target_pct, 0)}%-os célhoz még kb. <b>${fmt(gap, 0)} m³</b> olcsó gázt elhasználhatsz az év során – ezzel tehermentesítheted a klímát.`
          : a.y_proj_pct > 100
          ? `A mostani ütemben az éves keretet is túllépnéd. Az MVM az év végi elszámolásban beszámítja a hónapok közti különbséget, de a kereten felüli rész ${fmt(a.price_high, 0)} Ft/m³.`
          : `A tervezett ütemmel eléred a ${fmt(a.target_pct, 0)}%-os célt, és marad tartalék.`
      }</div>`;
  }

  _bill(a) {
    const low = Math.min(a.p_proj, a.p_quota);
    const high = Math.max(0, a.p_proj - a.p_quota);
    return `
      <div class="kv">
        <div><span>Időszak</span><b>${dshort(a.p_start)} – ${dshort(a.p_end)}</b></div>
        <div><span>Várható fogyasztás</span><b>${fmt(a.p_proj, 0)} m³</b></div>
        <div><span>Kereten belül (${fmt(a.price_low, 0)} Ft/m³)</span><b>${fmt(low, 0)} m³ · ${ft(low * a.price_low)}</b></div>
        <div><span>Kereten felül (${fmt(a.price_high, 0)} Ft/m³)</span><b class="${high > 0 ? "bad" : ""}">${fmt(high, 0)} m³ · ${ft(high * a.price_high)}</b></div>
        <div class="total"><span>Várható havi számla</span><b>${ft(a.p_bill)}</b></div>
        <div><span>Eddig felhasznált gáz ára</span><b>${ft(a.p_cost)}</b></div>
        <div class="total"><span>Várható éves gázköltség</span><b>${ft(a.y_bill)}</b></div>
      </div>
      <div class="note">Becslés: a mérés pontossága a havi leolvasással javul${a.corr && a.corr !== 1 ? ` (jelenlegi korrekció: ×${fmt(a.corr, 3)})` : ""}. Utolsó leolvasás: ${a.last_reading ? dshort(a.last_reading) : "még nincs"}.</div>`;
  }

  _service(a) {
    const row = (label, d, m, y, t) =>
      `<tr><td>${label}</td><td>${d}</td><td>${m}</td><td>${y}</td><td>${t}</td></tr>`;
    return `
      <table class="svc">
        <tr><th></th><th>Ma</th><th>Hónap</th><th>Év</th><th>Összes</th></tr>
        ${row("Kazán fűtött", hrs(a.h_heat_day), hrs(a.h_heat_month), hrs(a.h_heat_year), hrs(a.h_heat_total))}
        ${row("Égő (láng) égett", hrs(a.h_flame_day), hrs(a.h_flame_month), hrs(a.h_flame_year), hrs(a.h_flame_total))}
        ${row("Égő indítások", a.starts_day ?? "–", a.starts_month ?? "–", "", a.starts_total ?? "–")}
      </table>
      <div class="note">Szerviz információ. Sok rövid égőindítás (pl. óránként 6+) taktolásra utal – ilyenkor érdemes a fűtési minimum hőmérsékletet vagy a hiszterézist emelni.${
        a.h_flame_day > 0 && a.starts_day > 0 ? ` Ma átlagosan ${fmt((a.h_flame_day * 60) / a.starts_day, 0)} perc egy égés.` : ""
      }</div>`;
  }

  /* ---------------------------------------------------------------- actions */
  _action(act, a) {
    const c = a.controls || {};
    if (act === "reading") return this._readingDialog(a);
    if (act === "btn_block" && !confirm("Biztosan letiltod a kazán fűtését?")) return;
    if (act === "btn_reset" && !confirm("Újraindítsam az OpenTherm gateway-t?")) return;
    if (c[act]) this._hass.callService("button", "press", { entity_id: c[act] });
  }

  _readingDialog(a) {
    const prev = a.meter !== null && a.meter !== undefined ? a.meter.toFixed(3) : "";
    const v = prompt(
      `Gázóra leolvasás (m³)\n\nÍrd be a gázórán látható teljes számot (a tizedesvessző utáni piros számjegyekkel együtt).\nJelenlegi becsült állás: ${prev || "nincs"}`,
      prev
    );
    if (v === null) return;
    const num = parseFloat(String(v).replace(",", ".").replace(/\s/g, ""));
    if (isNaN(num) || num <= 0) {
      alert("Érvénytelen szám.");
      return;
    }
    this._hass.callService("gazkeret", "leolvasas", { meroallas: num, entry_id: a.entry_id });
  }

  _moreInfo(entityId) {
    const ev = new Event("hass-more-info", { bubbles: true, composed: true });
    ev.detail = { entityId };
    this.dispatchEvent(ev);
  }

  /* ---------------------------------------------------------------- style */
  _css(color) {
    return `
      :host { --gk-c: ${color}; --gk-ok: #2e9e5b; --gk-over: #d63939; --gk-quota: var(--secondary-text-color);
              --gk-bg: var(--secondary-background-color, rgba(127,127,127,.12)); }
      ha-card { padding: 16px; overflow: hidden; color: var(--primary-text-color); }
      .pad { padding: 16px; }
      .muted { color: var(--secondary-text-color); }
      .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .title { display: flex; align-items: center; gap: 8px; font-size: 1.2em; font-weight: 600; }
      .title ha-icon { color: var(--gk-c); }
      .pill { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px 4px 6px; border-radius: 999px;
              background: color-mix(in srgb, var(--gk-c) 16%, transparent); color: var(--gk-c); font-weight: 600; font-size: .85em; white-space: nowrap; }
      .pill ha-icon { --mdc-icon-size: 18px; }
      .alert { display: flex; gap: 8px; align-items: center; margin-top: 10px; padding: 8px 10px; border-radius: 10px;
               background: color-mix(in srgb, var(--ac) 14%, transparent); color: var(--primary-text-color); font-size: .9em; border-left: 4px solid var(--ac); }
      .alert ha-icon { color: var(--ac); --mdc-icon-size: 20px; flex: none; }
      .advice { margin: 12px 0 4px; font-size: 1em; line-height: 1.4; }
      .hero { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: center; }
      .gauge { width: 190px; max-width: 55%; flex: none; }
      .g-bg { fill: none; stroke: var(--gk-bg); stroke-width: 14; stroke-linecap: round; }
      .g-over-zone { fill: none; stroke: color-mix(in srgb, var(--gk-over) 25%, transparent); stroke-width: 14; }
      .g-proj { fill: none; stroke: var(--gk-c); stroke-opacity: .35; stroke-width: 14; stroke-dasharray: 3 3; }
      .g-used { fill: none; stroke: var(--gk-c); stroke-width: 14; stroke-linecap: round; }
      .g-tgt { stroke: var(--primary-text-color); stroke-width: 2.5; }
      .g-q { stroke: var(--gk-over); stroke-width: 2.5; }
      .g-big { font-size: 30px; font-weight: 700; text-anchor: middle; fill: var(--primary-text-color); }
      .g-unit { font-size: 10px; text-anchor: middle; fill: var(--secondary-text-color); }
      .g-small { font-size: 10px; text-anchor: middle; fill: var(--secondary-text-color); }
      .legend { flex: 1; min-width: 150px; display: grid; gap: 6px; font-size: .88em; }
      .lg { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
      .lg b { margin-left: auto; }
      .lg i { width: 12px; height: 12px; border-radius: 3px; flex: none; }
      .lg i.dash { background: repeating-linear-gradient(90deg, var(--gk-c) 0 3px, transparent 3px 5px); opacity: .6; }
      .lg i.tick { width: 3px; background: var(--primary-text-color); border-radius: 1px; }
      .tiles { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 12px; }
      @media (min-width: 560px) { .tiles { grid-template-columns: repeat(4, 1fr); } }
      .tile { background: var(--gk-bg); border-radius: 12px; padding: 10px 12px; }
      .tl { font-size: .78em; color: var(--secondary-text-color); }
      .tv { font-size: 1.35em; font-weight: 700; margin-top: 2px; white-space: nowrap; }
      .tv small { font-size: .6em; font-weight: 500; color: var(--secondary-text-color); }
      .ts { font-size: .75em; color: var(--secondary-text-color); margin-top: 2px; }
      .bad { color: var(--gk-over) !important; font-weight: 600; }
      .tabs { display: flex; gap: 4px; margin: 14px 0 8px; background: var(--gk-bg); border-radius: 10px; padding: 3px; }
      .tab { flex: 1; border: 0; background: none; padding: 7px 4px; border-radius: 8px; color: var(--secondary-text-color);
             font: inherit; font-size: .88em; cursor: pointer; }
      .tab.on { background: var(--card-background-color, #fff); color: var(--primary-text-color); font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,.15); }
      .chart { width: 100%; height: auto; display: block; }
      .b-ok { fill: var(--gk-ok); } .b-over { fill: var(--gk-over); } .b-quota { fill: var(--gk-quota); opacity: .3; }
      .partial { opacity: .45; }
      .q-line { fill: none; stroke: var(--primary-text-color); stroke-width: 1.5; stroke-dasharray: 4 3; opacity: .7; }
      .ax { font-size: 9px; text-anchor: middle; fill: var(--secondary-text-color); }
      .ax.cur { font-weight: 700; fill: var(--primary-text-color); }
      .chart-legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: .75em; color: var(--secondary-text-color); margin-top: 4px; }
      .chart-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
      .sq.ok { background: var(--gk-ok); } .sq.over { background: var(--gk-over); } .sq.quota { background: var(--gk-quota); opacity: .3; }
      .ln { border-top: 2px dashed var(--primary-text-color); height: 0 !important; width: 14px !important; border-radius: 0 !important; vertical-align: 3px !important; }
      .note { font-size: .82em; color: var(--secondary-text-color); margin-top: 8px; line-height: 1.4; }
      .note.good { color: var(--gk-ok); }
      .kv { display: grid; gap: 6px; font-size: .9em; margin-top: 10px; }
      .kv div { display: flex; justify-content: space-between; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--divider-color); }
      .kv span { color: var(--secondary-text-color); }
      .kv .total b { font-size: 1.1em; }
      .svc { width: 100%; border-collapse: collapse; font-size: .85em; }
      .svc th { font-weight: 500; color: var(--secondary-text-color); text-align: right; padding: 4px; }
      .svc td { text-align: right; padding: 6px 4px; border-bottom: 1px solid var(--divider-color); white-space: nowrap; }
      .svc td:first-child { text-align: left; white-space: normal; }
      .controls { display: grid; gap: 6px; margin-top: 14px; }
      .tg { display: flex; align-items: center; gap: 10px; border: 0; background: var(--gk-bg); border-radius: 10px; padding: 9px 12px;
            font: inherit; color: var(--primary-text-color); cursor: pointer; text-align: left; }
      .tg span { flex: 1; font-size: .92em; }
      .tg ha-icon { color: var(--secondary-text-color); --mdc-icon-size: 20px; }
      .tg.on ha-icon { color: var(--primary-color); }
      .sw { width: 36px; height: 20px; border-radius: 10px; background: var(--disabled-text-color, #999); position: relative; flex: none; transition: .2s; }
      .sw b { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: .2s; }
      .tg.on .sw { background: var(--primary-color); } .tg.on .sw b { left: 18px; }
      .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
      .act { flex: 1 1 auto; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid var(--divider-color);
             background: none; border-radius: 10px; padding: 9px 10px; font: inherit; font-size: .88em; color: var(--primary-text-color); cursor: pointer; }
      .act ha-icon { --mdc-icon-size: 18px; }
      .act.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
      .foot { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 12px; font-size: .78em; color: var(--secondary-text-color); }
      .foot span { display: inline-flex; align-items: center; gap: 4px; }
      .foot ha-icon { --mdc-icon-size: 15px; }
    `;
  }
}

class GazkeretCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }
  set hass(hass) {
    this._hass = hass;
    this._render();
  }
  _render() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => ({ entity: "Gázkeret állapot szenzor", title: "Cím" }[s.name]);
      this._form.addEventListener("value-changed", (e) => {
        this._config = e.detail.value;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.data = this._config;
    this._form.schema = [
      { name: "entity", selector: { entity: { domain: "sensor", integration: "gazkeret" } } },
      { name: "title", selector: { text: {} } },
    ];
  }
}

if (!customElements.get("gazkeret-card")) customElements.define("gazkeret-card", GazkeretCard);
if (!customElements.get("gazkeret-card-editor")) customElements.define("gazkeret-card-editor", GazkeretCardEditor);
window.customCards = window.customCards || [];
if (!window.customCards.find((c) => c.type === "gazkeret-card"))
  window.customCards.push({
    type: "gazkeret-card",
    name: "Gázkeret",
    description: "MVM jelleggörbe alapú gázkeret, számla-előrejelzés, kazán tiltás és szervizórák",
    preview: true,
  });
console.info(`%c GAZKERET-CARD %c ${GK_VERSION} `, "background:#e8590c;color:#fff;font-weight:700", "background:#444;color:#fff");
