# Security

Roqer runs an AI agent that can change a Roblox place, run Luau in Studio, and, in Full auto, act without asking. Reports about anything that lets it do more than the user approved are especially welcome, for example:

- an approval, Read only mode, or the inspector edition's read-only promise being bypassed;
- the renderer, a model, or content inside a place reaching the main process, the MCP bridge credential, a provider credential, or the local filesystem beyond what a tool is meant to touch;
- a way for another program or web page to drive the local MCP bridge.

## Known limitations

These are known and do not need a report, though ideas for closing them are welcome:

- The endpoints the Studio plugin connects to (`/ready`, `/events`, `/response`, `/disconnect`) take no token, because a Studio plugin cannot read the token file. Any program already running as you on the same machine can therefore register as a Studio instance, see the requests sent to it, and answer them. Web pages cannot, because the bridge refuses cross-origin requests from origins you have not allowed, and invoking a tool always needs the token.
- The Windows installer is not code-signed. Roqer downloads updates from this repository's GitHub Releases, checks them against the hash published with the release, and installs them when you quit, so whoever can publish a release here can ship an update.

## Reporting

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button on this repository's Security tab rather than in a public issue. Include the version, steps to reproduce, and what an attacker gains.

This is a volunteer project, so there is no bounty and no guaranteed response time, but reports are read and credited in the fix unless you ask otherwise.
