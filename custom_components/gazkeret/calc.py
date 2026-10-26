"""Tiszta számítási logika (Home Assistant nélkül is tesztelhető)."""
from __future__ import annotations

import calendar
from datetime import date, timedelta

from .const import (
    ANNUAL_MJ,
    MONTHLY_MJ,
    STATUS_BOOST,
    STATUS_OK,
    STATUS_OVER,
    STATUS_OVER_EXPECTED,
    STATUS_TEXT,
    STATUS_WARN,
)

HU_MONTHS = ["jan", "feb", "márc", "ápr", "máj", "jún", "júl", "aug", "szept", "okt", "nov", "dec"]


def add_month(d: date) -> date:
    y, m = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def daterange(a: date, b: date):
    d = a
    while d <= b:
        yield d
        d += timedelta(days=1)


def benefit_year_start(d: date) -> date:
    """Kedvezményes év: aug. 1 – júl. 31."""
    return date(d.year if d.month >= 8 else d.year - 1, 8, 1)


class Quota:
    def __init__(self, heating_value: float, extra_mj: float) -> None:
        self.hv = max(heating_value, 1.0)
        self.scale = (ANNUAL_MJ + max(extra_mj, 0.0)) / ANNUAL_MJ

    def month_m3(self, year: int, month: int) -> float:
        return MONTHLY_MJ[month] * self.scale / self.hv

    def day_m3(self, d: date) -> float:
        return self.month_m3(d.year, d.month) / calendar.monthrange(d.year, d.month)[1]

    def range_m3(self, a: date, b: date) -> float:
        return sum(self.day_m3(d) for d in daterange(a, b)) if a <= b else 0.0

    @property
    def year_m3(self) -> float:
        return ANNUAL_MJ * self.scale / self.hv


def period_bounds(today: date, last_reading: date | None) -> tuple[date, date, bool]:
    """Elszámolási időszak: utolsó leolvasástól egy hónapig. Ha nincs leolvasás: naptári hónap.

    Visszaad: (kezdet, vég, leolvasás_esedékes_vagy_elmaradt)
    """
    if last_reading is None:
        start = today.replace(day=1)
        end = add_month(start) - timedelta(days=1)
        return start, end, False
    start = last_reading
    end = add_month(start) - timedelta(days=1)
    overdue = False
    while today > end:
        overdue = True
        start = end + timedelta(days=1)
        end = add_month(start) - timedelta(days=1)
    return start, end, overdue


def cost(m3: float, quota: float, low: float, high: float) -> float:
    return min(m3, quota) * low + max(0.0, m3 - quota) * high


def compute(
    today: date,
    daily: dict[str, float],
    last_reading: date | None,
    *,
    heating_value: float,
    extra_mj: float,
    price_low: float,
    price_high: float,
    monthly_fee: float,
    year_offset: float,
    warn_pct: float,
    target_pct: float,
    tracking_start: date | None,
) -> dict:
    q = Quota(heating_value, extra_mj)

    def c(d: date) -> float:
        return float(daily.get(d.isoformat(), 0.0))

    tracked = {date.fromisoformat(k) for k in daily}
    if tracking_start is None:
        tracking_start = min(tracked) if tracked else today

    # Átlag az utolsó 7 lezárt napból (csak ahol volt mérés)
    past = [today - timedelta(days=i) for i in range(1, 8)]
    past = [d for d in past if d >= tracking_start]
    avg7 = sum(c(d) for d in past) / len(past) if past else None

    # 30 napos arány a jelleggörbéhez képest (évesítéshez)
    p30 = [today - timedelta(days=i) for i in range(1, 31) if today - timedelta(days=i) >= tracking_start]
    q30 = sum(q.day_m3(d) for d in p30)
    ratio30 = (sum(c(d) for d in p30) / q30) if (len(p30) >= 3 and q30 > 0) else 1.0

    def daily_rate(d: date) -> float:
        """Előrejelzett napi fogyasztás egy jövőbeli napra."""
        if avg7 is None:
            return q.day_m3(d) * ratio30
        # rövid távon a 7 napos átlag, a jelleggörbe alakjával korrigálva
        base_q = q.day_m3(today)
        shape = q.day_m3(d) / base_q if base_q > 0 else 1.0
        return avg7 * shape

    today_used = c(today)

    # --- Elszámolási (leolvasási) időszak ---
    ps, pe, overdue = period_bounds(today, last_reading)
    if last_reading is None and tracking_start > ps:
        ps = tracking_start  # a követés előtti napokról nincs adat, a keretet is onnan számoljuk
    p_quota = q.range_m3(ps, pe)
    p_quota_to_date = q.range_m3(ps, today)
    p_used = sum(c(d) for d in daterange(ps, today))
    days_left_incl = (pe - today).days + 1
    p_future = sum(daily_rate(d) for d in daterange(today + timedelta(days=1), pe))
    p_proj = p_used + max(0.0, (avg7 or q.day_m3(today)) - today_used) * 0.5 + p_future
    used_before_today = p_used - today_used
    allow_today = max(0.0, (p_quota - used_before_today) / days_left_incl)
    target_today = max(0.0, (p_quota * target_pct / 100 - used_before_today) / days_left_incl)
    p_remaining = p_quota - p_used

    # --- Naptári hónap ---
    ms = today.replace(day=1)
    me = add_month(ms) - timedelta(days=1)
    m_quota = q.month_m3(today.year, today.month)
    m_used = sum(c(d) for d in daterange(ms, today))
    m_proj = m_used + sum(daily_rate(d) for d in daterange(today + timedelta(days=1), me))

    # --- Kedvezményes év (aug 1 – júl 31) ---
    ys = benefit_year_start(today)
    ye = date(ys.year + 1, 7, 31)
    y_quota = q.year_m3
    y_used = sum(c(d) for d in daterange(max(ys, tracking_start), today)) + year_offset
    y_rest_quota = q.range_m3(today + timedelta(days=1), ye)
    y_proj = y_used + y_rest_quota * ratio30
    y_bill = cost(y_proj, y_quota, price_low, price_high) + 12 * monthly_fee
    y_target = y_quota * target_pct / 100

    months = []
    d = ys
    while d <= ye:
        mend = add_month(d) - timedelta(days=1)
        used = (sum(c(x) for x in daterange(d, min(mend, today)))
                if d <= today and mend >= tracking_start else None)
        partial = d <= today and (d < tracking_start)
        months.append({
            "label": HU_MONTHS[d.month - 1],
            "month": d.strftime("%Y-%m"),
            "quota": round(q.month_m3(d.year, d.month), 1),
            "used": None if used is None else round(used, 1),
            "partial": partial,
            "current": d.year == today.year and d.month == today.month,
        })
        d = mend + timedelta(days=1)

    last30 = [
        {"date": x.isoformat(), "used": round(c(x), 2), "quota": round(q.day_m3(x), 2),
         "tracked": x >= tracking_start}
        for x in (today - timedelta(days=i) for i in range(29, -1, -1))
    ]

    # --- Állapot ---
    warn = warn_pct / 100
    if p_used >= p_quota:
        status = STATUS_OVER
    elif p_proj > p_quota:
        status = STATUS_OVER_EXPECTED
    elif p_proj > p_quota * warn:
        status = STATUS_WARN
    elif p_proj < p_quota * target_pct / 100:
        status = STATUS_BOOST
    else:
        status = STATUS_OK

    p_end_txt = f"{HU_MONTHS[pe.month - 1]}. {pe.day}"
    if status == STATUS_OVER:
        advice = (f"Elfogyott az olcsó keret ({p_used - p_quota:.0f} m³-rel túl). "
                  f"Minden további m³ {price_high:.0f} Ft – fűts klímával.")
    elif status == STATUS_OVER_EXPECTED:
        advice = (f"A mostani ütemben kb. {p_proj - p_quota:.0f} m³-rel túllépnéd a keretet "
                  f"{p_end_txt}-ig. Ma legfeljebb {allow_today:.1f} m³ fogyjon.")
    elif status == STATUS_WARN:
        advice = (f"Közel vagy a kerethez: még {p_remaining:.0f} m³ olcsó gáz van {p_end_txt}-ig. "
                  f"Inkább a klíma fűtsön, ma max {allow_today:.1f} m³.")
    elif status == STATUS_BOOST:
        advice = (f"Bőven van olcsó gáz: {p_remaining:.0f} m³ {p_end_txt}-ig. "
                  f"Nyugodtan rásegíthetsz gázzal, ma kb. {target_today:.1f} m³ a cél.")
    else:
        advice = (f"Jó ütemben haladsz. Még {p_remaining:.0f} m³ olcsó gáz van {p_end_txt}-ig, "
                  f"ma legfeljebb {allow_today:.1f} m³ fogyhat.")

    r = lambda v, n=1: round(v, n)  # noqa: E731
    return {
        "status": status,
        "status_text": STATUS_TEXT[status],
        "advice": advice,
        "today": r(today_used, 2),
        "yesterday": r(c(today - timedelta(days=1)), 2),
        "avg7": None if avg7 is None else r(avg7, 2),
        "p_start": ps.isoformat(),
        "p_end": pe.isoformat(),
        "p_days_left": days_left_incl,
        "p_used": r(p_used),
        "p_quota": r(p_quota),
        "p_quota_to_date": r(p_quota_to_date),
        "p_remaining": r(p_remaining),
        "p_pct": r(p_used / p_quota * 100 if p_quota else 0),
        "p_proj": r(p_proj),
        "p_proj_pct": r(p_proj / p_quota * 100 if p_quota else 0),
        "p_overrun": r(max(0.0, p_used - p_quota)),
        "p_target": r(p_quota * target_pct / 100),
        "p_cost": round(cost(p_used, p_quota, price_low, price_high)),
        "p_bill": round(cost(p_proj, p_quota, price_low, price_high) + monthly_fee),
        "allow_today": r(allow_today, 2),
        "target_today": r(target_today, 2),
        "reading_overdue": overdue,
        "m_used": r(m_used),
        "m_quota": r(m_quota),
        "m_pct": r(m_used / m_quota * 100 if m_quota else 0),
        "m_proj": r(m_proj),
        "y_start": ys.isoformat(),
        "y_end": ye.isoformat(),
        "y_used": r(y_used),
        "y_quota": r(y_quota),
        "y_pct": r(y_used / y_quota * 100),
        "y_proj": r(y_proj),
        "y_proj_pct": r(y_proj / y_quota * 100),
        "y_bill": round(y_bill),
        "y_target": r(y_target),
        "y_cheap_left_to_target": r(max(0.0, y_target - y_proj)),
        "ratio30": r(ratio30, 2),
        "tracking_start": tracking_start.isoformat(),
        "months": months,
        "last30": last30,
    }
