import json

from responses import ok, err
from db import (
    table,
    user_id_from_event,
    path_param,
    index_member_if_email,
    unindex_member_if_email,
    log_request,
)


def handler(event, context):
    user_id = user_id_from_event(event)
    log_request(event, user_id)
    if not user_id:
        return err("Unauthorized", 401)

    method = event["requestContext"]["http"]["method"]
    if method == "DELETE":
        return remove_member(event)
    if method == "PUT":
        return rename_member(event)
    return add_member(event)


def add_member(event):
    group_id = path_param(event, "groupId")
    body = json.loads(event.get("body") or "{}")
    member_name = (body.get("name") or "").strip()
    if not member_name:
        return err("Member name is required")

    t = table()
    resp = t.get_item(Key={"PK": f"GROUP#{group_id}", "SK": "METADATA"})
    item = resp.get("Item")
    if not item:
        return err("Group not found", 404)

    members = item.get("members", [])
    if member_name not in members:
        members.append(member_name)
        t.update_item(
            Key={"PK": f"GROUP#{group_id}", "SK": "METADATA"},
            UpdateExpression="SET members = :m",
            ExpressionAttributeValues={":m": members},
        )
        # If this member's name is a real account's email, that account
        # should see this group in their own group list too.
        index_member_if_email(t, member_name, group_id, item["name"])

    return ok({"group_id": group_id, "members": members})


def remove_member(event):
    group_id = path_param(event, "groupId")
    body = json.loads(event.get("body") or "{}")
    member_name = (body.get("name") or "").strip()
    if not member_name:
        return err("Member name is required")

    t = table()
    group_item = t.get_item(Key={"PK": f"GROUP#{group_id}", "SK": "METADATA"}).get("Item")
    if not group_item:
        return err("Group not found", 404)

    txn_resp = t.query(
        KeyConditionExpression="PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues={":pk": f"GROUP#{group_id}", ":sk": "TXN#"},
    )
    in_use = any(
        txn["payer"] == member_name or member_name in txn.get("split_among", [])
        for txn in txn_resp["Items"]
    )
    if in_use:
        return err(
            "Cannot remove a member who is referenced in existing transactions"
        )

    members = [m for m in group_item.get("members", []) if m != member_name]
    t.update_item(
        Key={"PK": f"GROUP#{group_id}", "SK": "METADATA"},
        UpdateExpression="SET members = :m",
        ExpressionAttributeValues={":m": members},
    )
    # Never drop the creator's own index row - their access to a group they
    # created doesn't depend on what display name they've labeled themselves.
    if member_name != group_item.get("created_by"):
        unindex_member_if_email(t, member_name, group_id)
    return ok({"group_id": group_id, "members": members})


def rename_member(event):
    group_id = path_param(event, "groupId")
    body = json.loads(event.get("body") or "{}")
    old_name = (body.get("old_name") or "").strip()
    new_name = (body.get("new_name") or "").strip()
    if not old_name or not new_name:
        return err("old_name and new_name are required")

    t = table()
    group_item = t.get_item(Key={"PK": f"GROUP#{group_id}", "SK": "METADATA"}).get("Item")
    if not group_item:
        return err("Group not found", 404)

    members = group_item.get("members", [])
    if old_name not in members:
        return err("Member not found", 404)
    if new_name in members and new_name != old_name:
        return err("A member with that name already exists")

    members = [new_name if m == old_name else m for m in members]
    t.update_item(
        Key={"PK": f"GROUP#{group_id}", "SK": "METADATA"},
        UpdateExpression="SET members = :m",
        ExpressionAttributeValues={":m": members},
    )
    # Same protection as remove_member: renaming the creator's own display
    # label must never remove their creator-level index row.
    if old_name != group_item.get("created_by"):
        unindex_member_if_email(t, old_name, group_id)
    index_member_if_email(t, new_name, group_id, group_item["name"])

    txn_resp = t.query(
        KeyConditionExpression="PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues={":pk": f"GROUP#{group_id}", ":sk": "TXN#"},
    )
    for txn in txn_resp["Items"]:
        changed = False
        if txn["payer"] == old_name:
            txn["payer"] = new_name
            changed = True
        split_among = txn.get("split_among", [])
        if old_name in split_among:
            txn["split_among"] = [new_name if m == old_name else m for m in split_among]
            changed = True
        if changed:
            t.update_item(
                Key={"PK": txn["PK"], "SK": txn["SK"]},
                UpdateExpression="SET payer = :p, split_among = :s",
                ExpressionAttributeValues={":p": txn["payer"], ":s": txn["split_among"]},
            )

    return ok({"group_id": group_id, "members": members})
