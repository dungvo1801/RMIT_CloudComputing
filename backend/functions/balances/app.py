from responses import ok, err
from db import table, user_id_from_event, path_param, log_request
from split import compute_balances, simplify_debts


def handler(event, context):
    user_id = user_id_from_event(event)
    log_request(event, user_id)
    if not user_id:
        return err("Unauthorized", 401)

    group_id = path_param(event, "groupId")
    t = table()

    group_resp = t.get_item(Key={"PK": f"GROUP#{group_id}", "SK": "METADATA"})
    group = group_resp.get("Item")
    if not group:
        return err("Group not found", 404)

    txn_resp = t.query(
        KeyConditionExpression="PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues={":pk": f"GROUP#{group_id}", ":sk": "TXN#"},
    )
    transactions = [
        {
            "payer": i["payer"],
            "amount": i["amount"],
            "split_among": i.get("split_among", []),
            "is_settlement": i.get("is_settlement", False),
            "payee": i.get("payee"),
        }
        for i in txn_resp["Items"]
    ]

    balances = compute_balances(transactions, group["members"])
    settlements = simplify_debts(balances)

    return ok({"group_id": group_id, "balances": balances, "settlements": settlements})
