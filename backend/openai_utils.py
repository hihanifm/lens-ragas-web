"""Helpers for OpenAI-compatible HTTP APIs (official API, proxies, Azure-style roots)."""

from urllib.parse import urlparse, urlunparse


def normalize_openai_api_root(raw: str) -> str:
    """
    Build an absolute API root suitable for LangChain's ``base_url`` (typically ends with ``/v1``).

    If the URL has no path (only scheme + host), ``/v1`` is appended so ``.../v1/models`` works.
    Non-empty paths are left unchanged (custom gateways).
    """
    s = (raw or "").strip().rstrip("/")
    if not s:
        raise ValueError("OpenAI base URL is empty")
    if not s.startswith(("http://", "https://")):
        s = "https://" + s
    p = urlparse(s)
    path = p.path or ""
    if path in ("", "/"):
        new_path = "/v1"
    else:
        new_path = path if path.startswith("/") else "/" + path
    return urlunparse((p.scheme, p.netloc, new_path, "", "", "")).rstrip("/")
