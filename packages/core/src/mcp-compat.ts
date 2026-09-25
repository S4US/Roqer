import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
} from '@modelcontextprotocol/server';
import { DOC_CATEGORIES, fetchRobloxDoc, isDocCategory, DocNotFoundError } from './roblox-docs.js';

export const TOOL_GUIDE_URI = 'robloxstudio://tool-guides';

export const TOOL_GUIDE_MARKDOWN = `# Roblox Studio MCP tool guide

Tool descriptions explain selection. Input schemas explain arguments. This guide holds shared workflows and safety notes.

## Connection and paths

- Use canonical DataModel paths returned by the tools. Paths usually start with game. Reuse instanceRef when a read returns one so later calls keep targeting the same live Instance after a rename or reparent.
- Call get_connected_instances when more than one place may be connected. Pass the chosen row's id as instance_id on later calls.
- Use get_place_info for the active place identity and settings.

## Discovery and edit work

- Use get_project_structure for a bounded hierarchy, search_objects for an instance query, and grep_scripts for source text.
- Use get_instance_properties and get_attributes after locating an instance.
- Use execute_luau for custom traversal, bulk edits, and work that would otherwise need many tool calls. It runs through the Studio plugin context.
- Use set_properties when several known properties on one instance can be updated atomically in one request.

## Building

Use build_instances to create, clone, update, or remove many instances in one request rather than building through execute_luau. The whole batch is one undo step, and it applies completely or not at all.

- path is the build root. It must sit below a service, such as game.Workspace.Island, and is created as a Model when missing. Every parent, set target, and remove target must be the root or inside it; a clone source may be anywhere.
- Steps run in order. create takes className, and optionally name, parent, properties, tags, attributes, and for a part position and rotation. clone takes source and transforms, one clone per entry, each with optional position, rotation, and scale; its name, properties, tags, and attributes apply to every clone. set takes target and any of the same fields. remove takes target.
- Give a step an id to refer to its instance later as $id, for example a Model created in step 1 as the parent of the parts in step 2. Paths only resolve instances that already exist.
- Values follow set_properties: Vector3 as [x, y, z], Color3 as [r, g, b] from 0 to 1, enums by item name. position is world studs, rotation is Orientation in degrees. Script Source is refused; create the script, then write its body with set_script_source.
- One batch holds up to 500 steps and 2,000 new instances (20,000 counting clone descendants). Split a larger build by area.
- The result reports what the root holds afterwards: counts by class and tag, world bounds, and the path of each id. A step that cannot apply names its number and changes nothing.

### Deterministic scatter

Use one sole build_instances step {op:"scatter", name, zone:{min:[x,z],max:[x,z]}, density, seed, templates:[{source,weight,kit?}], ground:[path], raycast:{top,bottom}}. density is placements per 10,000 square studs; floor(area*density/10000) must be 1-1000. ground names existing Workspace surfaces; templates must already exist. Optional rotation:[minYaw,maxYaw] degrees, scale:[min,max] (0.05-20), spacing (extra footprint clearance), avoid:[{tag,distance}] (extra clearance from tagged Part/Model bounds), and maxSlope (0-89 degrees, default30). Optional parent stays under the build root; tags and attributes decorate each placement. The named Model holds this scatter; replace:true replaces only a recognized scatter group as one atomic undo step. Same seed, inputs and unchanged scene give the same layout. Result scatter:{requested,placed,attempts} reports shortfalls; no placements is an error and preserves existing output. Commit ground/templates first; scatter cannot share a batch with other steps.

## Selection and viewport

- Use selection with action=get when the user's Studio selection should define the scope.
- Use action=set with instance paths to replace, add to, or remove from the selection. An empty paths array in set mode clears it.
- Use action=open with a script path to show it in Studio's native Script Editor.
- Use action=view with a BasePart or Model path to frame it. The current viewing direction is preserved unless from or angleY overrides it. padding below 1 crops closer and above 1 pulls back.
- For visual proof, change the instance, frame it with selection, then call capture_screenshot.

## Script changes

- Read the relevant source with get_script_source before changing it. Pass its revision as expectedRevision when calling set_script_source.
- Use edit_script_lines, insert_script_lines, or delete_script_lines for focused changes with known line numbers.
- Use edit_script_batch when one script needs several exact, non-overlapping edits; they apply as one transaction and produce one revision.
- Use set_script_source only when replacing the whole script.
- Use find_and_replace_in_scripts with dryRun first when a replacement may affect several scripts.

## Playtests and runtime Luau

Start solo_playtest or multiplayer_playtest before targeting a live server or client. Stop the playtest when the scenario is complete.

execute_luau runs through the Studio plugin. eval_server_runtime and eval_client_runtime run inside a live game VM and share that VM's require cache with game scripts. Use the eval tools when module state or the runtime Script or LocalScript environment matters.

Read output with get_runtime_logs. Reuse nextSince or perCaptureNextSince for incremental reads instead of requesting the full buffer again.

## Simulation and input

- Inspect current settings with get_simulation_state before changing them.
- Apply network conditions with set_network_profile. Roblox caps packet loss at 0.5 percent.
- Inspect built-in device IDs with get_device_simulator_state, then apply one with set_device_simulator or compare several with capture_device_matrix.
- Clear temporary network and device settings with reset_simulation_state after a scenario.
- Capture the viewport with capture_screenshot before simulate_mouse_input so the pixel coordinates match. Keyboard input should target a live client when game input is under test.

## Debugging and profiling

- breakpoints requires Studio's Script Editor API beta feature. Logpoints normally use continue_execution=true. A pausing breakpoint with continue_execution=false needs an OnStopped resume handler.
- breakpoints clear removes only MCP-created breakpoints unless clear_all is true. clear_all also removes user-created breakpoints.
- capture_script_profiler ranks Luau functions by CPU time. Use output_path when the raw capture is needed.
- capture_micro_profiler attributes frame time across engine and game work. Its rows are inclusive or cumulative views, so do not sum them as disjoint totals.
- Use baseline_path or baseline for before-and-after MicroProfiler comparisons.
- Use get_memory_breakdown for memory categories and get_scene_analysis for instance, script, triangle, animation, or audio cost.

## Creator Store and generated assets

Search with search_assets, inspect a shortlist with get_asset_details or get_asset_thumbnail, and preview untrusted content with preview_asset before insert_asset.

Studio must allow third-party asset loading for public third-party previews and insertion. preview_asset scans the complete hierarchy without returning script source. insert_asset removes every LuaSourceContainer and PackageLink before parenting the remaining content, then scans again before insertion.

generate_model stages generated content under ServerStorage for review. upload_asset action=upload sends an explicit local file to the chosen Roblox user or group. If it returns status=processing, keep its operation_id and use action=status later; do not upload the file again. A completed result reports Roblox's moderation state when available.

## RBXM files

- export_rbxm writes selected instances to an explicit local path. It can read the edit DataModel or a live server DataModel.
- import_rbxm accepts exactly one local path, HTTP or HTTPS URL, or base64 source. It parents imported instances under the supplied canonical path.

## Studio processes

manage_instance can launch, inspect, and close Studio or list published place revisions. A process-identity launch returns a suspended launch that must be authorized and completed explicitly. Keep its launch_id until the connection has an instance_id.

## Roblox reference material

Use get_roblox_docs for official engine and Luau reference pages. Use get_roblox_skills to list or read Roblox-authored Studio Assistant skills when their longer guidance is useful.
`;

/** Official Roblox reference templates shared by the HTTP and stdio servers. */
export function registerResourceHandlers(server: McpServer): void {
  server.registerResource(
    'Roblox Studio MCP tool guide',
    TOOL_GUIDE_URI,
    {
      description: 'Detailed workflows and safety notes for Roblox Studio MCP tools.',
      mimeType: 'text/markdown',
    },
    async (resourceUrl) => ({
      contents: [{
        uri: resourceUrl.href,
        mimeType: 'text/markdown',
        text: TOOL_GUIDE_MARKDOWN,
      }],
    }),
  );

  const templates = [
    ['classes', 'className', 'Roblox class documentation', 'Official Roblox engine class reference.'],
    ['enums', 'enumName', 'Roblox enum documentation', 'Official Roblox engine enum reference.'],
    ['datatypes', 'dataTypeName', 'Roblox datatype documentation', 'Official Roblox engine datatype reference.'],
    ['libraries', 'libraryName', 'Roblox library documentation', 'Official Roblox Luau library reference.'],
    ['globals', 'globalsPage', 'Roblox globals documentation', 'Official Roblox globals reference.'],
  ] as const;

  for (const [category, variable, name, description] of templates) {
    server.registerResource(
      name,
      new ResourceTemplate(`robloxdocs://${category}/{${variable}}`, { list: undefined }),
      { description, mimeType: 'text/markdown' },
      async (resourceUrl) => {
        const uri = resourceUrl.href;
        const match = uri.match(/^robloxdocs:\/\/([^/]+)\/([^/]+)$/);
        if (!match || !isDocCategory(match[1])) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource ${uri} not found`);
        }

        const [, docCategory, rawName] = match;
        const docName = decodeURIComponent(rawName);
        try {
          const content = await fetchRobloxDoc(docCategory, docName);
          return {
            contents: [{ uri, mimeType: 'text/markdown', text: content }],
          };
        } catch (error) {
          if (error instanceof DocNotFoundError) {
            throw new ProtocolError(
              ProtocolErrorCode.InvalidParams,
              `Resource ${uri} not found. Names are case-sensitive PascalCase; valid categories: ${DOC_CATEGORIES.join(', ')}.`,
            );
          }
          console.error(`[resource:${uri}]`, error);
          throw new ProtocolError(ProtocolErrorCode.InternalError, `Failed to read ${uri}.`);
        }
      },
    );
  }
}
