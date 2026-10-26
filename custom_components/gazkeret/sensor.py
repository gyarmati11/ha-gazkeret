"""Szenzorok."""
from __future__ import annotations

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.const import PERCENTAGE, UnitOfTime, UnitOfVolume
from homeassistant.helpers import entity_registry as er

from .const import DOMAIN
from .entity import GazKeretEntity

M3 = UnitOfVolume.CUBIC_METERS
H = UnitOfTime.HOURS
GAS = SensorDeviceClass.GAS
DUR = SensorDeviceClass.DURATION
TI = SensorStateClass.TOTAL_INCREASING
TOT = SensorStateClass.TOTAL
MEAS = SensorStateClass.MEASUREMENT

# key, név, mértékegység, device_class, state_class, ikon, alapból engedélyezett
SENSORS = [
    ("meter", "Gázóra állás", M3, GAS, TOT, "mdi:meter-gas", True),
    ("today", "Mai fogyasztás", M3, GAS, TI, "mdi:fire", True),
    ("allow_today", "Ma még fogyhat", M3, None, None, "mdi:gas-burner", True),
    ("target_today", "Javasolt mai gáz", M3, None, None, "mdi:target", True),
    ("p_used", "Időszaki fogyasztás", M3, GAS, TOT, "mdi:calendar-month", True),
    ("p_quota", "Időszaki olcsó keret", M3, None, None, "mdi:cash-check", True),
    ("p_remaining", "Maradék olcsó gáz", M3, None, None, "mdi:gauge", True),
    ("p_pct", "Keret kihasználtság", PERCENTAGE, None, MEAS, "mdi:percent", True),
    ("p_proj", "Várható időszaki fogyasztás", M3, None, None, "mdi:chart-line", True),
    ("p_cost", "Eddigi gázköltség", "Ft", None, None, "mdi:cash", True),
    ("p_bill", "Várható gázszámla", "Ft", None, None, "mdi:receipt-text", True),
    ("m_used", "Havi fogyasztás (naptári)", M3, GAS, TOT, "mdi:calendar", True),
    ("m_quota", "Havi olcsó keret (naptári)", M3, None, None, "mdi:calendar-check", True),
    ("y_used", "Éves fogyasztás (kedvezményes év)", M3, GAS, TOT, "mdi:calendar-range", True),
    ("y_quota", "Éves olcsó keret", M3, None, None, "mdi:calendar-star", True),
    ("y_pct", "Éves keret kihasználtság", PERCENTAGE, None, MEAS, "mdi:percent-circle", True),
    ("y_proj", "Várható éves fogyasztás", M3, None, None, "mdi:chart-timeline-variant", True),
    ("y_bill", "Várható éves gázköltség", "Ft", None, None, "mdi:cash-multiple", True),
    ("h_heat_day", "Kazán üzemóra ma", H, DUR, None, "mdi:water-boiler", True),
    ("h_heat_month", "Kazán üzemóra hónap", H, DUR, None, "mdi:water-boiler", True),
    ("h_heat_year", "Kazán üzemóra év", H, DUR, None, "mdi:water-boiler", True),
    ("h_heat_total", "Kazán üzemóra összes", H, DUR, TI, "mdi:water-boiler", True),
    ("h_flame_day", "Égő üzemóra ma", H, DUR, None, "mdi:fire-circle", True),
    ("h_flame_month", "Égő üzemóra hónap", H, DUR, None, "mdi:fire-circle", True),
    ("h_flame_year", "Égő üzemóra év", H, DUR, None, "mdi:fire-circle", True),
    ("h_flame_total", "Égő üzemóra összes", H, DUR, TI, "mdi:fire-circle", True),
    ("starts_day", "Égő indítások ma", None, None, None, "mdi:counter", True),
    ("starts_total", "Égő indítások összes", None, None, TI, "mdi:counter", False),
]

# A kártya ezekre hivatkozik a vezérléshez (unique_id kulcs → platform)
CONTROL_KEYS = {
    "auto_block": "switch", "away": "switch", "notify": "switch", "auto_reset": "switch",
    "warn_pct": "number", "target_pct": "number", "block_pct": "number",
    "btn_unblock": "button", "btn_block": "button", "btn_reset": "button",
}


async def async_setup_entry(hass, entry, async_add_entities):
    m = hass.data[DOMAIN][entry.entry_id]
    ents = [GazKeretSensor(m, *s) for s in SENSORS]
    ents.append(GazKeretSummary(m))
    async_add_entities(ents)


class GazKeretSensor(GazKeretEntity, SensorEntity):
    def __init__(self, m, key, name, unit, dc, sc, icon, enabled):
        super().__init__(m, key, name, icon)
        self._attr_native_unit_of_measurement = unit
        self._attr_device_class = dc
        self._attr_state_class = sc
        self._attr_entity_registry_enabled_default = enabled
        if unit == "Ft":
            self._attr_suggested_display_precision = 0
        elif unit == M3:
            self._attr_suggested_display_precision = 1 if key not in ("meter", "today", "allow_today", "target_today") else 2

    @property
    def native_value(self):
        return self.data.get(self.key)

    @property
    def available(self) -> bool:
        return super().available and (self.key != "meter" or self.data.get("meter") is not None)


class GazKeretSummary(GazKeretEntity, SensorEntity):
    """Egyetlen összesítő entitás – a Lovelace kártya ebből dolgozik."""

    _unrecorded_attributes = frozenset({"months", "last30", "readings", "controls", "advice"})

    def __init__(self, m):
        super().__init__(m, "status", "Állapot", "mdi:fire-alert")
        self._attr_device_class = SensorDeviceClass.ENUM
        self._attr_options = ["Rásegíthetsz gázzal", "Jó ütemben", "Közel a kerethez", "Túllépés várható", "Keret túllépve"]

    @property
    def native_value(self):
        return self.data.get("status_text")

    @property
    def icon(self):
        return {"boost": "mdi:fire", "ok": "mdi:check-circle", "warn": "mdi:alert",
                "over_expected": "mdi:alert-octagon", "over": "mdi:fire-alert"}.get(self.data.get("status"), "mdi:fire")

    @property
    def extra_state_attributes(self):
        attrs = dict(self.data)
        attrs.pop("status_text", None)
        reg = er.async_get(self.hass)
        eid = self.coordinator.entry.entry_id
        attrs["controls"] = {
            k: reg.async_get_entity_id(p, DOMAIN, f"{eid}_{k}") for k, p in CONTROL_KEYS.items()
        }
        attrs["entry_id"] = eid
        return attrs
