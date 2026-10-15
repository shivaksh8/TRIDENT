"""
Step 4: Open-Meteo Weather Integration
Fetches current + 7-day rainfall forecast for Kolhapur (16.7°N, 74.24°E).
No API key required. Uses WMO Weather Interpretation Codes.

Open-Meteo API: https://open-meteo.com/en/docs
- Free tier: 10,000 requests/day
- No registration needed

Outputs:
  - data/weather_cache.json (live data or fallback if offline)
  - /api/v1/weather endpoint (in main.py)

Scenario severity mapping:
  forecast_day3_rain < 50mm  -> low     (normal conditions)
  forecast_day3_rain 50-200mm -> moderate (flood watch)
  forecast_day3_rain 200-300mm -> severe  (active flood)
  forecast_day3_rain > 300mm  -> extreme (catastrophic flood)

Flood spread rate (ticks between flood ring expansions):
  low: no spread | moderate: every 6 ticks | severe: every 3 | extreme: every 2
"""

import json
import os
import time
import requests
from datetime import datetime, timezone

CACHE_PATH = os.path.join(os.path.dirname(__file__), "weather_cache.json")

# Kolhapur coordinates
LAT = 16.7
LON = 74.24

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"

# WMO Weather Interpretation Code descriptions (relevant subset)
WMO_CODES = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Depositing rime fog",
    51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
    61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    80: "Slight showers", 81: "Moderate showers", 82: "Violent showers",
    95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Heavy thunderstorm",
}


def fetch_weather() -> dict:
    """Fetch 7-day forecast from Open-Meteo. Returns structured weather dict."""
    try:
        resp = requests.get(
            OPEN_METEO_URL,
            params={
                "latitude": LAT,
                "longitude": LON,
                "daily": "precipitation_sum,weathercode,temperature_2m_max,windspeed_10m_max",
                "hourly": "precipitation",
                "timezone": "Asia/Kolkata",
                "forecast_days": 7,
            },
            headers={"User-Agent": "FloodOps-HackathonProject/1.0"},
            timeout=15,
        )
        resp.raise_for_status()
        raw = resp.json()
        return _parse_weather(raw)
    except Exception as e:
        print(f"  Open-Meteo fetch failed: {e}")
        print("  Using monsoon-season fallback data")
        return _monsoon_fallback()


def _parse_weather(raw: dict) -> dict:
    daily = raw.get("daily", {})
    dates = daily.get("time", [])
    precip = daily.get("precipitation_sum", [])
    codes = daily.get("weathercode", [])
    temps = daily.get("temperature_2m_max", [])
    winds = daily.get("windspeed_10m_max", [])

    days = []
    for i, date in enumerate(dates):
        rain = precip[i] if i < len(precip) else 0
        code = codes[i] if i < len(codes) else 0
        days.append({
            "date": date,
            "precipitation_mm": round(float(rain or 0), 1),
            "condition": WMO_CODES.get(code, f"Code {code}"),
            "wmo_code": code,
            "temp_max_c": round(float(temps[i] or 28), 1) if i < len(temps) else 28.0,
            "wind_kmh": round(float(winds[i] or 15), 1) if i < len(winds) else 15.0,
        })

    # Day 3 forecast is the key number for scenario severity
    day3_rain = days[2]["precipitation_mm"] if len(days) > 2 else 0
    total_3day = sum(d["precipitation_mm"] for d in days[:3])

    return _build_weather_dict(days, day3_rain, total_3day, source="open-meteo-live")


def _monsoon_fallback() -> dict:
    """
    Realistic monsoon-season fallback for Kolhapur (July-August peak flood season).
    Based on historical averages: July avg ~350mm/month, peak events > 100mm/day.
    This represents the 2019-type scenario (August 8, 2019: 115mm in 24h at Kolhapur).
    """
    import random
    rng = random.Random(2019)  # fixed seed for reproducibility

    days = []
    for i in range(7):
        # Simulate approaching flood event: rain increases days 0-3, then recedes
        if i < 3:
            base = 40 + i * 90  # 40mm, 130mm, 220mm
        elif i == 3:
            base = 310  # peak flood day
        else:
            base = max(20, 310 - (i - 3) * 80)  # recession

        precip = round(base + rng.uniform(-15, 15), 1)
        days.append({
            "date": f"2019-08-0{i+5}",  # Aug 5-11, 2019 flood event dates
            "precipitation_mm": precip,
            "condition": "Heavy rain" if precip > 100 else "Moderate rain" if precip > 50 else "Slight rain",
            "wmo_code": 65 if precip > 100 else 63 if precip > 50 else 61,
            "temp_max_c": round(26.5 - i * 0.3, 1),
            "wind_kmh": round(25 + rng.uniform(-5, 10), 1),
        })

    day3_rain = days[2]["precipitation_mm"]
    total_3day = sum(d["precipitation_mm"] for d in days[:3])

    return _build_weather_dict(days, day3_rain, total_3day, source="historical-2019-fallback")


def _build_weather_dict(days: list, day3_rain: float, total_3day: float, source: str) -> dict:
    # Determine scenario severity
    if day3_rain > 300:
        severity = "extreme"
        flood_spread_ticks = 2
        alert_level = "RED"
    elif day3_rain > 200:
        severity = "severe"
        flood_spread_ticks = 3
        alert_level = "ORANGE"
    elif day3_rain > 50:
        severity = "moderate"
        flood_spread_ticks = 6
        alert_level = "YELLOW"
    else:
        severity = "low"
        flood_spread_ticks = 0  # no spread
        alert_level = "GREEN"

    return {
        "location": "Kolhapur, Maharashtra",
        "lat": LAT,
        "lon": LON,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "forecast": days,
        "summary": {
            "day3_precipitation_mm": day3_rain,
            "total_3day_mm": round(total_3day, 1),
            "scenario_severity": severity,
            "flood_spread_ticks": flood_spread_ticks,
            "alert_level": alert_level,
            "narrative": _severity_narrative(severity, day3_rain),
        },
    }


def _severity_narrative(severity: str, day3_rain: float) -> str:
    if severity == "extreme":
        return (f"Catastrophic rainfall forecast: {day3_rain:.0f}mm on Day 3. "
                "Rapid inundation expected across Panchaganga floodplain. "
                "All ground operations severely restricted.")
    elif severity == "severe":
        return (f"Heavy rainfall forecast: {day3_rain:.0f}mm on Day 3. "
                "Significant flooding expected. Boats essential for rescue operations.")
    elif severity == "moderate":
        return (f"Moderate rainfall: {day3_rain:.0f}mm on Day 3. "
                "Flood watch active. Low-lying areas at risk.")
    else:
        return f"Low rainfall ({day3_rain:.0f}mm). Normal operations possible."


def load_or_fetch(max_age_seconds: int = 3600) -> dict:
    """Load from cache if fresh, otherwise fetch live."""
    if os.path.exists(CACHE_PATH):
        try:
            with open(CACHE_PATH) as f:
                cached = json.load(f)
            fetched_at = cached.get("fetched_at", "")
            if fetched_at:
                age = time.time() - datetime.fromisoformat(fetched_at.replace("Z", "+00:00")).timestamp()
                if age < max_age_seconds:
                    return cached
        except Exception:
            pass

    weather = fetch_weather()
    try:
        with open(CACHE_PATH, "w") as f:
            json.dump(weather, f, indent=2)
    except Exception as e:
        print(f"  Warning: could not cache weather data: {e}")
    return weather


if __name__ == "__main__":
    print(f"Fetching weather for Kolhapur ({LAT}°N, {LON}°E)...")
    weather = fetch_weather()

    with open(CACHE_PATH, "w") as f:
        json.dump(weather, f, indent=2)

    summary = weather["summary"]
    print(f"\nWeather summary:")
    print(f"  Source: {weather['source']}")
    print(f"  Day 3 rainfall: {summary['day3_precipitation_mm']}mm")
    print(f"  Alert level: {summary['alert_level']}")
    print(f"  Scenario severity: {summary['scenario_severity']}")
    print(f"  Flood spread: every {summary['flood_spread_ticks']} ticks (0=none)")
    print(f"  Narrative: {summary['narrative']}")
    print(f"\nForecast:")
    for d in weather["forecast"]:
        bar = "█" * int(d["precipitation_mm"] / 20)
        print(f"  {d['date']}: {d['precipitation_mm']:6.1f}mm {bar} ({d['condition']})")

    print(f"\nCached to {CACHE_PATH}")
