"""Konstansok – MVM Gázkeret."""
from __future__ import annotations

DOMAIN = "gazkeret"
VERSION = "1.0.0"

CARD_URL = f"/{DOMAIN}/gazkeret-card.js"

# MVM rögzített kedvezmény-megosztás 2024. augusztus 1-jétől (MJ / hónap), összesen 63 645 MJ.
# Forrás: mvmnext.hu sajtóközlemény 2024-08-01
MONTHLY_MJ: dict[int, int] = {
    1: 12365, 2: 10421, 3: 8915, 4: 5145, 5: 1827, 6: 635,
    7: 512, 8: 565, 9: 1109, 10: 3724, 11: 7490, 12: 10937,
}
ANNUAL_MJ = 63645

# --- Konfigurációs kulcsok ---
CONF_METER_ENTITY = "meter_entity"
CONF_METER_FACTOR = "meter_factor"
CONF_HEATING_VALUE = "heating_value"
CONF_PRICE_LOW = "price_low"
CONF_PRICE_HIGH = "price_high"
CONF_MONTHLY_FEE = "monthly_fee"
CONF_EXTRA_MJ = "extra_mj"
CONF_YEAR_OFFSET = "year_offset"

CONF_BOILER_ACTIVE_ENTITY = "boiler_active_entity"
CONF_FLAME_ENTITY = "flame_entity"
CONF_FAULT_ENTITY = "fault_entity"
CONF_FAULT_CODE_ENTITY = "fault_code_entity"
CONF_BLOCK_ENTITY = "block_entity"
CONF_BLOCK_ACTION = "block_action"
CONF_BLOCK_VALUE = "block_value"
CONF_AWAY_ENTITY = "away_entity"
CONF_AWAY_VALUE = "away_value"

CONF_OTGW_STATUS_ENTITY = "otgw_status_entity"
CONF_OTGW_HOST = "otgw_host"
CONF_OTGW_PORT = "otgw_port"
CONF_OTGW_RESTART_BUTTON = "otgw_restart_button"
CONF_OTGW_POWER_SWITCH = "otgw_power_switch"
CONF_OTGW_FAIL_MINUTES = "otgw_fail_minutes"

CONF_NOTIFY_SERVICES = "notify_services"

BLOCK_ACTION_OFF = "turn_off"   # kikapcsolás = tiltás (pl. CH enable kapcsoló)
BLOCK_ACTION_ON = "turn_on"     # bekapcsolás = tiltás (pl. "inhibit" kapcsoló)

DEFAULTS = {
    CONF_METER_FACTOR: 1.0,
    CONF_HEATING_VALUE: 34.8,
    CONF_PRICE_LOW: 70.0,
    CONF_PRICE_HIGH: 210.0,
    CONF_MONTHLY_FEE: 0.0,
    CONF_EXTRA_MJ: 0.0,
    CONF_YEAR_OFFSET: 0.0,
    CONF_BLOCK_ACTION: BLOCK_ACTION_OFF,
    CONF_BLOCK_VALUE: 0.0,
    CONF_AWAY_VALUE: 16.0,
    CONF_OTGW_PORT: 6053,
    CONF_OTGW_FAIL_MINUTES: 5,
}

# Futás közben állítható értékek (switch / number entitások)
OPT_AUTO_BLOCK = "auto_block"
OPT_AWAY = "away"
OPT_NOTIFY = "notify"
OPT_AUTO_RESET = "auto_reset"
OPT_WARN_PCT = "warn_pct"
OPT_TARGET_PCT = "target_pct"
OPT_BLOCK_PCT = "block_pct"
OPT_BLOCK_BASIS = "block_basis"

RUNTIME_DEFAULTS = {
    OPT_AUTO_BLOCK: False,
    OPT_AWAY: False,
    OPT_NOTIFY: True,
    OPT_AUTO_RESET: True,
    OPT_WARN_PCT: 90.0,
    OPT_TARGET_PCT: 75.0,
    OPT_BLOCK_PCT: 100.0,
}

# Állapotkódok, súlyossági sorrendben
STATUS_BOOST = "boost"
STATUS_OK = "ok"
STATUS_WARN = "warn"
STATUS_OVER_EXPECTED = "over_expected"
STATUS_OVER = "over"
STATUS_LEVEL = {STATUS_BOOST: 0, STATUS_OK: 0, STATUS_WARN: 1, STATUS_OVER_EXPECTED: 2, STATUS_OVER: 3}
STATUS_TEXT = {
    STATUS_BOOST: "Rásegíthetsz gázzal",
    STATUS_OK: "Jó ütemben",
    STATUS_WARN: "Közel a kerethez",
    STATUS_OVER_EXPECTED: "Túllépés várható",
    STATUS_OVER: "Keret túllépve",
}

SIGNAL_UPDATE = f"{DOMAIN}_update"
SERVICE_READING = "leolvasas"
SERVICE_UNBLOCK = "tiltas_feloldasa"
SERVICE_BLOCK = "kazan_tiltasa"
SERVICE_SET_YEAR_OFFSET = "ev_eleji_fogyasztas"

MAX_DELTA_M3 = 20.0  # egy frissítésben ennél nagyobb ugrás hibának számít
