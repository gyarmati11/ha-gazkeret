/* Gázkeret – kazán szervizkártya (animált jelenet + körmutatók + szervizadatok).
 * Az OTGW entitásokat a barátságos név alapján magától megtalálja (pl. "OpenTherm Gateway Heating temp"),
 * bármelyik felülírható az `entities:` alatt.
 */
const GKS_VERSION = "1.2.0";

const GKS_NAMES = {
  flow: ["heating temp", "ch temp", "flow temp", "boiler temp"],
  ret: ["heating return temp", "return temp"],
  setpoint: ["heating setpoint temp", "ch setpoint", "setpoint"],
  modulation: ["modulation level", "modulation"],
  flame: ["flame"],
  heating: ["heating", "ch active"],
  dhw_active: ["dhw", "dhw active", "hot water"],
  fan: ["fan", "fan speed"],
  power: ["teljesitmeny", "teljesítmény", "power"],
  pressure: ["pressure", "ch pressure"],
  dhw_temp: ["dhw temp"],
  fault: ["fault"],
  fault_code: ["fault code"],
  diag_code: ["diagnostic code"],
  ot_status: ["opentherm status"],
  outdoor: ["outdoor temp"],
  indoor: ["indoor temp"],
  max_temp: ["heating max temp"],
  min_temp: ["heating min temp"],
  hysteresis: ["heating hysteresis"],
  equitherm: ["equitherm"],
  pid: ["pid"],
  ch_enable: ["ch enable", "ch enabled", "heating enable"],
  restart: ["restart"],
  reset_fault: ["reset fault"],
};
const BIN_KEYS = ["flame", "heating", "dhw_active", "fault", "ot_status"];
const SW_KEYS = ["equitherm", "pid", "ch_enable"];
const BTN_KEYS = ["restart", "reset_fault"];

const n = (v, d = 1) =>
  v === null || v === undefined || v === "" || isNaN(Number(v))
    ? "–"
    : Number(v).toLocaleString("hu-HU", { minimumFractionDigits: d, maximumFractionDigits: d });
const hrs = (h) => {
  if (h === null || h === undefined || isNaN(h)) return "–";
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  return hh >= 100 || (hh && !mm) ? `${n(h, 0)} óra` : hh ? `${hh} ó ${mm} p` : `${mm} perc`;
};
// hőmérséklet → szín (hideg kék → meleg narancs → forró piros)
const heatColor = (t) => {
  if (t === null || isNaN(t)) return "#3b4a63";
  const k = Math.max(0, Math.min(1, (t - 20) / 50));
  const stops = [[0, [56, 189, 248]], [0.45, [251, 191, 36]], [0.75, [249, 115, 22]], [1, [239, 68, 68]]];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) if (k >= stops[i][0] && k <= stops[i + 1][0]) (a = stops[i]), (b = stops[i + 1]);
  const f = (k - a[0]) / (b[0] - a[0] || 1);
  const c = a[1].map((v, i) => Math.round(v + (b[1][i] - v) * f));
  return `rgb(${c.join(",")})`;
};

class GazkeretServiceCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._sig = "";
    this._map = null;
  }
  static getStubConfig() {
    return { prefix: "OpenTherm Gateway" };
  }
  setConfig(config) {
    this._config = { prefix: "OpenTherm Gateway", title: "Kazán", max_power: 24, ...config };
    this._map = null;
  }
  getCardSize() {
    return 12;
  }
  getGridOptions() {
    return { columns: 12, min_columns: 6 };
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._map) this._map = this._discover();
    const ids = Object.values(this._map).filter(Boolean);
    const sig = ids.map((e) => hass.states[e]?.state ?? "").join("|") + (hass.states[this._map.gazkeret]?.last_updated || "");
    if (sig === this._sig) return;
    this._sig = sig;
    this._render();
  }

  _discover() {
    const states = this._hass.states;
    const pre = (this._config.prefix || "").toLowerCase().trim();
    const over = this._config.entities || {};
    const byName = {};
    for (const id of Object.keys(states)) {
      const fn = String(states[id].attributes.friendly_name || "").toLowerCase().trim();
      if (pre && !fn.startsWith(pre)) continue;
      (byName[fn.slice(pre.length).trim()] ||= []).push(id);
    }
    const map = {};
    for (const [key, names] of Object.entries(GKS_NAMES)) {
      if (over[key]) {
        map[key] = over[key];
        continue;
      }
      const pref = BIN_KEYS.includes(key) ? ["binary_sensor", "sensor"] : SW_KEYS.includes(key) ? ["switch"] : BTN_KEYS.includes(key) ? ["button"] : ["sensor", "number"];
      for (const nm of names) {
        const hit = (byName[nm] || []).find((c) => pref.includes(c.split(".")[0]));
        if (hit) {
          map[key] = hit;
          break;
        }
      }
    }
    for (const k of ["room", "pump"]) if (over[k]) map[k] = over[k];
    map.gazkeret =
      this._config.gazkeret ||
      Object.keys(states).find((k) => k.startsWith("sensor.") && states[k].attributes.p_quota !== undefined && states[k].attributes.controls);
    return map;
  }

  _st(k) {
    const id = this._map[k];
    return id ? this._hass.states[id] : undefined;
  }
  _v(k) {
    const s = this._st(k);
    if (!s || ["unavailable", "unknown", ""].includes(s.state)) return null;
    const f = Number(s.state);
    return isNaN(f) ? s.state : f;
  }
  _on(k) {
    return this._st(k)?.state === "on";
  }
  _has(k) {
    const s = this._st(k);
    return !!s && !["unavailable", "unknown"].includes(s.state);
  }
  _e(k) {
    const id = k === "g" ? this._map.gazkeret : this._map[k];
    return id ? `data-e="${id}"` : "";
  }

  /* ================================================================ jelenet */
  _scene(a) {
    const P = {
      priHot: "M134 82 H190",
      priCold: "M190 200 H134",
      secHot: "M226 82 H316 Q334 82 334 100 V140",
      secCold: "M296 206 H226",
    };
    const hotC = heatColor(a.flow), coldC = heatColor(a.ret);
    const radC = a.circ && a.flow !== null ? heatColor(a.flow - 6) : "#2a3850";
    const particles = (path, color, on, dur, count = 4) =>
      on
        ? Array.from({ length: count }, (_, i) => `
          <circle r="2.6" fill="${color}" filter="url(#gkGlowS)">
            <animateMotion dur="${dur}s" begin="${(-(dur / count) * i).toFixed(2)}s" repeatCount="indefinite" path="${path}"/>
          </circle>`).join("")
        : "";
    const pipe = (path, color, on) => `
      <path d="${path}" class="p-shell"/>
      <path d="${path}" class="p-core" stroke="${on ? color : "#3b4a63"}" ${on ? 'filter="url(#gkGlow)"' : ""}/>`;
    const flameS = a.flame ? 0.55 + (a.mod / 100) * 0.55 : 0;
    const gasDigits = (() => {
      const v = Math.max(0, Number(a.gasToday) || 0);
      const s = v.toFixed(2).padStart(6, "0"); // 000,00
      return s.split("").map((ch, i) => (ch === "." ? `<text x="${42 + i * 15}" y="281" class="odo-sep">,</text>` : `
        <rect x="${35 + i * 15}" y="266" width="13" height="19" rx="2.5" class="odo ${i >= 4 ? "odo-red" : ""}"/>
        <text x="${41.5 + i * 15}" y="280.5" class="odo-d">${ch}</text>`)).join("");
    })();

    return `
<svg viewBox="0 0 400 300" class="scene" role="img" aria-label="A kazán és a fűtési kör állapota">
  <defs>
    <radialGradient id="gkBg" cx="30%" cy="35%" r="85%">
      <stop offset="0" stop-color="#1b2a44"/><stop offset=".6" stop-color="#0e1729"/><stop offset="1" stop-color="#080d18"/>
    </radialGradient>
    <pattern id="gkDots" width="14" height="14" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".8" fill="#ffffff" opacity=".05"/></pattern>
    <linearGradient id="gkBody" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#26354f"/><stop offset="1" stop-color="#151f33"/></linearGradient>
    <linearGradient id="gkHx" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hotC}"/><stop offset="1" stop-color="${coldC}"/></linearGradient>
    <linearGradient id="gkRad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${radC}"/><stop offset="1" stop-color="${a.circ ? coldC : "#1f2b40"}"/></linearGradient>
    <radialGradient id="gkFlO" cx=".5" cy=".85" r=".8"><stop offset="0" stop-color="#fff3b0"/><stop offset=".35" stop-color="#ffb020"/><stop offset=".8" stop-color="#ff5a1f"/><stop offset="1" stop-color="#ff2d1f" stop-opacity="0"/></radialGradient>
    <radialGradient id="gkFlI" cx=".5" cy=".9" r=".7"><stop offset="0" stop-color="#ffffff"/><stop offset=".5" stop-color="#fff1a8"/><stop offset="1" stop-color="#ffc533" stop-opacity="0"/></radialGradient>
    <radialGradient id="gkFlB" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#7cc4ff"/><stop offset="1" stop-color="#2d6bff" stop-opacity="0"/></radialGradient>
    <radialGradient id="gkHalo" cx=".5" cy=".75" r=".6"><stop offset="0" stop-color="#ff7a1a" stop-opacity=".55"/><stop offset="1" stop-color="#ff7a1a" stop-opacity="0"/></radialGradient>
    <filter id="gkGlow" filterUnits="userSpaceOnUse" x="-20" y="-20" width="440" height="340"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="gkGlowS" filterUnits="userSpaceOnUse" x="-20" y="-20" width="440" height="340"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="gkBlur"><feGaussianBlur stdDeviation="6"/></filter>
    <clipPath id="gkWin"><rect x="44" y="122" width="70" height="80" rx="10"/></clipPath>
  </defs>

  <rect width="400" height="300" rx="18" fill="url(#gkBg)"/>
  <rect width="400" height="300" rx="18" fill="url(#gkDots)"/>

  <!-- csövek -->
  ${pipe(P.priHot, hotC, a.run)}${pipe(P.priCold, coldC, a.run)}
  ${pipe(P.secHot, hotC, a.circ)}${pipe(P.secCold, coldC, a.circ)}
  ${particles(P.priHot, "#ffd1a8", a.run, 1.4, 3)}${particles(P.priCold, "#bfe6ff", a.run, 1.4, 3)}
  ${particles(P.secHot, "#ffd1a8", a.circ, 2.6, 5)}${particles(P.secCold, "#bfe6ff", a.circ, 1.8, 3)}

  <!-- primer értékek -->
  <g ${this._e("flow")} class="tap">
    <rect x="137" y="54" width="50" height="20" rx="10" fill="${hotC}" opacity=".18"/>
    <text x="162" y="68.5" class="pill" fill="${a.flow !== null ? hotC : "#8091ad"}">${n(a.flow)}°</text>
  </g>
  <g ${this._e("ret")} class="tap">
    <rect x="137" y="208" width="50" height="20" rx="10" fill="${coldC}" opacity=".18"/>
    <text x="162" y="222.5" class="pill" fill="${a.ret !== null ? coldC : "#8091ad"}">${n(a.ret)}°</text>
  </g>
  <text x="162" y="136" class="dim">ΔT</text>
  <text x="162" y="154" class="dval">${a.dT === null ? "–" : n(a.dT)}</text>

  <!-- hőcserélő -->
  <g ${this._e("ret")} class="tap">
    <rect x="190" y="64" width="36" height="154" rx="7" fill="url(#gkHx)" opacity="${a.run ? 0.9 : 0.25}" ${a.run ? 'filter="url(#gkGlowS)"' : ""}/>
    ${Array.from({ length: 12 }, (_, i) => `<rect x="193" y="${70 + i * 12.2}" width="30" height="5" rx="2" fill="#0b1322" opacity=".55"/>`).join("")}
    <text x="208" y="236" class="lbl">hőcserélő</text>
  </g>

  <!-- szivattyú -->
  <g ${this._e("pump")} class="tap" transform="translate(262 206)">
    <circle r="12" class="pump-ring ${a.circ ? "on" : ""}"/>
    <g class="${a.circ ? "spin-fast" : ""}">${[0, 90, 180, 270].map((d) => `<path d="M0 0 Q5 -3 7 -8" transform="rotate(${d})" class="impeller"/>`).join("")}</g>
    <text y="27" class="lbl">szivattyú</text>
  </g>

  <!-- radiátor + hőhullám -->
  <g ${this._e("room")} class="tap">
    ${a.circ && a.flame ? `<ellipse cx="334" cy="176" rx="46" ry="40" fill="${radC}" opacity=".28" filter="url(#gkBlur)"/>` : ""}
    <rect x="294" y="140" width="80" height="66" rx="8" fill="url(#gkRad)" opacity="${a.circ ? 0.95 : 0.5}"/>
    ${Array.from({ length: 6 }, (_, i) => `<rect x="${301 + i * 12}" y="146" width="7" height="54" rx="3.5" fill="#0b1322" opacity=".35"/>`).join("")}
    ${a.circ && a.flame ? [0, 1, 2].map((i) => `<path d="M${314 + i * 20} 132 q-5 -8 0 -16 q5 -8 0 -16" class="wave" style="animation-delay:${i * 0.6}s"/>`).join("") : ""}
    <text x="334" y="226" class="big">${a.room !== null ? n(a.room) + "°" : "–"}</text>
    <text x="334" y="240" class="lbl">szoba</text>
  </g>

  <!-- kint / bent -->
  <g ${this._e("outdoor")} class="tap">
    <text x="300" y="30" class="lbl start">kint</text>
    <text x="300" y="48" class="mid start">${n(a.out)}°</text>
  </g>
  <g ${this._e("indoor")} class="tap">
    <text x="346" y="30" class="lbl start">cél bent</text>
    <text x="346" y="48" class="mid start">${n(a.ind)}°</text>
  </g>

  <!-- KAZÁN -->
  <g>
    <rect x="24" y="34" width="110" height="196" rx="16" fill="url(#gkBody)" stroke="#ffffff" stroke-opacity=".09"/>
    <rect x="24" y="34" width="110" height="196" rx="16" fill="none" stroke="${a.flame ? "#ff8a3d" : "#ffffff"}" stroke-opacity="${a.flame ? 0.35 : 0.04}" ${a.flame ? 'filter="url(#gkGlowS)"' : ""}/>
    <!-- ventilátor -->
    <g ${this._e("fan")} class="tap" transform="translate(48 58)">
      <circle r="11" fill="#0b1322" stroke="#ffffff" stroke-opacity=".12"/>
      <g class="${a.fan > 0 ? "spin" : ""}">${[0, 120, 240].map((d) => `<path d="M0 0 C3 -3 7 -8 2 -9.5 C-2 -9.5 -1.5 -4 0 0" transform="rotate(${d})" fill="#7dd3fc" opacity=".85"/>`).join("")}</g>
    </g>
    <text x="64" y="55" class="lbl start">ventilátor</text>
    <text x="64" y="68" class="sm start" ${this._e("fan")}>${this._has("fan") ? n(a.fan, 0) + " rpm" : "–"}</text>
    <!-- kijelző -->
    <g ${this._e("modulation")} class="tap">
      <rect x="40" y="82" width="78" height="30" rx="6" fill="#050b16" stroke="#38bdf8" stroke-opacity=".35"/>
      <text x="79" y="103.5" class="lcd" filter="url(#gkGlowS)">${a.flame ? n(a.mod, 0) + "%" : a.fault ? "E" + (a.fcode ?? "") : "– –"}</text>
    </g>
    <!-- lángablak -->
    <g ${this._e("flame")} class="tap">
      <rect x="44" y="122" width="70" height="80" rx="10" fill="#03060c" stroke="#ffffff" stroke-opacity=".08"/>
      <g clip-path="url(#gkWin)">
        ${a.flame ? `<ellipse cx="79" cy="190" rx="40" ry="36" fill="url(#gkHalo)"/>
        <g transform="translate(79 192) scale(${flameS.toFixed(2)})">
          <g class="fl fl1"><path d="M0 -62 C22 -34 30 -14 24 4 C20 16 10 20 0 20 C-10 20 -20 16 -24 4 C-30 -14 -12 -22 -8 -42 C-3 -28 6 -26 6 -16 C12 -30 6 -46 0 -62Z" fill="url(#gkFlO)"/></g>
          <g class="fl fl2"><path d="M0 -38 C12 -20 16 -8 12 4 C9 12 4 15 0 15 C-4 15 -9 12 -12 4 C-16 -8 -6 -16 -3 -26 C0 -18 4 -16 4 -10 C7 -20 4 -30 0 -38Z" fill="url(#gkFlI)"/></g>
          <ellipse cx="0" cy="14" rx="18" ry="6" fill="url(#gkFlB)" class="fl fl3"/>
        </g>` : `<text x="79" y="167" class="dim">láng nem ég</text>`}
        <rect x="52" y="196" width="54" height="4" rx="2" fill="#4b5873"/>
        ${Array.from({ length: 9 }, (_, i) => `<circle cx="${56 + i * 5.8}" cy="198" r="1" fill="${a.flame ? "#7cc4ff" : "#2a3446"}"/>`).join("")}
      </g>
    </g>
    <text x="79" y="221" class="lbl" ${this._e("power")}>${a.pw !== null ? n(a.pw, 1) + " kW" : "kazán"}</text>
  </g>

  <!-- gázóra számláló -->
  <g ${this._e("g")} class="tap">
    <text x="24" y="258" class="lbl start">gáz ma, m³</text>
    ${gasDigits}
  </g>

  <!-- állapot -->
  <g>
    <circle cx="156" cy="276" r="5" fill="${a.toneColor}" ${a.tone !== "idle" ? 'filter="url(#gkGlowS)"' : ""} class="${a.tone === "hot" ? "pulse" : ""}"/>
    <text x="168" y="280" class="status start" fill="${a.tone === "bad" ? "#ff8a8a" : "#e6edf7"}">${a.short}</text>
  </g>
</svg>`;
  }

  /* ================================================================ körmutató */
  _ring(key, value, max, big, unit, label, color, sub = "") {
    const R = 30, C = 2 * Math.PI * R;
    const frac = value === null || isNaN(value) ? 0 : Math.max(0, Math.min(1, value / max));
    return `
      <button class="ring" ${this._e(key)}>
        <svg viewBox="0 0 76 76" aria-hidden="true">
          <circle cx="38" cy="38" r="${R}" class="r-bg"/>
          <circle cx="38" cy="38" r="${R}" class="r-fg" stroke="${color}" stroke-opacity="${frac > 0.005 ? 1 : 0}" stroke-dasharray="${(C * frac).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 38 38)"/>
        </svg>
        <span class="r-val">${big}<small>${unit}</small></span>
        <span class="r-lbl">${label}</span>
        ${sub ? `<span class="r-sub">${sub}</span>` : ""}
      </button>`;
  }

  /* ================================================================ render */
  _render() {
    const flow = this._v("flow"), ret = this._v("ret"), sp = this._v("setpoint");
    const mod = Number(this._v("modulation")) || 0, fan = this._v("fan"), pw = this._v("power"), pr = this._v("pressure");
    const flame = this._on("flame"), heating = this._on("heating"), dhwOn = this._on("dhw_active");
    const out = this._v("outdoor"), ind = this._v("indoor"), room = this._v("room");
    const lo = this._v("min_temp"), hi = this._v("max_temp"), hyst = this._v("hysteresis");
    const fault = this._on("fault"), fcode = this._v("fault_code"), dcode = this._v("diag_code");
    const otSt = this._st("ot_status");
    const otOk = otSt ? otSt.state === "on" || otSt.state === "connected" : null;
    const chEn = this._st("ch_enable") ? this._on("ch_enable") : null;
    const eq = this._st("equitherm") ? this._on("equitherm") : null;
    const g = this._map.gazkeret ? this._hass.states[this._map.gazkeret]?.attributes || {} : {};
    const dT = typeof flow === "number" && typeof ret === "number" ? flow - ret : null;
    const run = flame || heating;
    const circ = this._map.pump ? this._on("pump") : run && dT !== null && dT > 1;
    const cyc = g.h_heat_day > 0 && g.starts_day ? g.starts_day / Math.max(g.h_heat_day, 0.5) : 0;

    let tone = "idle", short = "Készenlét";
    if (otOk === false) (tone = "bad"), (short = "Nincs OpenTherm kapcsolat");
    else if (fault) (tone = "bad"), (short = `Kazánhiba${fcode !== null ? ` – kód ${fcode}` : ""}`);
    else if (flame && dhwOn) (tone = "hot"), (short = "Melegvizet készít");
    else if (flame) (tone = "hot"), (short = `Fűt · ${n(mod, 0)}% láng`);
    else if (heating) (tone = "warm"), (short = "Fűtési igény, láng szünetel");
    else if (chEn === false || g.blocked) (tone = "off"), (short = "Fűtés tiltva");
    const toneColor = { idle: "#64748b", hot: "#ff7a1a", warm: "#fbbf24", bad: "#ef4444", off: "#a78bfa" }[tone];

    const warns = [];
    if (otOk === false) warns.push(["bad", "Nincs kapcsolat a kazánnal – ilyenkor a kazán a saját beállításával fűthet."]);
    if (fault) warns.push(["bad", `A kazán hibát jelez${fcode !== null ? ` (kód ${fcode})` : ""}. Nézd meg a kazán kijelzőjén.`]);
    if (pr !== null && (pr < 0.8 || pr > 2.5)) warns.push(["warn", `A víznyomás ${n(pr, 1)} bar – a megszokott 1,0–2,0 bar helyett.`]);
    if (cyc >= 6) warns.push(["warn", `Ma óránként kb. ${n(cyc, 0)} égőindítás – taktolás. A minimum előremenő vagy a hiszterézis emelése segít.`]);
    if (dT !== null && flame && dT > 25) warns.push(["warn", `Nagy az előremenő–visszatérő különbség (${n(dT)} K) – gyenge lehet a keringés.`]);

    const row = (k, label, value, cls = "") => `<button class="row ${cls}" ${this._e(k) || "disabled"}><span>${label}</span><b>${value}</b></button>`;
    const avgBurn = g.starts_day > 0 && g.h_flame_day ? `${n((g.h_flame_day * 60) / g.starts_day, 0)} perc` : "–";
    const maxP = Number(this._config.max_power) || 24;

    this.shadowRoot.innerHTML = `
      <style>${this._css()}</style>
      <ha-card>
        <header>
          <h2>${this._config.title}</h2>
          <div class="flags">
            ${eq !== null ? `<button class="flag ${eq ? "is-on" : ""}" ${this._e("equitherm")}>Equitherm ${eq ? "be" : "ki"}</button>` : ""}
            ${chEn !== null ? `<button class="flag ${chEn ? "is-on" : "is-bad"}" ${this._e("ch_enable")}>${chEn ? "Fűtés engedélyezve" : "Fűtés tiltva"}</button>` : ""}
            ${otOk !== null ? `<button class="flag ${otOk ? "is-on" : "is-bad"}" ${this._e("ot_status")}>OpenTherm ${otOk ? "ok" : "hiba"}</button>` : ""}
          </div>
        </header>

        ${this._scene({ flow, ret, dT, mod, fan, pw, flame, run, circ, room, out, ind, fault, fcode, gasToday: g.today, tone, toneColor, short })}

        ${warns.length ? `<ul class="warns">${warns.map(([c, t]) => `<li class="${c}">${t}</li>`).join("")}</ul>` : ""}

        <div class="rings">
          ${this._ring("modulation", flame ? mod : 0, 100, n(flame ? mod : 0, 0), "%", "Moduláció", "#ff7a1a", pw !== null ? `${n(pw, 1)} / ${maxP} kW` : "")}
          ${this._ring("flow", flow, Math.max(sp || 0, hi || 0, 1), n(flow, 0), "°", "Előremenő", heatColor(flow), sp !== null ? `cél ${n(sp, 0)}°` : "")}
          ${this._ring("ret", ret, Math.max(sp || 0, hi || 0, 1), n(ret, 0), "°", "Visszatérő", heatColor(ret), dT !== null ? `ΔT ${n(dT, 1)} K` : "")}
          ${this._ring("g", g.h_flame_day, 24, hrs(g.h_flame_day).replace(" perc", "p").replace(" ó ", ":").replace(" p", ""), "", "Láng ma", "#a78bfa", g.starts_day !== undefined ? `${g.starts_day} indítás` : "")}
        </div>

        <div class="groups">
          <section class="group">
            <h3><ha-icon icon="mdi:fire"></ha-icon>Égő</h3>
            ${row("modulation", "Moduláció", `${n(mod, 0)} %`)}
            ${row("power", "Teljesítmény", this._has("power") ? `${n(pw, 2)} kW` : "–")}
            ${row("fan", "Ventilátor", this._has("fan") ? `${n(fan, 0)} rpm` : "–")}
            ${row("g", "Indítások ma", g.starts_day ?? "–", cyc >= 6 ? "warn" : "")}
            ${row("g", "Átlagos égésidő", avgBurn)}
          </section>
          <section class="group">
            <h3><ha-icon icon="mdi:timer-outline"></ha-icon>Üzemidő</h3>
            ${row("g", "Láng ma", hrs(g.h_flame_day))}
            ${row("g", "Láng a hónapban", hrs(g.h_flame_month))}
            ${row("g", "Láng összesen", hrs(g.h_flame_total))}
            ${row("g", "Fűtési igény ma", hrs(g.h_heat_day))}
            ${row("g", "Fűtési igény idén", hrs(g.h_heat_year))}
          </section>
          <section class="group">
            <h3><ha-icon icon="mdi:tune-variant"></ha-icon>Szabályozás</h3>
            ${row("setpoint", "Előremenő cél", `${n(sp, 0)} °C`)}
            ${row("min_temp", "Minimum előremenő", `${n(lo, 0)} °C`)}
            ${row("max_temp", "Maximum előremenő", `${n(hi, 0)} °C`)}
            ${row("hysteresis", "Hiszterézis", `${n(hyst, 1)} °C`)}
            ${row("pid", "PID szabályzó", this._st("pid") ? (this._on("pid") ? "be" : "ki") : "–")}
          </section>
          <section class="group">
            <h3><ha-icon icon="mdi:stethoscope"></ha-icon>Diagnosztika</h3>
            ${row("ot_status", "OpenTherm kapcsolat", otOk === null ? "–" : otOk ? "rendben" : "nincs", otOk === false ? "bad" : "")}
            ${row("fault_code", "Hibakód", fault ? `${fcode ?? "?"}` : "nincs hiba", fault ? "bad" : "")}
            ${row("diag_code", "Diagnosztikai kód", dcode ?? "–")}
            ${row("pressure", "Víznyomás", this._has("pressure") ? `${n(pr, 1)} bar` : "–", pr !== null && (pr < 0.8 || pr > 2.5) ? "warn" : "")}
            ${row("g", "Gáz a hónapban", `${n(g.m_used, 1)} m³`)}
          </section>
        </div>

        <footer>
          ${this._map.reset_fault ? `<button class="act" data-btn="${this._map.reset_fault}" data-q="Nyugtázod a kazán hibáját?" ${fault ? "" : "disabled"}><ha-icon icon="mdi:check-decagram-outline"></ha-icon>Hiba nyugtázása</button>` : ""}
          ${this._map.restart ? `<button class="act" data-btn="${this._map.restart}" data-q="Újraindítod a gateway-t?"><ha-icon icon="mdi:restart"></ha-icon>Gateway újraindítása</button>` : ""}
        </footer>
      </ha-card>`;

    this.shadowRoot.querySelectorAll("[data-e]").forEach((el) =>
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const id = el.getAttribute("data-e");
        if (!id) return;
        const e = new Event("hass-more-info", { bubbles: true, composed: true });
        e.detail = { entityId: id };
        this.dispatchEvent(e);
      })
    );
    this.shadowRoot.querySelectorAll("[data-btn]").forEach((b) =>
      b.addEventListener("click", () => {
        if (confirm(b.dataset.q)) this._hass.callService("button", "press", { entity_id: b.dataset.btn });
      })
    );
  }

  _css() {
    return `
      :host { --ok: #22c55e; --amber: #f59e0b; --bad: #ef4444; --surface: var(--secondary-background-color, rgba(127,127,127,.1)); --muted: var(--secondary-text-color); }
      ha-card { container-type: inline-size; padding: 16px 14px 14px; color: var(--primary-text-color); font-variant-numeric: tabular-nums; overflow: hidden; }
      button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; text-align: inherit; }
      button:focus-visible, .tap:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; border-radius: 6px; }
      button[disabled] { cursor: default; }
      .tap { cursor: pointer; }

      header { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
      h2 { margin: 0; font-size: 1.35em; font-weight: 600; letter-spacing: -.01em; }
      .flags { display: flex; gap: 6px; flex-wrap: wrap; }
      .flag { font-size: .75em; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--divider-color); color: var(--muted); }
      .flag.is-on { border-color: color-mix(in srgb, var(--ok) 55%, transparent); color: var(--ok); }
      .flag.is-bad { border-color: color-mix(in srgb, var(--bad) 55%, transparent); color: var(--bad); }

      .scene { width: 100%; height: auto; display: block; border-radius: 18px; box-shadow: 0 10px 30px -12px rgba(8,13,24,.6); }
      .scene text { font-family: inherit; text-anchor: middle; }
      .scene .start { text-anchor: start; }
      .p-shell { fill: none; stroke: #0a1120; stroke-width: 9; stroke-linecap: round; stroke-linejoin: round; }
      .p-core { fill: none; stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; transition: stroke .6s; }
      .pill { font-size: 12.5px; font-weight: 700; }
      .lbl { font-size: 9px; fill: #8091ad; }
      .dim { font-size: 9.5px; fill: #64748b; }
      .dval { font-size: 15px; font-weight: 700; fill: #e6edf7; }
      .mid { font-size: 14px; font-weight: 600; fill: #e6edf7; }
      .sm { font-size: 10.5px; font-weight: 600; fill: #cbd5e1; }
      .big { font-size: 17px; font-weight: 700; fill: #ffffff; }
      .lcd { font-size: 17px; font-weight: 700; fill: #7dd3fc; letter-spacing: 1px; font-family: "Orbitron", "Segment7", ui-monospace, monospace; }
      .status { font-size: 12px; font-weight: 600; }
      .odo { fill: #0b1220; stroke: #ffffff; stroke-opacity: .12; }
      .odo-red { fill: #3a0d12; stroke: #ef4444; stroke-opacity: .35; }
      .odo-d { font-size: 13px; font-weight: 700; fill: #f8fafc; font-family: ui-monospace, monospace; }
      .odo-sep { font-size: 13px; fill: #cbd5e1; }
      .pump-ring { fill: #0b1322; stroke: #3b4a63; stroke-width: 2; }
      .pump-ring.on { stroke: #22c55e; filter: drop-shadow(0 0 4px #22c55e); }
      .impeller { fill: none; stroke: #94a3b8; stroke-width: 2; stroke-linecap: round; }
      .spin { animation: spin .7s linear infinite; transform-box: fill-box; transform-origin: center; }
      .spin-fast { animation: spin .9s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .wave { fill: none; stroke: #ffb37a; stroke-width: 1.6; stroke-linecap: round; opacity: 0; animation: rise 1.8s ease-out infinite; }
      @keyframes rise { 0% { opacity: 0; transform: translateY(6px); } 40% { opacity: .7; } 100% { opacity: 0; transform: translateY(-10px); } }
      .fl { transform-box: fill-box; transform-origin: 50% 100%; }
      .fl1 { animation: flick1 .9s ease-in-out infinite alternate; }
      .fl2 { animation: flick2 .6s ease-in-out infinite alternate; }
      .fl3 { animation: flick3 1.2s ease-in-out infinite alternate; }
      @keyframes flick1 { 0% { transform: scale(1, 1) skewX(0deg); } 50% { transform: scale(.94, 1.08) skewX(2deg); } 100% { transform: scale(1.04, .95) skewX(-2deg); } }
      @keyframes flick2 { 0% { transform: scale(1, 1); opacity: .95; } 100% { transform: scale(.9, 1.12); opacity: 1; } }
      @keyframes flick3 { 0% { opacity: .7; } 100% { opacity: 1; } }
      .pulse { animation: pulse 1.6s ease-in-out infinite; }
      @keyframes pulse { 50% { opacity: .45; } }

      .warns { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 6px; }
      .warns li { padding: 8px 12px; border-radius: 10px; font-size: .86em; line-height: 1.4; border-left: 4px solid; }
      .warns .bad { border-color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); }
      .warns .warn { border-color: var(--amber); background: color-mix(in srgb, var(--amber) 12%, transparent); }

      .rings { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-top: 14px; }
      .ring { position: relative; display: grid; justify-items: center; text-align: center; }
      .ring svg { width: 100%; max-width: 86px; height: auto; }
      .r-bg { fill: none; stroke: color-mix(in srgb, var(--primary-text-color) 9%, transparent); stroke-width: 7; }
      .r-fg { fill: none; stroke-width: 7; stroke-linecap: round; transition: stroke-dasharray .8s ease; filter: drop-shadow(0 0 3px currentColor); }
      .r-val { position: absolute; top: 0; left: 0; right: 0; aspect-ratio: 1; max-width: 86px; margin: 0 auto; display: flex; align-items: center; justify-content: center;
               font-size: 1.1em; font-weight: 700; }
      .r-val small { font-size: .6em; font-weight: 500; color: var(--muted); margin-left: 1px; align-self: flex-start; margin-top: 34%; }
      .r-lbl { font-size: .76em; font-weight: 600; margin-top: 2px; }
      .r-sub { font-size: .68em; color: var(--muted); }

      .groups { display: grid; grid-template-columns: 1fr; gap: 10px; margin-top: 16px; }
      @container (min-width: 560px) { .groups { grid-template-columns: 1fr 1fr; } }
      .group { background: var(--surface); border-radius: 14px; padding: 4px 12px 6px; }
      h3 { display: flex; align-items: center; gap: 8px; margin: 8px 0 2px; font-size: .9em; font-weight: 600; }
      h3 ha-icon { --mdc-icon-size: 18px; color: var(--muted); }
      .row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; width: 100%; padding: 6px 0;
             border-top: 1px solid color-mix(in srgb, var(--divider-color) 70%, transparent); font-size: .9em; }
      h3 + .row { border-top: 0; }
      .row span { color: var(--muted); }
      .row b { font-weight: 600; white-space: nowrap; }
      .row.warn b { color: var(--amber); } .row.bad b { color: var(--bad); }

      footer { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
      footer:empty { display: none; }
      .act { flex: 1 1 140px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 10px;
             border-radius: 12px; border: 1px solid var(--divider-color); font-size: .88em; }
      .act ha-icon { --mdc-icon-size: 18px; }
      .act[disabled] { opacity: .45; }

      @media (prefers-reduced-motion: reduce) { .spin, .spin-fast, .wave, .fl, .pulse { animation: none !important; } }
    `;
  }
}

if (!customElements.get("gazkeret-service-card")) customElements.define("gazkeret-service-card", GazkeretServiceCard);
window.customCards = window.customCards || [];
if (!window.customCards.find((c) => c.type === "gazkeret-service-card"))
  window.customCards.push({
    type: "gazkeret-service-card",
    name: "Gázkeret – kazán szerviz",
    description: "Animált kazánjelenet, körmutatók, üzemidő, szabályozás és diagnosztika",
    preview: true,
  });
console.info(`%c GAZKERET-SERVICE-CARD %c ${GKS_VERSION} `, "background:#ff7a1a;color:#fff;font-weight:700", "background:#0e1729;color:#fff");
