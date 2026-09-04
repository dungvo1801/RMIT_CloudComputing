import os
import time
import uuid

import boto3

from responses import ok, err
from db import (
    table,
    user_id_from_event,
    path_param,
    index_member_if_email,
    unindex_member_if_email,
    looks_like_email,
    log_request,
)

s3 = boto3.client("s3")
RECEIPTS_BUCKET = os.environ.get("RECEIPTS_BUCKET")


def handler(event, context):
    method = event["requestContext"]["http"]["method"]
    user_id = user_id_from_event(event)
    log_request(event, user_id)
    if not user_id:
        return err("Unauthorized", 401)

    if method == "POST":
        return create_group(event, user_id)
    if method == "DELETE":
        return delete_group(event, user_id)
    if method == "PUT":
        return rename_group(event, user_id)
    if path_param(event, "groupId"):
        return get_group(event, user_id)
    return list_groups(event, user_id)


def create_group(event, user_id):
    import json

    body = json.loads(event.get("body") or "{}")
    name = (body.get("name") or "").strip()
    if not name:
        return err("Group name is required")

    creator_name = body.get("creator_name") or user_id
    base_currency = (body.get("base_currency") or "USD").strip().upper()
    group_id = str(uuid.uuid4())
    now = int(time.time())
    members = list(dict.fromkeys([creator_name] + body.get("members", [])))

    t = table()
    t.put_item(
        Item={
            "PK": f"GROUP#{group_id}",
            "SK": "METADATA",
            "type": "GROUP",
            "group_id": group_id,
            "name": name,
            "created_by": user_id,
            "created_at": now,
            "members": members,
            "base_currency": base_currency,
        }
    )
    t.put_item(
        Item={
            "PK": f"USER#{user_id}",
            "SK": f"GROUP#{group_id}",
            "type": "USER_GROUP",
            "group_id": group_id,
            "group_name": name,
        }
    )
    # Any other member whose name happens to be a real account's email also
    # gets indexed, so this group shows up in *their* group list too.
    for m in members:
        if m != user_id:
            index_member_if_email(t, m, group_id, name)

    return ok(
        {"group_id": group_id, "name": name, "members": members, "base_currency": base_currency},
        201,
    )


def list_groups(event, user_id):
    t = table()
    resp = t.query(
        KeyConditionExpression="PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues={":pk": f"USER#{user_id}", ":sk": "GROUP#"},
    )
    groups = [
        {"group_id": i["group_id"], "name": i["group_name"]} for i in resp["Items"]
    ]
    return ok({"groups": groups})


def delete_group(event, user_id):
    group_id = path_param(event, "groupId")
    t = table()

    group_resp = t.get_item(Key={"PK": f"GROUP#{group_id}", "SK": "METADATA"})
    item = group_resp.get("Item")
    if not item:
        return err("Group not found", 404)
    if item.get("created_by") != user_id:
        return err("Only the group creator can delete this group", 403)

    resp = t.query(
        KeyConditionExpression="PK = :pk",
        ExpressionAttributeValues={":pk": f"GROUP#{group_id}"},
    )
    if RECEIPTS_BUCKET:
        for i in resp["Items"]:
            receipt_key = i.get("receipt_key")
            if receipt_key:
                s3.delete_object(Bucket=RECEIPTS_BUCKET, Key=receipt_key)

    with t.batch_writer() as batch:
        for i in resp["Items"]:
            batch.delete_item(Key={"PK": i["PK"], "SK": i["SK"]})
        batch.delete_item(Key={"PK": f"USER#{user_id}", "SK": f"GROUP#{group_id}"})
        # Also drop the index row for every other member who was linked to
        # a real account by email (see index_member_if_email).
        for m in item.get("members", []):
            if m != user_id:
                unindex_member_if_email(t, m, group_id)

    return ok({"group_id": group_id, "deleted": True})


def rename_group(event, user_id):
    import json

    group_id = path_param(event, "groupId")
    body = json.loads(event.get("body") or "{}")
    new_name = (body.get("name") or "").strip()
    if not new_name:
        return err("Group name is required")

    t = table()
    resp = t.get_item(Key={"PK": f"GROUP#{group_id}", "SK": "METADATA"})
    item = resp.get("Item")
    if not item:
        return err("Group not found", 404)
    if item.get("created_by") != user_id:
        return err("Only the group creator can rename this group", 403)

    t.update_item(
        Key={"PK": f"GROUP#{group_id}", "SK": "METADATA"},
        UpdateExpression="SET #n = :n",
        ExpressionAttributeNames={"#n": "name"},
        ExpressionAttributeValues={":n": new_name},
    )
    t.update_item(
        Key={"PK": f"USER#{user_id}", "SK": f"GROUP#{group_id}"},
        UpdateExpression="SET group_name = :n",
        ExpressionAttributeValues={":n": new_name},
    )
    for m in item.get("members", []):
        if m != user_id and looks_like_email(m):
            t.update_item(
                Key={"PK": f"USER#{m}", "SK": f"GROUP#{group_id}"},
                UpdateExpression="SET group_name = :n",
                ExpressionAttributeValues={":n": new_name},
            )

    # Cascade to the group_name copy embedded in every transaction item, so
    # the analytics export (and anything else reading it) never sees a stale name.
    txn_resp = t.query(
        KeyConditionExpression="PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues={":pk": f"GROUP#{group_id}", ":sk": "TXN#"},
    )
    for txn in txn_resp["Items"]:
        t.update_item(
            Key={"PK": txn["PK"], "SK": txn["SK"]},
            UpdateExpression="SET group_name = :n",
            ExpressionAttributeValues={":n": new_name},
        )

    return ok({"group_id": group_id, "name": new_name})


def get_group(event, user_id):
    group_id = path_param(event, "groupId")
    t = table()
    resp = t.get_item(Key={"PK": f"GROUP#{group_id}", "SK": "METADATA"})
    item = resp.get("Item")
    if not item:
        return err("Group not found", 404)
    return ok(
        {
            "group_id": item["group_id"],
            "name": item["name"],
            "members": item["members"],
            "created_by": item["created_by"],
            "base_currency": item.get("base_currency", "USD"),
        }
    )
