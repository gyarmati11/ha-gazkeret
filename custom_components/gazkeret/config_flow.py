"""Beállító varázsló – 3 lépés: gázmérő/árak, kazán, OTGW + értesítés."""
from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers import selector as sel

from .const import (
    BLOCK_ACTION_OFF,
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
)


def _num(lo, hi, step, unit=None):
    cfg = sel.NumberSelectorConfig(min=lo, max=hi, step=step, mode=sel.NumberSelectorMode.BOX)
    if unit:
        cfg["unit_of_measurement"] = unit
    return sel.NumberSelector(cfg)


def _ent(domains):
    return sel.EntitySelector(sel.EntitySelectorConfig(domain=domains))


def _opt(key, cur):
    """Opcionális mező, amely a jelenlegi értéket csak javasolja (törölhető marad)."""
    val = cur.get(key)
    return vol.Optional(key, description={"suggested_value": val} if val not in (None, "") else None)


def schema_meter(cur: dict) -> vol.Schema:
    return vol.Schema({
        vol.Required(CONF_METER_ENTITY, default=cur.get(CONF_METER_ENTITY, vol.UNDEFINED)): _ent(["sensor", "input_number", "counter"]),
        vol.Required(CONF_METER_FACTOR, default=cur.get(CONF_METER_FACTOR, DEFAULTS[CONF_METER_FACTOR])): _num(0.0001, 1000, "any"),
        vol.Required(CONF_HEATING_VALUE, default=cur.get(CONF_HEATING_VALUE, DEFAULTS[CONF_HEATING_VALUE])): _num(25, 45, 0.01, "MJ/m³"),
        vol.Required(CONF_PRICE_LOW, default=cur.get(CONF_PRICE_LOW, DEFAULTS[CONF_PRICE_LOW])): _num(0, 2000, 0.01, "Ft/m³"),
        vol.Required(CONF_PRICE_HIGH, default=cur.get(CONF_PRICE_HIGH, DEFAULTS[CONF_PRICE_HIGH])): _num(0, 5000, 0.01, "Ft/m³"),
        vol.Required(CONF_MONTHLY_FEE, default=cur.get(CONF_MONTHLY_FEE, DEFAULTS[CONF_MONTHLY_FEE])): _num(0, 100000, 1, "Ft/hó"),
        vol.Required(CONF_EXTRA_MJ, default=cur.get(CONF_EXTRA_MJ, DEFAULTS[CONF_EXTRA_MJ])): _num(0, 200000, 1, "MJ/év"),
        vol.Required(CONF_YEAR_OFFSET, default=cur.get(CONF_YEAR_OFFSET, DEFAULTS[CONF_YEAR_OFFSET])): _num(0, 10000, 0.1, "m³"),
    })


def schema_boiler(cur: dict) -> vol.Schema:
    return vol.Schema({
        _opt(CONF_BOILER_ACTIVE_ENTITY, cur): _ent(["binary_sensor", "switch"]),
        _opt(CONF_FLAME_ENTITY, cur): _ent(["binary_sensor"]),
        _opt(CONF_FAULT_ENTITY, cur): _ent(["binary_sensor"]),
        _opt(CONF_FAULT_CODE_ENTITY, cur): _ent(["sensor"]),
        _opt(CONF_BLOCK_ENTITY, cur): _ent(["switch", "input_boolean", "climate", "number", "input_number"]),
        vol.Required(CONF_BLOCK_ACTION, default=cur.get(CONF_BLOCK_ACTION, DEFAULTS[CONF_BLOCK_ACTION])): sel.SelectSelector(
            sel.SelectSelectorConfig(options=[BLOCK_ACTION_OFF, BLOCK_ACTION_ON], translation_key="block_action")),
        vol.Required(CONF_BLOCK_VALUE, default=cur.get(CONF_BLOCK_VALUE, DEFAULTS[CONF_BLOCK_VALUE])): _num(0, 100, 0.5),
        _opt(CONF_AWAY_ENTITY, cur): _ent(["number", "input_number", "climate"]),
        vol.Required(CONF_AWAY_VALUE, default=cur.get(CONF_AWAY_VALUE, DEFAULTS[CONF_AWAY_VALUE])): _num(5, 30, 0.5, "°C"),
    })


def schema_otgw(cur: dict) -> vol.Schema:
    return vol.Schema({
        _opt(CONF_OTGW_STATUS_ENTITY, cur): _ent(["binary_sensor", "sensor"]),
        _opt(CONF_OTGW_HOST, cur): sel.TextSelector(),
        vol.Required(CONF_OTGW_PORT, default=cur.get(CONF_OTGW_PORT, DEFAULTS[CONF_OTGW_PORT])): _num(1, 65535, 1),
        _opt(CONF_OTGW_RESTART_BUTTON, cur): _ent(["button"]),
        _opt(CONF_OTGW_POWER_SWITCH, cur): _ent(["switch"]),
        vol.Required(CONF_OTGW_FAIL_MINUTES, default=cur.get(CONF_OTGW_FAIL_MINUTES, DEFAULTS[CONF_OTGW_FAIL_MINUTES])): _num(1, 120, 1, "perc"),
        _opt(CONF_NOTIFY_SERVICES, cur): sel.TextSelector(sel.TextSelectorConfig(multiple=True)),
    })


def _clean(data: dict) -> dict:
    return {k: v for k, v in data.items() if v not in (None, "", [])}


class GazKeretConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    def __init__(self) -> None:
        self._data: dict[str, Any] = {}

    async def async_step_user(self, user_input=None):
        if user_input is not None:
            self._data.update(_clean(user_input))
            return await self.async_step_boiler()
        return self.async_show_form(step_id="user", data_schema=schema_meter({}))

    async def async_step_boiler(self, user_input=None):
        if user_input is not None:
            self._data.update(_clean(user_input))
            return await self.async_step_otgw()
        return self.async_show_form(step_id="boiler", data_schema=schema_boiler({}))

    async def async_step_otgw(self, user_input=None):
        if user_input is not None:
            self._data.update(_clean(user_input))
            await self.async_set_unique_id(self._data[CONF_METER_ENTITY])
            self._abort_if_unique_id_configured()
            return self.async_create_entry(title="MVM Gázkeret", data=self._data)
        return self.async_show_form(step_id="otgw", data_schema=schema_otgw({}))

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        return GazKeretOptionsFlow()


class GazKeretOptionsFlow(config_entries.OptionsFlow):
    """A beállítások utólagos módosítása – a teljes konfigurációt felülírja."""

    def __init__(self) -> None:
        self._data: dict[str, Any] = {}

    @property
    def _cur(self) -> dict:
        return {**self.config_entry.data, **self.config_entry.options}

    async def async_step_init(self, user_input=None):
        if user_input is not None:
            self._data.update(user_input)
            return await self.async_step_boiler()
        return self.async_show_form(step_id="init", data_schema=schema_meter(self._cur))

    async def async_step_boiler(self, user_input=None):
        if user_input is not None:
            self._data.update(user_input)
            return await self.async_step_otgw()
        return self.async_show_form(step_id="boiler", data_schema=schema_boiler(self._cur))

    async def async_step_otgw(self, user_input=None):
        if user_input is not None:
            self._data.update(user_input)
            # törölt opcionális mezők ne maradjanak meg a régi data-ból
            full = {k: self._data.get(k) for k in set(self._cur) | set(self._data)}
            for k in list(full):
                if k not in self._data:
                    full[k] = None
            return self.async_create_entry(title="", data=full)
        return self.async_show_form(step_id="otgw", data_schema=schema_otgw(self._cur))
