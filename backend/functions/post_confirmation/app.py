import os
import time

import boto3

USERS_TABLE_NAME = os.environ["USERS_TABLE_NAME"]
dynamodb = boto3.resource("dynamodb")

# SECURITY NOTE: this table intentionally never stores a real credential.
# AWS Cognito is the single source of truth for authentication (hashed,
# salted, managed by AWS) - this profile table exists only to hold
# non-secret display fields (username, email) alongside the account,
# requested for the assignment's "users table" requirement. The `password`
# column always holds this fixed placeholder, never user input, so a leak
# of this table can never expose a real credential.
PASSWORD_PLACEHOLDER = "(managed by AWS Cognito - not stored here)"


def handler(event, context):
    """Cognito Post Confirmation trigger: fires automatically right after a
    user confirms their sign-up. Must return the event unchanged for Cognito
    to continue the sign-up flow.
    """
    print(f"[COGNITO TRIGGER] PostConfirmation for {event.get('userName')}")
    attributes = event.get("request", {}).get("userAttributes", {})
    email = attributes.get("email")
    if not email:
        return event

    username = email.split("@")[0]

    table = dynamodb.Table(USERS_TABLE_NAME)
    table.put_item(
        Item={
            "email": email,
            "username": username,
            "password": PASSWORD_PLACEHOLDER,
            "cognito_sub": event.get("userName"),
            "created_at": int(time.time()),
        }
    )

    return event
