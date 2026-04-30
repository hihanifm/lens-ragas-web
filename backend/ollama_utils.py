import os
import json
import urllib.parse
import urllib.request


def _running_in_docker() -> bool:
    # /.dockerenv is common but not guaranteed in all runtimes.
    if os.path.exists("/.dockerenv"):
        return True
    # Fallback: cgroup inspection (Docker / containerd / k8s).
    try:
        with open("/proc/1/cgroup", "r", encoding="utf-8") as f:
            txt = f.read()
        return any(x in txt for x in ("docker", "containerd", "kubepods"))
    except Exception:
        return False


def normalize_ollama_base_url(base_url: str | None) -> str:
    """
    Normalize Ollama base URL so it works in both local and Docker setups.

    - Ensures scheme is present (defaults to http://)
    - Strips trailing slash
    - In Docker, rewrites localhost/127.0.0.1 to host.docker.internal
    """
    url = (base_url or "").strip()
    if not url:
        return ""

    if "://" not in url:
        url = "http://" + url

    url = url.rstrip("/")

    # In Docker, localhost/127.0.0.1 points to the container, not the host.
    if _running_in_docker():
        if url.startswith("http://localhost:") or url.startswith("http://127.0.0.1:"):
            url = url.replace("http://localhost:", "http://host.docker.internal:")
            url = url.replace("http://127.0.0.1:", "http://host.docker.internal:")
        if url == "http://localhost" or url == "http://127.0.0.1":
            url = "http://host.docker.internal:11434"

    return url


def _check_tags(url: str, *, timeout_s: float) -> None:
    tags_url = urllib.parse.urljoin(url + "/", "api/tags")
    req = urllib.request.Request(tags_url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if not isinstance(payload, dict) or "models" not in payload:
        raise RuntimeError("Unexpected response from Ollama (missing models list).")


def preflight_ollama(base_url: str, *, timeout_s: float = 2.0) -> str:
    """
    Quick connectivity check to the Ollama daemon.
    Returns a working normalized base URL on success.
    Raises RuntimeError with a user-friendly message on failure.
    """
    raw = (base_url or "").strip()
    url = normalize_ollama_base_url(raw)
    if not url:
        raise RuntimeError("Missing Ollama base URL.")

    try:
        _check_tags(url, timeout_s=timeout_s)
        return url
    except Exception:
        # If user supplied localhost, also try host.docker.internal explicitly.
        # This avoids relying purely on container-runtime detection.
        if url.startswith("http://localhost") or url.startswith("http://127.0.0.1"):
            alt = url.replace("http://localhost", "http://host.docker.internal").replace(
                "http://127.0.0.1", "http://host.docker.internal"
            )
            try:
                _check_tags(alt, timeout_s=timeout_s)
                return alt
            except Exception as e2:
                raise RuntimeError(f"Ollama unreachable at {url} (also tried {alt}). {e2}")
        raise RuntimeError(f"Ollama unreachable at {url}.")

