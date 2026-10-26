"""Állítható százalékos szintek."""
from __future__ import annotations

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.const import PERCENTAGE
from homeassistant.const import EntityCategory

from .const import DOMAIN, OPT_BLOCK_PCT, OPT_TARGET_PCT, OPT_WARN_PCT
from .entity import GazKeretEntity

NUMBERS = [
    (OPT_TARGET_PCT, "Olcsó gáz felhasználási cél", 0, 100, "mdi:target"),
    (OPT_WARN_PCT, "Figyelmeztetési szint", 50, 100, "mdi:bell-alert"),
    (OPT_BLOCK_PCT, "Kazántiltási szint", 50, 150, "mdi:fire-off"),
]


async def async_setup_entry(hass, entry, async_add_entities):
    m = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(GazKeretNumber(m, *n) for n in NUMBERS)


class GazKeretNumber(GazKeretEntity, NumberEntity):
    _attr_native_unit_of_measurement = PERCENTAGE
    _attr_native_step = 1
    _attr_mode = NumberMode.SLIDER
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, m, key, name, lo, hi, icon):
        super().__init__(m, key, name, icon)
        self._attr_native_min_value = lo
        self._attr_native_max_value = hi

    @property
    def native_value(self):
        return float(self.coordinator.rt(self.key))

    async def async_set_native_value(self, value: float) -> None:
        await self.coordinator.async_set_runtime(self.key, float(value))
