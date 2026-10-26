"""Gombok."""
from __future__ import annotations

from homeassistant.components.button import ButtonEntity

from .const import DOMAIN
from .entity import GazKeretEntity

BUTTONS = [
    ("btn_unblock", "Tiltás feloldása", "mdi:fire", lambda m: m.async_block(False, "kézi feloldás")),
    ("btn_block", "Kazán tiltása most", "mdi:fire-off", lambda m: m.async_block(True, "kézi")),
    ("btn_reset", "OTGW újraindítása", "mdi:restart", lambda m: m.async_reset_otgw(auto=False)),
]


async def async_setup_entry(hass, entry, async_add_entities):
    m = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(GazKeretButton(m, *b) for b in BUTTONS)


class GazKeretButton(GazKeretEntity, ButtonEntity):
    def __init__(self, m, key, name, icon, fn):
        super().__init__(m, key, name, icon)
        self._fn = fn

    async def async_press(self) -> None:
        await self._fn(self.coordinator)
        await self.coordinator.async_refresh()
