"""Kapcsolók (futás közbeni beállítások)."""
from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.const import EntityCategory

from .const import DOMAIN, OPT_AUTO_BLOCK, OPT_AUTO_RESET, OPT_AWAY, OPT_NOTIFY
from .entity import GazKeretEntity

SWITCHES = [
    (OPT_AUTO_BLOCK, "Automatikus kazántiltás túllépéskor", "mdi:fire-off", None),
    (OPT_AWAY, "Távoli mód", "mdi:home-export-outline", None),
    (OPT_NOTIFY, "Értesítések", "mdi:bell-ring", EntityCategory.CONFIG),
    (OPT_AUTO_RESET, "OTGW automatikus újraindítás", "mdi:restart-alert", EntityCategory.CONFIG),
]


async def async_setup_entry(hass, entry, async_add_entities):
    m = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(GazKeretSwitch(m, *s) for s in SWITCHES)


class GazKeretSwitch(GazKeretEntity, SwitchEntity):
    def __init__(self, m, key, name, icon, cat):
        super().__init__(m, key, name, icon)
        self._attr_entity_category = cat

    @property
    def is_on(self):
        return bool(self.coordinator.rt(self.key))

    async def async_turn_on(self, **kwargs):
        await self.coordinator.async_set_runtime(self.key, True)

    async def async_turn_off(self, **kwargs):
        await self.coordinator.async_set_runtime(self.key, False)
