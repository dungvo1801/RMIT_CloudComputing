import time
import decimal

from responses import ok, err
from db import users_table, user_id_from_event, log_request

# SECURITY NOTE: the actual password change (verifying the old password,
# setting the new one) happens client-side directly against Cognito, via
# CognitoUser.changePassword() in frontend/js/auth.js - Cognito's SRP
# protocol means the plaintext password is never sent to, or seen by, our
# own backend. This endpoint is called *after* Cognito confirms the change
# succeeded, purely to timestamp it on the user's profile row. It never
# receives or stores the password itself, old or new.
PASSWORD_PLACEHOLDER = "(managed by AWS Cognito - not stored here)"


def handler(event, context):
    email = user_id_from_event(event)
    log_request(event, email)
    if not email:
        return err("Unauthorized", 401)

    username = email.split("@")[0]
    now = decimal.Decimal(str(int(time.time())))

    # `email` is the table's partition key - it's already set via `Key`
    # below and can't also appear in an UpdateExpression's SET clause.
    users_table().update_item(
        Key={"email": email},
        UpdateExpression=(
            "SET username = if_not_exists(username, :username), "
            "password = if_not_exists(password, :password), "
            "password_last_changed_at = :now"
        ),
        ExpressionAttributeValues={
            ":username": username,
            ":password": PASSWORD_PLACEHOLDER,
            ":now": now,
        },
    )

    return ok({"email": email, "password_last_changed_at": int(now)})
