## What and why

<!-- What this changes and the problem it solves. Link the issue if there is one. -->

## Verification

<!-- CONTRIBUTING.md lists the checks for each area. Tick what you ran and say what you could not run. -->

- [ ] MCP, plugin, or package checks: typecheck, lint, test, build, `build:plugins`
- [ ] Desktop checks: typecheck, lint, test, build, and the Electron smoke run for Electron, preload, IPC, or persistence changes
- [ ] Live Studio gate (`npm run test:e2e`) for behaviour that reaches Studio, or why it was not run:

## Checklist

- [ ] A public tool change keeps every layer in step: schema, handler, plugin endpoint, inspector list, desktop risk table, and generated desktop schemas
- [ ] Docs describe what the code now does
- [ ] No generated `studio-plugin/*.rbxmx` files
