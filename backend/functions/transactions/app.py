import json
import os
import time
import uuid
import datetime
import decimal

import boto3

from responses import ok, err
from db import table, user_id_from_event, path_param, log_request
from exchange import convert_amount

s3 = boto3.client("s3")
RECEIPTS_BUCKET = os.environ.get("RECEIPTS_BUCKET")


def delete_receipt_if_any(receipt_key):
    if receipt_key and RECEIPTS_BUCKET:
        s3.delete_object(Bucket=RECEIPTS_BUCKET, Key=receipt_key)


def handler(event, context):
    user_id = user_id_from_event(event)
    log_request(event, user_id)
    if not user_id:
        return err("Unauthorized", 401)

    method = event["requestContext"]["http"]["method"]
    group_id = path_param(event, "groupId")
    txn_id = path_param(event, "txnId")

    if method == "POST":
        return create_transaction(event, group_id)
    if method == "PUT" and txn_id:
        return update_transaction(event, group_id, txn_id)
    if method == "DELETE" and txn_id:
        return delete_transaction(group_id, txn_id)
    return list_transactions(group_id)


def resolve_created_at(body, fallback):
    """Let the user pick the expense's real-world date (e.g. backdating a
    receipt from last week) instead of always stamping "now". Accepts a
    plain "YYYY-MM-DD" `date` field; keeps the current time-of-day so
    same-day transactions still sort sensibly against each other.
    """
    date_str = body.get("date")
    if not date_str:
        return fallback
    try:
        datetime.datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        raise ValueError("date must be in YYYY-MM-DD format")
    time_of_day = datetime.datetime.utcnow().strftime("%H:%M:%S")
    return f"{date_str}T{time_of_day}Z"


def find_txn_item(t, group_id, txn_id):
    resp = t.query(
        KeyConditionExpression="PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues={":pk": f"GROUP#{group_id}", ":sk": "TXN#"},
    )
    for item in resp["Items"]:
        if item["txn_id"] == txn_id:
            return item
    return None


def create_transaction(event, group_id):
    body = json.loads(event.get("body") or "{}")
    payer = body.get("payer")
    original_amount = body.get("amount")
    split_among = body.get("split_among")
    is_settlement = bool(body.get("is_settlement"))
    payee = body.get("payee")

    if is_settlement:
        if not payer or not payee or original_amount is None:
            return err("payer, payee and amount are required for a settlement")
        if payer == payee:
            return err("payer and payee must be different")
        split_among = []
    elif not payer or original_amount is None or not split_among:
        return err("payer, amount and split_among are required")

    t = table()
    group_resp = t.get_item(Key={"PK": f"GROUP#{group_id}", "SK": "METADATA"})
    group = group_resp.get("Item")
    if not group:
        return err("Group not found", 404)

    base_currency = group.get("base_currency", "USD")
    currency = (body.get("currency") or base_currency).strip().upper()
    # Third-party API call (open.er-api.com): automatically converts a
    # transaction logged in a foreign currency into the group's base
    # currency, so balances/reports always add up in one currency. No-op
    # (rate 1.0, no network call) when currency == base_currency.
    converted_amount, rate = convert_amount(original_amount, currency, base_currency)

    txn_id = str(uuid.uuid4())
    ts = int(time.time() * 1000)
    now_iso = datetime.datetime.utcnow().isoformat() + "Z"
    try:
        created_at = resolve_created_at(body, now_iso)
    except ValueError as e:
        return err(str(e))

    item = {
        "PK": f"GROUP#{group_id}",
        "SK": f"TXN#{ts}#{txn_id}",
        "type": "TXN",
        "txn_id": txn_id,
        "group_id": group_id,
        "group_name": group["name"],
        "payer": payer,
        "amount": decimal.Decimal(str(converted_amount)),
        "currency": currency,
        "original_amount": decimal.Decimal(str(original_amount)),
        "exchange_rate": decimal.Decimal(str(rate)),
        "description": body.get("description", ""),
        "category": "Settlement" if is_settlement else body.get("category", "General"),
        "split_among": split_among,
        "is_settlement": is_settlement,
        "payee": payee if is_settlement else None,
        "receipt_key": body.get("receipt_key"),
        "created_at": created_at,
    }
    t.put_item(Item=item)
    item.pop("PK")
    item.pop("SK")
    return ok(item, 201)


def update_transaction(event, group_id, txn_id):
    body = json.loads(event.get("body") or "{}")

    t = table()
    existing = find_txn_item(t, group_id, txn_id)
    if not existing:
        return err("Transaction not found", 404)

    group = t.get_item(Key={"PK": f"GROUP#{group_id}", "SK": "METADATA"}).get("Item") or {}
    base_currency = group.get("base_currency", "USD")

    payer = body.get("payer", existing["payer"])
    original_amount = body.get("amount", existing.get("original_amount", existing["amount"]))
    currency = (body.get("currency") or existing.get("currency") or base_currency).strip().upper()
    split_among = body.get("split_among", existing.get("split_among", []))
    description = body.get("description", existing.get("description", ""))
    category = body.get("category", existing.get("category", "General"))
    receipt_key = body.get("receipt_key", existing.get("receipt_key"))

    if not payer or original_amount is None or not split_among:
        return err("payer, amount and split_among are required")

    # If this edit swaps in a newly-uploaded receipt, the old S3 object
    # would otherwise be orphaned with nothing left pointing at it.
    old_receipt_key = existing.get("receipt_key")
    if old_receipt_key and old_receipt_key != receipt_key:
        delete_receipt_if_any(old_receipt_key)

    try:
        created_at = resolve_created_at(body, existing.get("created_at"))
    except ValueError as e:
        return err(str(e))

    # Same third-party conversion call as create_transaction, so editing the
    # amount or currency keeps the stored base-currency amount correct.
    converted_amount, rate = convert_amount(original_amount, currency, base_currency)

    t.update_item(
        Key={"PK": existing["PK"], "SK": existing["SK"]},
        UpdateExpression=(
            "SET payer = :payer, amount = :amount, currency = :currency, "
            "original_amount = :original_amount, exchange_rate = :rate, "
            "split_among = :split_among, description = :description, "
            "category = :category, receipt_key = :receipt_key, created_at = :created_at"
        ),
        ExpressionAttributeValues={
            ":payer": payer,
            ":amount": decimal.Decimal(str(converted_amount)),
            ":currency": currency,
            ":original_amount": decimal.Decimal(str(original_amount)),
            ":rate": decimal.Decimal(str(rate)),
            ":split_among": split_among,
            ":description": description,
            ":category": category,
            ":receipt_key": receipt_key,
            ":created_at": created_at,
        },
    )

    return ok(
        {
            "txn_id": txn_id,
            "group_id": group_id,
            "payer": payer,
            "amount": converted_amount,
            "currency": currency,
            "original_amount": float(original_amount),
            "exchange_rate": rate,
            "description": description,
            "category": category,
            "split_among": split_among,
            "receipt_key": receipt_key,
            "created_at": created_at,
        }
    )


def delete_transaction(group_id, txn_id):
    t = table()
    existing = find_txn_item(t, group_id, txn_id)
    if not existing:
        return err("Transaction not found", 404)

    t.delete_item(Key={"PK": existing["PK"], "SK": existing["SK"]})
    delete_receipt_if_any(existing.get("receipt_key"))
    return ok({"txn_id": txn_id, "deleted": True})


def list_transactions(group_id):
    t = table()
    resp = t.query(
        KeyConditionExpression="PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues={":pk": f"GROUP#{group_id}", ":sk": "TXN#"},
        ScanIndexForward=False,
    )
    txns = []
    for i in resp["Items"]:
        i.pop("PK", None)
        i.pop("SK", None)
        txns.append(i)
    return ok({"transactions": txns})
