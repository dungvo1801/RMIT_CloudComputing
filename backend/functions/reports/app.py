import os
import time

import boto3

from responses import ok, err
from db import user_id_from_event, path_param, log_request

athena = boto3.client("athena")

DATABASE = os.environ["ATHENA_DATABASE"]
OUTPUT_LOCATION = os.environ["ATHENA_OUTPUT_LOCATION"]
WORKGROUP = os.environ.get("ATHENA_WORKGROUP", "primary")


def handler(event, context):
    user_id = user_id_from_event(event)
    log_request(event, user_id)
    if not user_id:
        return err("Unauthorized", 401)

    group_id = path_param(event, "groupId").replace("'", "")

    # Optional filters from the Reports tab: a specific member (matches
    # either side of the transaction - who paid, or who received a
    # settlement) and/or a date range, both applied on top of the group
    # scope below.
    qs = event.get("queryStringParameters") or {}
    member = (qs.get("member") or "").replace("'", "")
    date_from = (qs.get("date_from") or "").replace("'", "")
    date_to = (qs.get("date_to") or "").replace("'", "")

    filters = [f"group_id = '{group_id}'"]
    if member:
        filters.append(f"(payer = '{member}' OR payee = '{member}')")
    if date_from:
        filters.append(f"SUBSTR(created_at, 1, 10) >= '{date_from}'")
    if date_to:
        filters.append(f"SUBSTR(created_at, 1, 10) <= '{date_to}'")
    scope = " AND ".join(filters)

    # Settlements are payer->payee transfers that settle existing debt, not
    # new group spending - excluding them keeps "total spend" reports from
    # double-counting money that only moved between members. Older exported
    # rows predate the `is_settlement` column, so treat NULL as "not a
    # settlement" rather than dropping them from the totals.
    not_settlement = "(is_settlement IS NULL OR is_settlement = false)"

    try:
        by_category = run_query(
            f"""
            SELECT category, ROUND(SUM(amount), 2) AS total
            FROM transactions
            WHERE {scope} AND {not_settlement}
            GROUP BY category
            ORDER BY total DESC
            """
        )
        by_month = run_query(
            f"""
            SELECT year, month, ROUND(SUM(amount), 2) AS total
            FROM transactions
            WHERE {scope} AND {not_settlement}
            GROUP BY year, month
            ORDER BY year, month
            """
        )
        by_member = run_query(
            f"""
            SELECT payer, ROUND(SUM(amount), 2) AS total
            FROM transactions
            WHERE {scope} AND {not_settlement}
            GROUP BY payer
            ORDER BY total DESC
            """
        )
        settlements = run_query(
            f"""
            SELECT payer, payee, ROUND(SUM(amount), 2) AS total
            FROM transactions
            WHERE {scope} AND is_settlement = true
            GROUP BY payer, payee
            ORDER BY total DESC
            """
        )
    except Exception as e:  # noqa: BLE001
        return err(f"Analytics query failed: {e}", 502)

    return ok(
        {
            "group_id": group_id,
            "by_category": by_category,
            "by_month": by_month,
            "by_member": by_member,
            "settlements": settlements,
        }
    )


def run_query(query, max_wait_seconds=6):
    # Kept short because API Gateway hard-caps a request at ~30s regardless
    # of Lambda's own timeout, and this Lambda now runs 4 queries in
    # sequence per request - each is tiny (single group's data), so a few
    # seconds is normally more than enough.
    start = athena.start_query_execution(
        QueryString=query,
        QueryExecutionContext={"Database": DATABASE},
        ResultConfiguration={"OutputLocation": OUTPUT_LOCATION},
        WorkGroup=WORKGROUP,
    )
    query_id = start["QueryExecutionId"]

    waited = 0
    state = "RUNNING"
    while waited < max_wait_seconds:
        status = athena.get_query_execution(QueryExecutionId=query_id)
        state = status["QueryExecution"]["Status"]["State"]
        if state in ("SUCCEEDED", "FAILED", "CANCELLED"):
            break
        time.sleep(1)
        waited += 1

    if state != "SUCCEEDED":
        reason = status["QueryExecution"]["Status"].get("StateChangeReason", state)
        raise RuntimeError(reason)

    results = athena.get_query_results(QueryExecutionId=query_id)
    rows = results["ResultSet"]["Rows"]
    if not rows:
        return []

    header = [c.get("VarCharValue", "") for c in rows[0]["Data"]]
    data = []
    for row in rows[1:]:
        values = [c.get("VarCharValue") for c in row["Data"]]
        data.append(dict(zip(header, values)))
    return data
