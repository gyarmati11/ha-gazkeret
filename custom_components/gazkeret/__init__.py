"""MVM Gázkeret – rezsicsökkentett gázkeret figyelése OpenTherm kazánhoz."""
from __future__ import annotations

import logging
from datetime import date
from pathlib import Path

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.helpers import config_validation as cv

from .const import (
    CARD_URL,
    DOMAIN,
    SERVICE_BLOCK,
    SERVICE_READING,
    SERVICE_SET_YEAR_OFFSET,
    SERVICE_UNBLOCK,
    VERSION,
)
from .manager import GazKeretManager

_LOGGER = logging.getLogger(__name__)
PLATFORMS = [Platform.SENSOR, Platform.BINARY_SENSOR, Platform.SWITCH, Platform.NUMBER, Platform.BUTTON]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    hass.data.setdefault(DOMAIN, {})
    await _register_card(hass)
    _register_services(hass)
    return True


async def _register_card(hass: HomeAssistant) -> None:
    """A Lovelace kártyák automatikus betöltése – nem kell külön erőforrást felvenni."""
    www = Path(__file__).parent / "www"
    base = CARD_URL.rsplit("/", 1)[0]  # /gazkeret
    files = ["gazkeret-card.js", "gazkeret-service-card.js"]
    try:
        from homeassistant.components.http import StaticPathConfig

        await hass.http.async_register_static_paths(
            [StaticPathConfig(f"{base}/{f}", str(www / f), False) for f in files])
    except ImportError:  # régebbi HA
        for f in files:
            hass.http.register_static_path(f"{base}/{f}", str(www / f), False)
    from homeassistant.components.frontend import add_extra_js_url

    for f in files:
        add_extra_js_url(hass, f"{base}/{f}?v={VERSION}")


def _manager(hass: HomeAssistant, call: ServiceCall) -> GazKeretManager:
    managers: dict = hass.data.get(DOMAIN, {})
    entry_id = call.data.get("entry_id")
    if entry_id and entry_id in managers:
        return managers[entry_id]
    if not managers:
        raise vol.Invalid("A Gázkeret integráció nincs beállítva")
    return next(iter(managers.values()))


def _register_services(hass: HomeAssistant) -> None:
    async def reading(call: ServiceCall):
        day = call.data.get("datum")
        msg = await _manager(hass, call).async_record_reading(
            float(call.data["meroallas"]), day if isinstance(day, date) else None)
        return {"uzenet": msg}

    async def unblock(call: ServiceCall):
        await _manager(hass, call).async_block(False, "kézi feloldás")

    async def block(call: ServiceCall):
        await _manager(hass, call).async_block(True, "kézi")

    async def year_offset(call: ServiceCall):
        await _manager(hass, call).async_set_year_offset(float(call.data["m3"]))

    base = {vol.Optional("entry_id"): cv.string}
    hass.services.async_register(
        DOMAIN, SERVICE_READING, reading,
        schema=vol.Schema({**base, vol.Required("meroallas"): vol.Coerce(float), vol.Optional("datum"): cv.date}),
        supports_response=SupportsResponse.OPTIONAL)
    hass.services.async_register(DOMAIN, SERVICE_UNBLOCK, unblock, schema=vol.Schema(base))
    hass.services.async_register(DOMAIN, SERVICE_BLOCK, block, schema=vol.Schema(base))
    hass.services.async_register(
        DOMAIN, SERVICE_SET_YEAR_OFFSET, year_offset,
        schema=vol.Schema({**base, vol.Required("m3"): vol.Coerce(float)}))


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    manager = GazKeretManager(hass, entry)
    await manager.async_setup()
    await manager.async_config_entry_first_refresh()
    hass.data[DOMAIN][entry.entry_id] = manager
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_reload))
    return True


async def _reload(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if ok:
        manager: GazKeretManager = hass.data[DOMAIN].pop(entry.entry_id)
        await manager.async_shutdown()
    return ok
