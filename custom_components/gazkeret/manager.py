"""A Gázkeret központi logikája: mérés, üzemóra, értesítés, tiltás, OTGW felügyelet."""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import date, datetime, timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import STATE_ON, STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.event import (
    async_track_state_change_event,
    async_track_time_interval,
)
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.util import dt as dt_util

from .calc import compute
from .const import (
    BLOCK_ACTION_ON,
    CONF_AWAY_ENTITY,
    CONF_AWAY_VALUE,
    CONF_BLOCK_ACTION,
    CONF_BLOCK_ENTITY,
    CONF_BLOCK_VALUE,
    CONF_BOILER_ACTIVE_ENTITY,
    CONF_EXTRA_MJ,
    CONF_FAULT_CODE_ENTITY,
    CONF_FAULT_ENTITY,
    CONF_FLAME_ENTITY,
    CONF_HEATING_VALUE,
    CONF_METER_ENTITY,
    CONF_METER_FACTOR,
    CONF_MONTHLY_FEE,
    CONF_NOTIFY_SERVICES,
    CONF_OTGW_FAIL_MINUTES,
    CONF_OTGW_HOST,
    CONF_OTGW_PORT,
    CONF_OTGW_POWER_SWITCH,
    CONF_OTGW_RESTART_BUTTON,
    CONF_OTGW_STATUS_ENTITY,
    CONF_PRICE_HIGH,
    CONF_PRICE_LOW,
    CONF_YEAR_OFFSET,
    DEFAULTS,
    DOMAIN,
    MAX_DELTA_M3,
    OPT_AUTO_BLOCK,
    OPT_AUTO_RESET,
    OPT_AWAY,
    OPT_BLOCK_PCT,
    OPT_NOTIFY,
    OPT_TARGET_PCT,
    OPT_WARN_PCT,
    RUNTIME_DEFAULTS,
    STATUS_LEVEL,
    STATUS_OVER,
    STATUS_OVER_EXPECTED,
    STATUS_WARN,
)

_LOGGER = logging.getLogger(__name__)
STORAGE_VERSION = 1
KEEP_DAYS = 800
BAD_STATES = (STATE_UNAVAILABLE, STATE_UNKNOWN, None, "")


def _f(state) -> float | None:
    if state is None or state.state in BAD_STATES:
        return None
    try:
        return float(state.state)
    except (TypeError, ValueError):
        return None


class GazKeretManager(DataUpdateCoordinator[dict]):
    """Mindent ez az objektum tart nyilván, az entitások csak megjelenítenek."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(hass, _LOGGER, config_entry=entry, name=DOMAIN, update_interval=timedelta(minutes=1))
        self.entry = entry
        self._store = Store(hass, STORAGE_VERSION, f"{DOMAIN}.{entry.entry_id}")
        self.s: dict[str, Any] = {}
        self._unsubs: list = []
        self._on_since: dict[str, float | None] = {"heat": None, "flame": None}
        self._comm_bad_since: float | None = None
        self._last_reset_ts: float = 0.0
        self._busy_reset = False

    # ------------------------------------------------------------------ config
    @property
    def conf(self) -> dict:
        c = dict(DEFAULTS)
        c.update(self.entry.data)
        c.update(self.entry.options)
        return c

    def rt(self, key: str):
        return self.s["runtime"].get(key, RUNTIME_DEFAULTS[key])

    async def async_set_runtime(self, key: str, value) -> None:
        old = self.rt(key)
        self.s["runtime"][key] = value
        if key == OPT_AWAY and bool(old) != bool(value):
            await self._apply_away(bool(value))
        self._save()
        await self.async_refresh()

    # ------------------------------------------------------------------ setup
    async def async_setup(self) -> None:
        stored = await self._store.async_load() or {}
        self.s = {
            "meter": None, "last_raw": None, "corr": 1.0, "since_reading": 0.0,
            "daily": {}, "readings": [], "tracking_start": None,
            "hours": {}, "total": {"heat": 0.0, "flame": 0.0, "starts": 0},
            "blocked": False, "block_reason": None, "block_prev": None,
            "away_prev": None, "notified": {"period": None, "level": 0},
            "comm_fault": False, "fault_notified": False,
            "reset_log": [], "runtime": {}, "year_offset": {},
        }
        self.s.update(stored)

        c = self.conf
        if self.s["tracking_start"] is None:
            self.s["tracking_start"] = dt_util.now().date().isoformat()

        # kezdő mérőállás betöltése
        st = self.hass.states.get(c[CONF_METER_ENTITY])
        raw = _f(st)
        if raw is not None and self.s["last_raw"] is None:
            self.s["last_raw"] = raw * float(c[CONF_METER_FACTOR])

        self._unsubs.append(async_track_state_change_event(
            self.hass, [c[CONF_METER_ENTITY]], self._meter_changed))

        tracked = []
        for key, conf_key in (("heat", CONF_BOILER_ACTIVE_ENTITY), ("flame", CONF_FLAME_ENTITY)):
            ent = c.get(conf_key)
            if ent:
                tracked.append(ent)
                st = self.hass.states.get(ent)
                if st and st.state == STATE_ON:
                    self._on_since[key] = time.time()
        if c.get(CONF_FAULT_ENTITY):
            tracked.append(c[CONF_FAULT_ENTITY])
        if tracked:
            self._unsubs.append(async_track_state_change_event(
                self.hass, tracked, self._binary_changed))

        self._unsubs.append(async_track_time_interval(
            self.hass, self._otgw_check, timedelta(seconds=60)))

    async def async_shutdown(self) -> None:
        for u in self._unsubs:
            u()
        self._unsubs.clear()
        self._flush_hours()
        await self._store.async_save(self.s)
        await super().async_shutdown()

    def _save(self) -> None:
        self._store.async_delay_save(lambda: self.s, 30)

    # ------------------------------------------------------------------ gázmérő
    @callback
    def _meter_changed(self, event: Event) -> None:
        val = _f(event.data.get("new_state"))
        if val is None:
            return
        raw = val * float(self.conf[CONF_METER_FACTOR])
        last = self.s["last_raw"]
        self.s["last_raw"] = raw
        if last is None:
            return
        delta = raw - last
        if delta < 0:
            # számláló nullázódott (pl. ESP újraindult) – az új érték maga a fogyasztás
            delta = raw if raw < 2 else 0.0
        if delta <= 0 or delta > MAX_DELTA_M3:
            if delta > MAX_DELTA_M3:
                _LOGGER.warning("Gázkeret: gyanús ugrás (%.3f m³), kihagyva", delta)
            return
        self._add_consumption(delta)
        self._save()
        self.hass.async_create_task(self.async_refresh())

    def _add_consumption(self, delta: float) -> None:
        d = delta * float(self.s["corr"])
        key = dt_util.now().date().isoformat()
        self.s["daily"][key] = round(self.s["daily"].get(key, 0.0) + d, 4)
        if self.s["meter"] is not None:
            self.s["meter"] = round(self.s["meter"] + d, 4)
        self.s["since_reading"] = self.s["since_reading"] + d

    async def async_record_reading(self, value: float, day: date | None = None) -> str:
        """Havi leolvasás: kalibrálja a mérőállást és a mért fogyasztást."""
        day = day or dt_util.now().date()
        msg = f"Leolvasás rögzítve: {value:.3f} m³ ({day.isoformat()})."
        readings = self.s["readings"]
        if readings:
            prev = readings[-1]
            real = value - float(prev["value"])
            measured = float(self.s["since_reading"])
            if real > 0 and measured > 0.5:
                ratio = real / measured
                if 0.5 <= ratio <= 1.5:
                    prev_d = date.fromisoformat(prev["date"])
                    for k in list(self.s["daily"]):
                        kd = date.fromisoformat(k)
                        if prev_d <= kd <= day:
                            self.s["daily"][k] = round(self.s["daily"][k] * ratio, 4)
                    self.s["corr"] = round(min(1.3, max(0.7, float(self.s["corr"]) * ratio)), 4)
                    msg += (f" Mért: {measured:.1f} m³, valós: {real:.1f} m³ → "
                            f"korrekció {ratio:.3f} (új szorzó {self.s['corr']:.3f}).")
                else:
                    msg += f" Az eltérés túl nagy ({ratio:.2f}x), nem korrigáltam – ellenőrizd a jeladót!"
        readings.append({"date": day.isoformat(), "value": value})
        self.s["readings"] = readings[-24:]
        self.s["meter"] = value
        self.s["since_reading"] = 0.0
        self.s["notified"] = {"period": None, "level": 0}
        if self.s["blocked"] and self.s["block_reason"] == "auto":
            await self.async_block(False, "új időszak")
        self._save()
        await self.async_refresh()
        await self.notify("Gázóra leolvasás", msg, tag="reading")
        return msg

    async def async_set_year_offset(self, value: float) -> None:
        today = dt_util.now().date()
        ys = date(today.year if today.month >= 8 else today.year - 1, 8, 1)
        self.s["year_offset"][str(ys.year)] = float(value)
        self._save()
        await self.async_refresh()

    # ------------------------------------------------------------------ üzemóra
    @callback
    def _binary_changed(self, event: Event) -> None:
        c = self.conf
        ent = event.data["entity_id"]
        new = event.data.get("new_state")
        old = event.data.get("old_state")
        if ent == c.get(CONF_FAULT_ENTITY):
            self.hass.async_create_task(self._fault_changed(new))
            return
        key = "heat" if ent == c.get(CONF_BOILER_ACTIVE_ENTITY) else "flame"
        if ent == c.get(CONF_FLAME_ENTITY) and ent == c.get(CONF_BOILER_ACTIVE_ENTITY):
            key = "flame"
        is_on = new is not None and new.state == STATE_ON
        was_on = old is not None and old.state == STATE_ON
        if is_on and not was_on:
            self._on_since[key] = time.time()
            if key == "flame":
                self._bucket()["starts"] = self._bucket().get("starts", 0) + 1
                self.s["total"]["starts"] = self.s["total"].get("starts", 0) + 1
        elif was_on and not is_on:
            self._flush_one(key)
            self._on_since[key] = None
        self._save()

    def _bucket(self) -> dict:
        key = dt_util.now().date().isoformat()
        return self.s["hours"].setdefault(key, {"heat": 0.0, "flame": 0.0, "starts": 0})

    def _flush_one(self, key: str) -> None:
        since = self._on_since.get(key)
        if since is None:
            return
        now = time.time()
        sec = max(0.0, now - since)
        if sec > 7200:  # pl. HA leállás után ne számoljunk fantom órákat
            sec = 60.0
        b = self._bucket()
        b[key] = round(b.get(key, 0.0) + sec, 1)
        self.s["total"][key] = round(self.s["total"].get(key, 0.0) + sec, 1)
        self._on_since[key] = now

    def _flush_hours(self) -> None:
        for k in ("heat", "flame"):
            if self._on_since.get(k) is not None:
                self._flush_one(k)

    def _hours_summary(self, today: date) -> dict:
        def total(pred, key):
            return sum(v.get(key, 0) for k, v in self.s["hours"].items() if pred(date.fromisoformat(k)))
        out = {}
        for key in ("heat", "flame"):
            out[f"h_{key}_day"] = round(total(lambda d: d == today, key) / 3600, 2)
            out[f"h_{key}_month"] = round(total(lambda d: (d.year, d.month) == (today.year, today.month), key) / 3600, 1)
            out[f"h_{key}_year"] = round(total(lambda d: d.year == today.year, key) / 3600, 1)
            out[f"h_{key}_total"] = round(self.s["total"].get(key, 0) / 3600, 1)
        out["starts_day"] = int(total(lambda d: d == today, "starts"))
        out["starts_month"] = int(total(lambda d: (d.year, d.month) == (today.year, today.month), "starts"))
        out["starts_total"] = int(self.s["total"].get("starts", 0))
        return out

    # ------------------------------------------------------------------ fő frissítés
    async def _async_update_data(self) -> dict:
        self._flush_hours()
        c = self.conf
        today = dt_util.now().date()
        self._prune(today)

        last_reading = date.fromisoformat(self.s["readings"][-1]["date"]) if self.s["readings"] else None
        ys = date(today.year if today.month >= 8 else today.year - 1, 8, 1)
        data = compute(
            today, self.s["daily"], last_reading,
            heating_value=float(c[CONF_HEATING_VALUE]),
            extra_mj=float(c[CONF_EXTRA_MJ]),
            price_low=float(c[CONF_PRICE_LOW]),
            price_high=float(c[CONF_PRICE_HIGH]),
            monthly_fee=float(c[CONF_MONTHLY_FEE]),
            year_offset=self._year_offset(ys),
            warn_pct=float(self.rt(OPT_WARN_PCT)),
            target_pct=float(self.rt(OPT_TARGET_PCT)),
            tracking_start=date.fromisoformat(self.s["tracking_start"]),
        )
        data.update(self._hours_summary(today))
        data["meter"] = None if self.s["meter"] is None else round(self.s["meter"], 3)
        data["corr"] = self.s["corr"]
        data["readings"] = self.s["readings"][-3:]
        data["last_reading"] = last_reading.isoformat() if last_reading else None
        data["blocked"] = bool(self.s["blocked"])
        data["block_reason"] = self.s["block_reason"]
        data["comm_fault"] = bool(self.s["comm_fault"])
        data["otgw_status"] = self._otgw_status_text()
        data["price_low"] = float(c[CONF_PRICE_LOW])
        data["price_high"] = float(c[CONF_PRICE_HIGH])
        for k in RUNTIME_DEFAULTS:
            data[k] = self.rt(k)
        st = self.hass.states.get(c.get(CONF_FAULT_ENTITY) or "")
        data["boiler_fault"] = bool(st and st.state == STATE_ON)
        code = self.hass.states.get(c.get(CONF_FAULT_CODE_ENTITY) or "")
        data["boiler_fault_code"] = code.state if code and code.state not in BAD_STATES else None
        flame = self.hass.states.get(c.get(CONF_FLAME_ENTITY) or "")
        data["flame_on"] = bool(flame and flame.state == STATE_ON)

        await self._evaluate(data)
        self._save()
        return data

    def _year_offset(self, ys: date) -> float:
        """A követés indulása előtt (aug. 1. óta) elfogyasztott gáz az adott kedvezményes évben."""
        key = str(ys.year)
        if key in self.s["year_offset"]:
            return float(self.s["year_offset"][key])
        ts = date.fromisoformat(self.s["tracking_start"])
        ts_ys = date(ts.year if ts.month >= 8 else ts.year - 1, 8, 1)
        return float(self.conf.get(CONF_YEAR_OFFSET, 0.0)) if ts_ys == ys else 0.0

    def _prune(self, today: date) -> None:
        limit = (today - timedelta(days=KEEP_DAYS)).isoformat()
        for key in ("daily", "hours"):
            for k in [k for k in self.s[key] if k < limit]:
                del self.s[key][k]

    async def _evaluate(self, data: dict) -> None:
        """Értesítések és automatikus tiltás."""
        period = data["p_start"]
        n = self.s["notified"]
        if n.get("period") != period:
            # új elszámolási időszak indult
            if n.get("period") is not None and self.s["blocked"] and self.s["block_reason"] == "auto":
                await self.async_block(False, "új elszámolási időszak")
            n = self.s["notified"] = {"period": period, "level": 0}

        level = STATUS_LEVEL[data["status"]]
        if level > n.get("level", 0):
            n["level"] = level
            if data["status"] == STATUS_WARN:
                await self.notify("⚠️ Gázkeret: közel a határhoz", data["advice"], tag="gaz_warn")
            elif data["status"] == STATUS_OVER_EXPECTED:
                await self.notify("⚠️ Gázkeret: túllépés várható", data["advice"], tag="gaz_warn")
            elif data["status"] == STATUS_OVER:
                await self.notify("🔥 Gázkeret túllépve!", data["advice"], tag="gaz_warn", critical=True)

        if self.rt(OPT_AUTO_BLOCK) and not self.s["blocked"]:
            limit = data["p_quota"] * float(self.rt(OPT_BLOCK_PCT)) / 100
            if data["p_used"] >= limit > 0:
                await self.async_block(True, "auto")

    # ------------------------------------------------------------------ tiltás
    async def async_block(self, block: bool, reason: str = "kézi") -> None:
        c = self.conf
        ent = c.get(CONF_BLOCK_ENTITY)
        if not ent:
            await self.notify("Gázkeret", "Kazán tiltás kérve, de nincs beállítva tiltó entitás (Beállítások → Gázkeret → Konfigurálás).")
            return
        domain = ent.split(".")[0]
        st = self.hass.states.get(ent)
        try:
            if block:
                if domain == "climate":
                    self.s["block_prev"] = st.state if st else "heat"
                    await self.hass.services.async_call("climate", "set_hvac_mode",
                                                        {"entity_id": ent, "hvac_mode": "off"}, blocking=True)
                elif domain in ("number", "input_number"):
                    self.s["block_prev"] = st.state if st else None
                    await self.hass.services.async_call(domain, "set_value",
                                                        {"entity_id": ent, "value": float(c[CONF_BLOCK_VALUE])}, blocking=True)
                else:
                    svc = "turn_on" if c[CONF_BLOCK_ACTION] == BLOCK_ACTION_ON else "turn_off"
                    await self.hass.services.async_call("homeassistant", svc, {"entity_id": ent}, blocking=True)
                self.s["blocked"] = True
                self.s["block_reason"] = "auto" if reason == "auto" else "kézi"
                txt = ("Automatikusan letiltottam a kazán fűtését, mert elfogyott az olcsó gázkeret."
                       if reason == "auto" else "A kazán fűtése le van tiltva.")
                await self.notify("⛔ Kazán tiltva", txt + " Feloldás: Gázkeret kártya → Tiltás feloldása.", tag="gaz_block")
            else:
                prev = self.s.get("block_prev")
                if domain == "climate":
                    await self.hass.services.async_call("climate", "set_hvac_mode",
                                                        {"entity_id": ent, "hvac_mode": prev if prev not in BAD_STATES and prev != "off" else "heat"}, blocking=True)
                elif domain in ("number", "input_number"):
                    if prev not in BAD_STATES:
                        await self.hass.services.async_call(domain, "set_value",
                                                            {"entity_id": ent, "value": float(prev)}, blocking=True)
                else:
                    svc = "turn_off" if c[CONF_BLOCK_ACTION] == BLOCK_ACTION_ON else "turn_on"
                    await self.hass.services.async_call("homeassistant", svc, {"entity_id": ent}, blocking=True)
                self.s["blocked"] = False
                self.s["block_reason"] = None
                self.s["block_prev"] = None
                await self.notify("✅ Kazán tiltás feloldva", f"Ok: {reason}.", tag="gaz_block")
        except Exception as err:  # noqa: BLE001
            _LOGGER.error("Gázkeret: tiltás/feloldás sikertelen: %s", err)
            await self.notify("Gázkeret hiba", f"Nem sikerült a kazán {'tiltása' if block else 'feloldása'}: {err}")
        self._save()
        self.async_update_listeners()

    # ------------------------------------------------------------------ távoli mód
    async def _apply_away(self, on: bool) -> None:
        c = self.conf
        ent = c.get(CONF_AWAY_ENTITY)
        if not ent:
            return
        domain = ent.split(".")[0]
        st = self.hass.states.get(ent)
        try:
            if on:
                if domain == "climate":
                    self.s["away_prev"] = st.attributes.get("temperature") if st else None
                    await self.hass.services.async_call("climate", "set_temperature",
                                                        {"entity_id": ent, "temperature": float(c[CONF_AWAY_VALUE])}, blocking=True)
                else:
                    self.s["away_prev"] = st.state if st else None
                    await self.hass.services.async_call(domain, "set_value",
                                                        {"entity_id": ent, "value": float(c[CONF_AWAY_VALUE])}, blocking=True)
                await self.notify("🏠 Távoli mód BE", f"Cél hőmérséklet: {c[CONF_AWAY_VALUE]} °C.", tag="gaz_away")
            else:
                prev = self.s.get("away_prev")
                if prev not in BAD_STATES:
                    if domain == "climate":
                        await self.hass.services.async_call("climate", "set_temperature",
                                                            {"entity_id": ent, "temperature": float(prev)}, blocking=True)
                    else:
                        await self.hass.services.async_call(domain, "set_value",
                                                            {"entity_id": ent, "value": float(prev)}, blocking=True)
                self.s["away_prev"] = None
                await self.notify("🏠 Távoli mód KI", f"Visszaállítva: {prev} °C.", tag="gaz_away")
        except Exception as err:  # noqa: BLE001
            _LOGGER.error("Gázkeret: távoli mód hiba: %s", err)

    # ------------------------------------------------------------------ OTGW
    def _otgw_status_text(self) -> str:
        if self.s.get("comm_fault"):
            return "Kommunikációs hiba"
        ent = self.conf.get(CONF_OTGW_STATUS_ENTITY)
        if not ent:
            return "Nincs figyelve"
        return "Rendben"

    def _otgw_entity_ok(self) -> bool | None:
        ent = self.conf.get(CONF_OTGW_STATUS_ENTITY)
        if not ent:
            return None
        st = self.hass.states.get(ent)
        if st is None or st.state in BAD_STATES:
            return False
        if ent.startswith("binary_sensor."):
            dc = st.attributes.get("device_class")
            # connectivity: on = kapcsolódva; problem: on = hiba
            return st.state == ("off" if dc == "problem" else STATE_ON)
        return st.state.lower() not in ("off", "disconnected", "error", "hiba", "nem kapcsolódik")

    async def _host_reachable(self) -> bool | None:
        host = self.conf.get(CONF_OTGW_HOST)
        if not host:
            return None
        try:
            _, writer = await asyncio.wait_for(
                asyncio.open_connection(host, int(self.conf[CONF_OTGW_PORT])), timeout=4)
            writer.close()
            return True
        except Exception:  # noqa: BLE001
            return False

    async def _otgw_check(self, _now=None) -> None:
        ent_ok = self._otgw_entity_ok()
        host_ok = await self._host_reachable()
        if ent_ok is None and host_ok is None:
            return
        ok = (ent_ok is not False) and (host_ok is not False)
        now = time.time()
        if ok:
            self._comm_bad_since = None
            if self.s["comm_fault"]:
                self.s["comm_fault"] = False
                await self.notify("✅ OTGW kapcsolat helyreállt", "A kazán ismét a Home Assistant vezérlése alatt van.", tag="otgw")
                self.async_update_listeners()
            return
        if self._comm_bad_since is None:
            self._comm_bad_since = now
            return
        mins = (now - self._comm_bad_since) / 60
        if mins < float(self.conf[CONF_OTGW_FAIL_MINUTES]):
            return
        if not self.s["comm_fault"]:
            self.s["comm_fault"] = True
            where = "a gateway nem érhető el a hálózaton" if host_ok is False else "az OpenTherm kapcsolat megszakadt"
            await self.notify(
                "🚨 OTGW kommunikációs hiba",
                f"{int(mins)} perce {where}. A kazán ilyenkor a saját beállításával "
                "(alacsony előremenővel, folyamatosan) fűthet – ez gázt fogyaszt!"
                + (" Automatikus újraindítást próbálok." if self.rt(OPT_AUTO_RESET) else ""),
                tag="otgw", critical=True)
            self.async_update_listeners()
        if self.rt(OPT_AUTO_RESET):
            await self.async_reset_otgw(auto=True, host_ok=host_ok)

    async def async_reset_otgw(self, auto: bool = False, host_ok: bool | None = None) -> None:
        if self._busy_reset:
            return
        now = time.time()
        log = [t for t in self.s["reset_log"] if now - t < 6 * 3600]
        if auto and (len(log) >= 3 or now - self._last_reset_ts < 600):
            return
        c = self.conf
        self._busy_reset = True
        try:
            done = None
            btn = c.get(CONF_OTGW_RESTART_BUTTON)
            plug = c.get(CONF_OTGW_POWER_SWITCH)
            if btn and host_ok is not False and self.hass.states.get(btn) and self.hass.states.get(btn).state != STATE_UNAVAILABLE:
                await self.hass.services.async_call("button", "press", {"entity_id": btn}, blocking=True)
                done = "szoftveres újraindítás"
            elif plug:
                await self.hass.services.async_call("homeassistant", "turn_off", {"entity_id": plug}, blocking=True)
                await asyncio.sleep(10)
                await self.hass.services.async_call("homeassistant", "turn_on", {"entity_id": plug}, blocking=True)
                done = "áramtalanítás (10 mp)"
            if done:
                log.append(now)
                self._last_reset_ts = now
                await self.notify("🔄 OTGW újraindítás", f"Végrehajtva: {done}.", tag="otgw_reset")
            elif not auto:
                await self.notify("Gázkeret", "Nincs beállítva újraindító gomb vagy konnektor az OTGW-hez.")
            self.s["reset_log"] = log
        except Exception as err:  # noqa: BLE001
            _LOGGER.error("Gázkeret: OTGW reset hiba: %s", err)
        finally:
            self._busy_reset = False

    async def _fault_changed(self, new) -> None:
        if new is None:
            return
        if new.state == STATE_ON and not self.s.get("fault_notified"):
            code = self.hass.states.get(self.conf.get(CONF_FAULT_CODE_ENTITY) or "")
            code_txt = f" (hibakód: {code.state})" if code and code.state not in BAD_STATES else ""
            self.s["fault_notified"] = True
            await self.notify("🛠️ Kazán hiba", f"A kazán hibát jelez{code_txt}. Nézd meg a kazán kijelzőjét.", tag="boiler_fault")
        elif new.state != STATE_ON:
            self.s["fault_notified"] = False
        self._save()

    # ------------------------------------------------------------------ értesítés
    async def notify(self, title: str, message: str, tag: str | None = None, critical: bool = False) -> None:
        self.hass.async_create_task(self.hass.services.async_call(
            "persistent_notification", "create",
            {"title": title, "message": message, "notification_id": f"{DOMAIN}_{tag or 'info'}"}))
        if not self.rt(OPT_NOTIFY):
            return
        services = self.conf.get(CONF_NOTIFY_SERVICES) or []
        if isinstance(services, str):
            services = [s.strip() for s in services.split(",") if s.strip()]
        for svc in services:
            svc = svc.removeprefix("notify.")
            data: dict[str, Any] = {"title": title, "message": message}
            extra: dict[str, Any] = {}
            if tag:
                extra["tag"] = tag
            if critical:
                extra.update({"priority": "high", "ttl": 0, "channel": "gazkeret_riasztas"})
            if extra and svc.startswith("mobile_app"):
                data["data"] = extra
            try:
                await self.hass.services.async_call("notify", svc, data, blocking=False)
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("Gázkeret: értesítés sikertelen (%s): %s", svc, err)
