FROM python:3.11-slim

# Proxy build args — passed from docker-compose, empty if not set in .env
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ENV HTTP_PROXY=$HTTP_PROXY \
    HTTPS_PROXY=$HTTPS_PROXY \
    NO_PROXY=$NO_PROXY

WORKDIR /app

# Install lab CA cert (needed when pip goes through a forward proxy with SSL inspection).
# Drop your .crt file(s) into certs/ before building — safe no-op if the folder is empty.
COPY certs/ /tmp/certs/
RUN if ls /tmp/certs/*.crt 2>/dev/null 1>&2; then \
      cp /tmp/certs/*.crt /usr/local/share/ca-certificates/ && \
      update-ca-certificates; \
    fi && rm -rf /tmp/certs

# Point pip and Python HTTP libraries at the updated system cert bundle.
ENV PIP_CERT=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .
RUN mkdir -p uploads

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "37100"]
