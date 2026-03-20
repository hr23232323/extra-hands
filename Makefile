.PHONY: help setup dev build check test

help:
	@echo "Usage:"
	@echo "  make setup   Install Tauri CLI (requires Rust)"
	@echo "  make dev     Run in development mode (hot reload)"
	@echo "  make build   Build the .app for distribution"
	@echo "  make check   Run cargo check"
	@echo "  make test    Run JS tests"

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
