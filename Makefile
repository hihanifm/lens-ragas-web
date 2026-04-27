.PHONY: up down build logs restart ps prod-up prod-down prod-build prod-logs prod-restart prod-ps

up:
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
