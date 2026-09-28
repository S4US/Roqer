# Third-party notices

Roqer is licensed under the GNU Affero General Public License, version 3 or
any later version (see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md)). It
builds on the projects below, whose code keeps its own licence. Dependencies
installed from npm carry their own licences in `node_modules`. The packaged
desktop app ships Electron's and Chromium's licence files alongside it, and
Roqer's `LICENSE`, `NOTICE.md` and this file in its resources folder; the MCP
packages on npm carry the same three files.

## robloxstudio-mcp

The Roblox Studio MCP bridge and Studio plugin in `packages/` and
`studio-plugin/` began as a fork of
[chrrxs/robloxstudio-mcp](https://github.com/chrrxs/robloxstudio-mcp) and have
since been developed independently. The code taken from it stays under its MIT
licence, whose notice is kept here as that project published it:

```text
MIT License

Copyright (c) 2025

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## roblox-mcp-primitives

The game-VM eval bridges (`studio-plugin/src/modules/EvalBridges.ts`) and the
runtime log buffer (`studio-plugin/src/modules/RuntimeLogBuffer.ts`) are ported
from [chrrxs/roblox-mcp-primitives](https://github.com/chrrxs/roblox-mcp-primitives):

```text
MIT License

Copyright (c) 2026 Chrrxs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## three.js

The desktop app's 3D preview of Blender models draws with
[three.js](https://github.com/mrdoob/three.js). Its build bundles the parts it
uses into the app's own scripts rather than shipping the package, so its notice
is kept here:

```text
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## roblox-brain

Most of the Roblox domain skills in `apps/desktop/agent/skills/` are based on
[TabooHarmony/roblox-brain](https://github.com/TabooHarmony/roblox-brain)
1.2.1, under the MIT licence. Its notice is
[`apps/desktop/agent/skills/ROBLOX-BRAIN-LICENSE.txt`](apps/desktop/agent/skills/ROBLOX-BRAIN-LICENSE.txt),
and [`apps/desktop/agent/PROVENANCE.md`](apps/desktop/agent/PROVENANCE.md)
records which skills were changed here and which material was written for
this repository.

## LibMP

The Studio plugin's micro-profiler reads captures through Roblox's
[LibMP](https://github.com/Roblox/libmp). Its repository publishes no licence,
so its source is not in this repository: the plugin build downloads the
published release and checks it against a pinned SHA-256
(`scripts/fetch-libmp.mjs`), and a built plugin carries it as a module.
[NOTICE.md](NOTICE.md) gives the additional permission the GNU AGPL needs for a
build that carries it; that permission grants no rights in LibMP itself.

## Roblox assets

The UI skill's icon catalog lists Roblox image asset IDs. No artwork is copied
into this repository; Roblox serves each image at runtime under the terms its
creator set on Roblox.
