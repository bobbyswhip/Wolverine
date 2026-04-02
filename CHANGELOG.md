# Changelog

## 2.4.1 — Auto-Update Test

This version exists to test the auto-update feature. If your server picked this up automatically — it works.

## 2.4.0 — Self-Updating Framework

- Auto-update: checks npm hourly, upgrades itself, protects config files
- Cost optimization: $0.31 → $0.02 for simple fixes (7 techniques)
- Verifier fix: no longer kills working fixes on servers with external deps
- Rollback protection: settings.json, .env.local never overwritten
- Per-model KPIs: latency, success rate, tokens/sec, cost/call
- Dual provider: OpenAI + Anthropic with hybrid mode
- 18 agent tools, 54 exports, 80 files
