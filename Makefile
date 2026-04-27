.PHONY: up down build logs restart ps prod-up prod-down prod-build prod-logs prod-restart prod-ps clean-down-dev clean-down-prod

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
