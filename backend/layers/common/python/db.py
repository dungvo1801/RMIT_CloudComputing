import os
import boto3

_dynamodb = boto3.resource("dynamodb")
TABLE_NAME = os.environ.get("TABLE_NAME")
USERS_TABLE_NAME = os.environ.get("USERS_TABLE_NAME")


def table():
    return _dynamodb.Table(TABLE_NAME)


def users_table():
    return _dynamodb.Table(USERS_TABLE_NAME)


def user_id_from_event(event):
    """Identify the caller from the Cognito claims the HTTP API JWT authorizer injects.

    Prefers 'email' over 'sub': email is human-readable, so it doubles as a
    sensible default display name when a user is auto-added to a group they
    create, whereas 'sub' is an opaque UUID.
    """
    try:
        claims = event["requestContext"]["authorizer"]["jwt"]["claims"]
        return claims.get("email") or claims.get("sub")
    except KeyError:
        return None


def path_param(event, name):
    return (event.get("pathParameters") or {}).get(name)


def log_request(event, user_id=None):
    """Print the HTTP method/path/caller to CloudWatch Logs at the top of
    every handler - by default Lambda's own START/END/REPORT lines say
    nothing about *what* a request actually was, which makes two
    back-to-back invocations (e.g. a POST immediately followed by the
    frontend's GET to refresh its list) indistinguishable in the console.
    This one line makes each invocation's purpose visible without opening
    the request payload.
    """
    http = event.get("requestContext", {}).get("http", {})
    print(f"[REQUEST] {http.get('method', '?')} {http.get('path', '?')} caller={user_id}")


def looks_like_email(name):
    return isinstance(name, str) and "@" in name


def index_member_if_email(t, member_name, group_id, group_name):
    """If a member's name happens to be a real account's email, give that
    account a USER#<email>/GROUP#<id> index row too, so the group shows up
    in *their* "my groups" list when they log in - not just the creator's.
    """
    if looks_like_email(member_name):
        t.put_item(
            Item={
                "PK": f"USER#{member_name}",
                "SK": f"GROUP#{group_id}",
                "type": "USER_GROUP",
                "group_id": group_id,
                "group_name": group_name,
            }
        )


def unindex_member_if_email(t, member_name, group_id):
    if looks_like_email(member_name):
        t.delete_item(Key={"PK": f"USER#{member_name}", "SK": f"GROUP#{group_id}"})
