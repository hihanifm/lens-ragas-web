FROM python:3.11-slim

# Proxy build args — passed from docker-compose, empty if not set in .env
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ENV HTTP_PROXY=$HTTP_PROXY \
    HTTPS_PROXY=$HTTPS_PROXY \
    NO_PROXY=$NO_PROXY

WORKDIR /app

# Install lab CA cert if present (safe no-op when certs/ is empty).
COPY certs/ /tmp/certs/
RUN if ls /tmp/certs/*.crt 2>/dev/null 1>&2; then \
      cp /tmp/certs/*.crt /usr/local/share/ca-certificates/ && \
      update-ca-certificates; \
    fi && rm -rf /tmp/certs

# Point Python HTTP libraries at the updated system cert bundle (runtime calls).
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

# Tell pip to trust PyPI hosts explicitly — works even when the proxy does SSL
# inspection and the cert chain can't be fully resolved at build time.
ENV PIP_TRUSTED_HOST="pypi.org pypi.python.org files.pythonhosted.org"

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .
RUN mkdir -p uploads

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "37100"]
