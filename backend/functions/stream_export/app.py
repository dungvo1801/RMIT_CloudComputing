import json
import os
import decimal

import boto3
from boto3.dynamodb.types import TypeDeserializer

s3 = boto3.client("s3")
BUCKET = os.environ["ANALYTICS_BUCKET"]
deserializer = TypeDeserializer()


class DecimalEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, decimal.Decimal):
            return float(o)
        return super().default(o)


def deserialize(image):
    return {k: deserializer.deserialize(v) for k, v in image.items()}


def handler(event, context):
    for record in event.get("Records", []):
        event_name = record["eventName"]
        print(f"[STREAM] {event_name} on {record['dynamodb'].get('Keys', {})}")

        if event_name == "REMOVE":
            old_image = record["dynamodb"].get("OldImage")
            if not old_image:
                continue
            item = deserialize(old_image)
            if item.get("type") != "TXN":
                continue
            s3.delete_object(Bucket=BUCKET, Key=f"transactions/{item.get('txn_id')}.json")
            print(f"[STREAM] deleted S3 object transactions/{item.get('txn_id')}.json")
            continue

        if event_name not in ("INSERT", "MODIFY"):
            continue

        new_image = record["dynamodb"].get("NewImage")
        if not new_image:
            continue

        item = deserialize(new_image)
        if item.get("type") != "TXN":
            continue

        created_at = item.get("created_at", "")
        year = created_at[0:4] if len(created_at) >= 7 else "unknown"
        month = created_at[5:7] if len(created_at) >= 7 else "unknown"

        record_body = {
            "txn_id": item.get("txn_id"),
            "group_id": item.get("group_id"),
            "group_name": item.get("group_name"),
            "payer": item.get("payer"),
            "amount": float(item.get("amount", 0)),
            "currency": item.get("currency", "USD"),
            "original_amount": float(item.get("original_amount", item.get("amount", 0))),
            "exchange_rate": float(item.get("exchange_rate", 1.0)),
            "description": item.get("description", ""),
            "category": item.get("category", "General"),
            "split_among": item.get("split_among", []),
            "is_settlement": bool(item.get("is_settlement", False)),
            "payee": item.get("payee"),
            "created_at": created_at,
            "year": year,
            "month": month,
        }

        key = f"transactions/{item.get('txn_id')}.json"
        s3.put_object(
            Bucket=BUCKET,
            Key=key,
            Body=json.dumps(record_body, cls=DecimalEncoder) + "\n",
            ContentType="application/json",
        )
        print(f"[STREAM] wrote S3 object {key} (event={event_name})")

    return {"statusCode": 200}
