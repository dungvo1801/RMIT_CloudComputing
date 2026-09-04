import json
import os
import uuid

import boto3

from responses import ok, err
from db import user_id_from_event, log_request

s3 = boto3.client("s3")
BUCKET = os.environ["RECEIPTS_BUCKET"]


def handler(event, context):
    user_id = user_id_from_event(event)
    log_request(event, user_id)
    if not user_id:
        return err("Unauthorized", 401)

    method = event["requestContext"]["http"]["method"]
    if method == "GET":
        return view_url(event)
    return upload_url(event)


def upload_url(event):
    body = json.loads(event.get("body") or "{}")
    group_id = body.get("group_id")
    content_type = body.get("content_type", "image/jpeg")
    if not group_id:
        return err("group_id is required")

    extension = content_type.split("/")[-1]
    key = f"receipts/{group_id}/{uuid.uuid4()}.{extension}"

    url = s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": BUCKET, "Key": key, "ContentType": content_type},
        ExpiresIn=300,
    )

    return ok({"upload_url": url, "key": key})


def view_url(event):
    key = (event.get("queryStringParameters") or {}).get("key")
    if not key:
        return err("key query parameter is required")

    url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": BUCKET, "Key": key},
        ExpiresIn=300,
    )
    return ok({"view_url": url})
