"""Bináris szenzorok."""
from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity

from .const import DOMAIN
from .entity import GazKeretEntity

BINARIES = [
    ("over", "Keret túllépve", lambda d: d.get("p_overrun", 0) > 0, BinarySensorDeviceClass.PROBLEM, "mdi:fire-alert"),
    ("over_expected", "Túllépés várható", lambda d: d.get("status") in ("over_expected", "over"), BinarySensorDeviceClass.PROBLEM, "mdi:alert-octagon"),
    ("blocked", "Kazán tiltva", lambda d: d.get("blocked", False), None, "mdi:fire-off"),
    ("comm_fault", "OTGW kommunikációs hiba", lambda d: d.get("comm_fault", False), BinarySensorDeviceClass.PROBLEM, "mdi:lan-disconnect"),
    ("reading_overdue", "Leolvasás esedékes", lambda d: d.get("reading_overdue", False), None, "mdi:clipboard-alert"),
]


async def async_setup_entry(hass, entry, async_add_entities):
    m = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(GazKeretBinary(m, *b) for b in BINARIES)


class GazKeretBinary(GazKeretEntity, BinarySensorEntity):
    def __init__(self, m, key, name, fn, dc, icon):
        super().__init__(m, f"bin_{key}", name, icon)
        self._fn = fn
        self._attr_device_class = dc

    @property
    def is_on(self):
        return bool(self._fn(self.data))
