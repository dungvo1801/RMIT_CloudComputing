def handler(event, context):
    """Cognito Pre Sign-up trigger: fires before a new account is created.

    Auto-confirms every sign-up and marks the email as verified, so users
    can sign in immediately after registering instead of entering an
    emailed verification code. Must return the event unchanged (aside from
    the `response` fields below) for Cognito to continue.
    """
    print(f"[COGNITO TRIGGER] PreSignUp for {event.get('userName')}")
    event["response"]["autoConfirmUser"] = True
    event["response"]["autoVerifyEmail"] = True
    return event
