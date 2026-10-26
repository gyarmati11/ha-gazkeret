"""Közös entitás alap."""
from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, VERSION
from .manager import GazKeretManager


class GazKeretEntity(CoordinatorEntity[GazKeretManager]):
    _attr_has_entity_name = True

    def __init__(self, manager: GazKeretManager, key: str, name: str, icon: str | None = None) -> None:
        super().__init__(manager)
        self.key = key
        self._attr_name = name
        self._attr_unique_id = f"{manager.entry.entry_id}_{key}"
        self._attr_translation_key = None
        if icon:
            self._attr_icon = icon
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, manager.entry.entry_id)},
            name="MVM Gázkeret",
            manufacturer="Gázkeret",
            model="Jelleggörbe-figyelő",
            sw_version=VERSION,
            entry_type=DeviceEntryType.SERVICE,
        )

    @property
    def data(self) -> dict:
        return self.coordinator.data or {}
