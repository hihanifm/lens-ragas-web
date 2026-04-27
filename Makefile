.PHONY: up down build logs restart ps

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
