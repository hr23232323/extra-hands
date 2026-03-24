.PHONY: help setup dev build check test screenshot run env

help:
	@echo "Usage:"
	@echo "  make setup        Install Tauri CLI (requires Rust)"
	@echo "  make dev          Run in development mode (hot reload)"
	@echo "  make build        Build the .app for distribution"
	@echo "  make check        Run cargo check"
	@echo "  make test         Run JS tests"
	@echo "  make screenshot   Capture the app window (app must be running)"
	@echo "  make env          Create .env from .env.example"
	@echo "  make run          Run the agent loop CLI (loads .env automatically)"
	@echo "                    Usage: make run TASK=\"your task\" [WORKSPACE=/path] [MODEL=model-id]"

setup:
	cargo install tauri-cli --version "^2"

dev:
	cargo tauri dev

build:
	cargo tauri build

check:
	cargo check --manifest-path src-tauri/Cargo.toml

test:
	npm test

screenshot:
	@bash scripts/screenshot.sh

env:
	@if [ -f .env ]; then echo ".env already exists — edit it directly"; \
	else cp .env.example .env && echo "Created .env — fill in your API keys"; fi

run:
	@[ -f .env ] && export $(shell grep -v '^#' .env | xargs) 2>/dev/null; \
	node scripts/agent-loop.js \
		--task "$(TASK)" \
		$(if $(WORKSPACE),--workspace "$(WORKSPACE)") \
		$(if $(MODEL),--model "$(MODEL)") \
		$(if $(RAW),--raw)
