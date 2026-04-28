.PHONY: up down build logs restart ps prod-up prod-down prod-build prod-logs prod-restart prod-ps clean-down-dev clean-down-prod e2e e2e-up e2e-down pip-cache

SHELL := /bin/bash

# Dev/prod run different compose files (different ports).
# These helpers ensure a clean stop of the other mode before switching.

clean-down-dev:
	docker compose down

clean-down-prod:
	docker compose -f docker-compose.prod.yml down

up:
	$(MAKE) clean-down-prod
	docker compose up -d

down:
	docker compose down

build:
	docker compose build

logs:
	docker compose logs -f

restart: down up

ps:
	docker compose ps

prod-up:
	$(MAKE) clean-down-dev
	docker compose -f docker-compose.prod.yml up -d --build

prod-down:
	docker compose -f docker-compose.prod.yml down

prod-build:
	docker compose -f docker-compose.prod.yml build

prod-logs:
	docker compose -f docker-compose.prod.yml logs -f

prod-restart: prod-down prod-up

prod-ps:
	docker compose -f docker-compose.prod.yml ps

# Run this once on the Linux server (where pip works) before make build.
# Downloads Linux/Python 3.11 compatible wheels so Docker installs offline.
pip-cache:
	pip download \
	  --platform manylinux2014_x86_64 \
	  --platform manylinux_2_17_x86_64 \
	  --platform linux_x86_64 \
	  --python-version 3.11 \
	  --implementation cp \
	  --abi cp311 \
	  --only-binary=:all: \
	  -r backend/requirements.txt \
	  -d pip-cache/

e2e-up:
	$(MAKE) up

e2e-down:
	$(MAKE) down

e2e:
	@set -euo pipefail; \
	ROOT_DIR="$$(pwd)"; \
	trap 'cd "$$ROOT_DIR" && $(MAKE) e2e-down' EXIT; \
	$(MAKE) e2e-up; \
	echo "Waiting for API..."; \
	for i in {1..60}; do \
	  curl -fsS "http://localhost:37100/health" >/dev/null && break; \
	  sleep 1; \
	done; \
	curl -fsS "http://localhost:37100/health" >/dev/null; \
	echo "Waiting for UI..."; \
	for i in {1..60}; do \
	  curl -fsS "http://localhost:37101/" >/dev/null && break; \
	  sleep 1; \
	done; \
	curl -fsS "http://localhost:37101/" >/dev/null; \
	cd "$$ROOT_DIR/frontend" && npm install && npx playwright install chromium && npm run e2e
