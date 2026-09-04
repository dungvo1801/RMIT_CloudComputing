import json
import urllib.request

EXCHANGE_API_BASE = "https://open.er-api.com/v6/latest"


def convert_amount(amount, from_currency, to_currency):
    """Convert `amount` from `from_currency` to `to_currency` using the free,
    keyless Open Exchange Rate API (https://www.exchangerate-api.com/docs/free).

    Returns (converted_amount, rate_used). Falls back to a 1:1 rate if the
    third-party API is unreachable, so a transient outage never blocks a
    user from recording an expense.
    """
    if from_currency == to_currency:
        return round(float(amount), 2), 1.0

    url = f"{EXCHANGE_API_BASE}/{from_currency}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "SplitEase/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
        rate = float(data["rates"][to_currency])
    except Exception:  # noqa: BLE001
        rate = 1.0

    return round(float(amount) * rate, 2), rate
