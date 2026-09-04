def compute_balances(transactions, member_ids):
    """Net balance per member. Positive = is owed money, negative = owes money.

    A "settlement" record (`is_settlement=True`) is a direct payer->payee
    transfer that settles real debt (partial or full) rather than a shared
    expense: it has no split, so it moves balance from payer to payee
    one-for-one instead of dividing it across the group.
    """
    balance = {m: 0.0 for m in member_ids}
    for t in transactions:
        amount = float(t["amount"])

        if t.get("is_settlement"):
            payer = t["payer"]
            payee = t["payee"]
            balance[payer] = balance.get(payer, 0.0) + amount
            balance[payee] = balance.get(payee, 0.0) - amount
            continue

        payer = t["payer"]
        split_among = t.get("split_among") or member_ids
        share = amount / len(split_among)
        balance[payer] = balance.get(payer, 0.0) + amount
        for m in split_among:
            balance[m] = balance.get(m, 0.0) - share
    return {m: round(b, 2) for m, b in balance.items()}


def simplify_debts(balances):
    """Greedy minimum-transaction settlement: who should pay whom, how much."""
    creditors = sorted(
        [[m, b] for m, b in balances.items() if b > 0.01], key=lambda x: -x[1]
    )
    debtors = sorted(
        [[m, b] for m, b in balances.items() if b < -0.01], key=lambda x: x[1]
    )

    settlements = []
    i = j = 0
    while i < len(debtors) and j < len(creditors):
        debtor, debtor_amt = debtors[i]
        creditor, creditor_amt = creditors[j]
        pay = min(-debtor_amt, creditor_amt)
        settlements.append({"from": debtor, "to": creditor, "amount": round(pay, 2)})
        debtors[i][1] += pay
        creditors[j][1] -= pay
        if abs(debtors[i][1]) < 0.01:
            i += 1
        if abs(creditors[j][1]) < 0.01:
            j += 1
    return settlements
