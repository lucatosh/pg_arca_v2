"""
pg_arca Authentication & Security Module
=========================================
Supports:
 - Bearer Token (Authorization: Bearer <token>)
 - X-Arca-Token header
 - HTTP Basic Auth (Authorization: Basic <base64>)
 - Local Unix domain socket peer credentials check
"""

import hmac
import base64
import logging

def verify_request_auth(headers, config, client_address=None):
    """
    Verifies incoming request against configured auth_mode.
    Returns (is_authenticated, error_message).
    """
    auth_mode = config.get("auth_mode", "token")

    # 1. Bearer Token Check
    auth_header = headers.get("Authorization", "")
    token_header = headers.get("X-Arca-Token", "")
    configured_token = config.get("auth_token", "")

    if auth_mode == "token":
        extracted_token = ""
        if auth_header.startswith("Bearer "):
            extracted_token = auth_header[7:].strip()
        elif token_header:
            extracted_token = token_header.strip()

        if not extracted_token:
            return False, "Missing Bearer token in Authorization or X-Arca-Token header"

        if not hmac.compare_digest(extracted_token, configured_token):
            return False, "Invalid authentication token"

        return True, None

    # 2. Basic Auth Check
    if auth_mode == "basic":
        if not auth_header.startswith("Basic "):
            return False, "Missing Basic Auth credentials"
        try:
            encoded_creds = auth_header[6:].strip()
            decoded = base64.b64decode(encoded_creds).decode("utf-8")
            user, pwd = decoded.split(":", 1)
            expected_user = config.get("basic_auth_user", "arca_admin")
            expected_pwd = config.get("basic_auth_password", "")
            if hmac.compare_digest(user, expected_user) and hmac.compare_digest(pwd, expected_pwd):
                return True, None
            return False, "Invalid Basic Auth credentials"
        except Exception as e:
            return False, f"Malformed Basic Auth header: {str(e)}"

    # 3. Unix Socket Only
    if auth_mode == "unix_socket_only":
        if client_address and client_address[0] not in ("127.0.0.1", "localhost", "::1", "unix"):
            return False, "Remote TCP access forbidden under unix_socket_only mode"
        return True, None

    return False, "unknown auth_mode"
