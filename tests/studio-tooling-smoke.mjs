#!/usr/bin/env node

import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BASE_PORT, McpClient, DIST, REPO_ROOT, assert, assertContains } from './lib/mcp-client.mjs';
import { windowsPortIsAvailable } from './lib/test-port.mjs';
import {
  closeStudioProcess,
  configureStudioDirectoryIsolation,
  createIsolatedStudioDirectory,
} from '../scripts/studio-lifecycle.mjs';

const SERVER_ENV = {
  ROBLOX_STUDIO_PROXY_PROMOTION_INTERVAL_MS: '600000',
};

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

async function waitPortClosed(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return;
    await delay(250);
  }
  throw new Error(`Port ${port} remained open after server shutdown`);
}


async function waitForEditInstance(client, expectedVersion, instanceId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const connected = await client.callTool('get_connected_instances', {});
      const instances = connected.instances ?? [];
      const edit = instances.find((inst) => inst.id === instanceId && inst.roles?.includes('edit'));
      if (edit) {
        const statusResponse = await fetch(`http://127.0.0.1:${BASE_PORT}/status`);
        const status = await statusResponse.json();
        const peer = status.instances?.find((inst) => inst.role === 'edit' && inst.instanceId === instanceId);
        if (!peer) {
          last = { connected, status };
          await delay(1000);
          continue;
        }
        assert(peer.pluginVariant === 'main', 'regular tooling loaded the main plugin');
        assert(peer.pluginVersion === expectedVersion, `Studio plugin version is v${expectedVersion}`);
        assert(peer.serverVersion === expectedVersion, `MCP server version is v${expectedVersion}`);
        return { ...edit, instanceId: edit.id };
      }
      last = connected;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await delay(1000);
  }
  throw new Error(`No edit instance ${instanceId} connected within ${timeoutMs}ms. Last: ${JSON.stringify(last)}`);
}

async function launchManagedPlace(client, workingDirectory) {
  await configureStudioDirectoryIsolation({ requireStudioClosed: false });
  const launched = await client.callTool('manage_instance', {
    action: 'launch',
    source: 'baseplate',
    require_process_identity: true,
    studio_working_directory: workingDirectory,
    timeout_ms: 120000,
  });
  assert(!!launched.launch_id, `manage_instance returned launch ownership (${JSON.stringify(launched)})`);
  assert(
    Number.isSafeInteger(launched.pid) &&
      launched.pid > 0 &&
      typeof launched.process_started_at_file_time === 'string',
    `manage_instance returned exact Studio process identity (${JSON.stringify(launched)})`,
  );

  try {
    const authorized = await client.callTool('manage_instance', {
      action: 'authorize',
      launch_id: launched.launch_id,
    });
    assert(authorized.process_authorized === true, `manage_instance authorized launch ${launched.launch_id}`);
    const completed = await client.callTool('manage_instance', {
      action: 'complete',
      launch_id: launched.launch_id,
    });
    assert(
      completed.process_ownership_released === true,
      `manage_instance released launch ${launched.launch_id}`,
    );

    const deadline = Date.now() + 120000;
    let status;
    while (Date.now() < deadline) {
      status = await client.callTool('manage_instance', {
        action: 'status',
        launch_id: launched.launch_id,
      });
      if (
        status.connected === true &&
        typeof status.instance_id === 'string' &&
        status.instance_id &&
        Array.isArray(status.roles) &&
        status.roles.includes('edit')
      ) {
        return { ...launched, instance_id: status.instance_id };
      }
      if (status.state === 'failed' || status.state === 'exited') {
        throw new Error(
          `Managed Studio launch ${launched.launch_id} entered ${status.state}: ` +
          `${status.failure_reason ?? 'Studio did not connect'}`,
        );
      }
      await delay(250);
    }
    throw new Error(
      `Managed Studio launch ${launched.launch_id} did not connect within 120000ms: ${JSON.stringify(status)}`,
    );
  } catch (error) {
    try {
      await closeStudioProcess({
        processId: launched.pid,
        startedAtFileTime: launched.process_started_at_file_time,
      });
    } catch (identityError) {
      throw new AggregateError(
        [error, identityError],
        `Studio launch ${launched.launch_id} failed and exact cleanup also failed`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function closeManagedInstance(client, launch) {
  if (!launch) return;
  const closed = await client.callTool('manage_instance', {
    action: 'close',
    launch_id: launch.launch_id,
  });
  assert(!closed.error, `manage_instance closed Studio launch ${launch.launch_id}`);
  assert(
    closed.close_status === 'closed' || closed.close_status === 'already_closed',
    `manage_instance confirmed Studio launch ${launch.launch_id} stopped`,
  );
}

function assertNoError(value, message) {
  assert(!value?.error, `${message}${value?.error ? ` (${value.error})` : ''}`);
}

/**
 * build_instances against a real DataModel: a new root, a created part, clones
 * of a template outside the root, a live float property, the all-or-nothing
 * refusal, containment, and Studio's own undo reversing a whole batch. It
 * builds inside the smoke folder, so the caller's cleanup removes everything.
 */
async function runBuildInstancesSmoke(client, instanceId, folderPath, templatePath) {
  const buildPath = `${folderPath}.Build`;
  const readBuild = async () => {
    const read = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: `
local build = workspace.__RSMCP_ToolingSmoke:FindFirstChild("Build")
if not build then return "missing" end
local block = build:FindFirstChild("Block")
local tagged = #game:GetService("CollectionService"):GetTagged("RSMCPBuildSmoke")
return table.concat({
  build.ClassName,
  tostring(#build:GetChildren()),
  tostring(tagged),
  block and tostring(block.Position) or "none",
  block and block.Material.Name or "none",
  block and tostring(block:GetAttribute("zone")) or "none",
  block and string.format("%.3f", block.Transparency) or "none",
}, "|")`,
    });
    assert(read.success === true, `execute_luau reads the build back (${JSON.stringify(read)})`);
    return String(read.returnValue);
  };

  const built = await client.callTool('build_instances', {
    path: buildPath,
    instance_id: instanceId,
    operations: [
      {
        op: 'create', id: 'block', className: 'Part', name: 'Block',
        position: [0, 20, 0],
        properties: { Size: [4, 2, 4], Anchored: true, Material: 'Neon', Color: [1, 0, 0] },
        tags: ['RSMCPBuildSmoke'], attributes: { zone: 'smoke' },
      },
      {
        op: 'clone', source: templatePath, tags: ['RSMCPBuildSmoke'],
        transforms: [{ position: [10, 20, 0] }, { position: [20, 20, 0], rotation: [0, 90, 0] }],
      },
    ],
  });
  assertNoError(built, 'build_instances builds a new root');
  assert(built.createdRoot === true && built.created === 1 && built.cloned === 2,
    `build_instances reports what it made (${JSON.stringify(built)})`);
  assert(built.tags?.RSMCPBuildSmoke === 3, 'build_instances counts tagged instances under the root');
  assert(built.ids?.block === `${buildPath}.Block`, 'build_instances resolves ids to live paths');
  assert(Array.isArray(built.bounds?.size), 'build_instances reports world bounds');
  assert(await readBuild() === 'Model|3|3|0, 20, 0|Neon|smoke|0.000',
    'build_instances landed the root, part, clones, tags, attributes, and placement');

  const floatWrite = await client.callTool('build_instances', {
    path: buildPath,
    instance_id: instanceId,
    operations: [{ op: 'set', target: `${buildPath}.Block`, properties: { Transparency: 0.3 } }],
  });
  assertNoError(floatWrite, 'build_instances accepts a 32-bit float property on a live part');
  assert((await readBuild()).endsWith('|0.300'), 'build_instances wrote the float property');

  const refused = await client.callTool('build_instances', {
    path: buildPath,
    instance_id: instanceId,
    operations: [
      { op: 'create', className: 'Part', name: 'Extra' },
      { op: 'create', className: 'NotARealClass' },
    ],
  });
  assert(typeof refused.error === 'string' && refused.error.includes('step 2'),
    `build_instances names the failing step (${JSON.stringify(refused)})`);
  assert((await readBuild()).startsWith('Model|3|'), 'a refused build_instances batch changes nothing');

  const escaped = await client.callTool('build_instances', {
    path: buildPath,
    instance_id: instanceId,
    operations: [{ op: 'remove', target: templatePath }],
  });
  assert(typeof escaped.error === 'string' && escaped.error.includes('outside the build root'),
    'build_instances refuses to remove outside its root');

  const removed = await client.callTool('build_instances', {
    path: buildPath,
    instance_id: instanceId,
    operations: [{ op: 'remove', target: `${buildPath}.Block` }],
  });
  assert(removed.removed === 1 && removed.undoable === true, 'build_instances removes inside its root as an undoable step');
  assert((await readBuild()).startsWith('Model|2|2|none'), 'build_instances removal lands');

  const undone = await client.callTool('execute_luau', {
    target: 'edit',
    instance_id: instanceId,
    code: 'game:GetService("ChangeHistoryService"):Undo() return true',
  });
  assert(undone.success === true, 'execute_luau runs Studio undo');
  assert((await readBuild()).startsWith('Model|3|3|0, 20, 0'), 'one Studio undo restores the removed part');

  await runPivotSmoke(client, instanceId, folderPath);
  await runScatterSmoke(client, instanceId, folderPath);
}

/**
 * A model build_instances creates must turn about the vertical when a clone
 * asks for yaw. Studio's own pivot for a model with no PrimaryPart follows one
 * of its parts, so a template whose largest part is a canopy turned (45, 0, 45)
 * once came out with every trunk leaning 45°. Covers a template cloned in the
 * batch that made it and one cloned by a later batch.
 */
async function runPivotSmoke(client, instanceId, folderPath) {
  const pivotPath = `${folderPath}.PivotBuild`;
  const made = await client.callTool('build_instances', {
    path: pivotPath,
    instance_id: instanceId,
    operations: [
      { op: 'create', id: 'tree', className: 'Model', name: 'Template' },
      { op: 'create', className: 'Part', name: 'Trunk', parent: '$tree', position: [0, 3.5, 0], properties: { Size: [1, 7, 1], Anchored: true } },
      { op: 'create', className: 'Part', name: 'Leaves', parent: '$tree', position: [0, 9, 0], rotation: [45, 0, 45], properties: { Size: [6, 6, 6], Anchored: true } },
      { op: 'clone', source: '$tree', name: 'SameBatch', transforms: [{ position: [30, 10, 0], rotation: [0, 30, 0] }] },
    ],
  });
  assertNoError(made, 'build_instances builds a template with a tilted largest part and clones it');
  const later = await client.callTool('build_instances', {
    path: pivotPath,
    instance_id: instanceId,
    operations: [{ op: 'clone', source: `${pivotPath}.Template`, name: 'LaterBatch', transforms: [{ position: [60, 10, 0], rotation: [0, 30, 0] }] }],
  });
  assertNoError(later, 'build_instances clones the committed template in a later batch');

  const read = await client.callTool('execute_luau', {
    target: 'edit',
    instance_id: instanceId,
    code: `
local build = workspace.__RSMCP_ToolingSmoke.PivotBuild
local function row(name)
  local model = build[name]
  local pivot = Vector3.new(model:GetPivot():ToOrientation()) * (180 / math.pi)
  local trunk = model.Trunk.Orientation
  return string.format("%s pivot=%.1f,%.1f,%.1f trunk=%.1f,%.1f,%.1f", name, pivot.X, pivot.Y, pivot.Z, trunk.X, trunk.Y, trunk.Z)
end
return table.concat({ row("Template"), row("SameBatch"), row("LaterBatch") }, "\\n")`,
  });
  assert(read.success === true, `execute_luau reads the pivots back (${JSON.stringify(read)})`);
  const lines = String(read.returnValue).split('\n');
  const upright = (text) => /pivot=-?0\.0,[^,]+,-?0\.0 trunk=-?0\.0,[^,]+,-?0\.0/.test(text);
  assert(upright(lines[0]), `a created template's pivot is upright (${lines[0]})`);
  assert(upright(lines[1]) && /trunk=-?0\.0,30\.0,-?0\.0/.test(lines[1]),
    `a same-batch clone turns 30° about vertical with its trunk upright (${lines[1]})`);
  assert(upright(lines[2]) && /trunk=-?0\.0,30\.0,-?0\.0/.test(lines[2]),
    `a later-batch clone turns 30° about vertical with its trunk upright (${lines[2]})`);
}

async function runScatterSmoke(client, instanceId, folderPath) {
  const scatterPath = `${folderPath}.ScatterBuild`;
  const fixturesPath = `${folderPath}.ScatterFixtures`;
  const setup = await client.callTool('execute_luau', {
    target: 'edit', instance_id: instanceId,
    code: `
local fixtures = Instance.new("Folder")
fixtures.Name = "ScatterFixtures"
fixtures.Parent = workspace.__RSMCP_ToolingSmoke
local function part(name, size, position, avoid)
  local result = Instance.new("Part")
  result.Name = name
  result.Anchored = true
  result.Size = size
  result.Position = position
  result.Parent = fixtures
  if avoid then game:GetService("CollectionService"):AddTag(result, "RSMCPScatterAvoid") end
  return result
end
part("Ground", Vector3.new(220, 2, 220), Vector3.new(0, 1000, 0))
part("Path", Vector3.new(8, 2, 200), Vector3.new(0, 1002, 0), true)
part("Building", Vector3.new(24, 14, 24), Vector3.new(35, 1008, 35), true)
part("Tree", Vector3.new(2, 4, 2), Vector3.new(1000, 1000, 0))
part("Tiny", Vector3.new(1, 0.001, 1), Vector3.new(1020, 1000, 0))
local tallTree = Instance.new("Model")
tallTree.Name = "TallTree"
tallTree.Parent = fixtures
part("Trunk", Vector3.new(2, 6, 2), Vector3.new(1010, 1000, 0)).Parent = tallTree
part("Crown", Vector3.new(4, 2, 4), Vector3.new(1010, 1004, 0)).Parent = tallTree
tallTree.WorldPivot = CFrame.new(1008, 998, 3)
local multipart = part("MultipartPart", Vector3.new(2, 4, 2), Vector3.new(1020, 1000, 0))
part("ChildPart", Vector3.new(2, 2, 2), Vector3.new(1020, 1004, 0)).Parent = multipart
return true`,
  });
  assert(setup.success === true, 'scatter fixtures provide isolated live ground, a path, a building, and templates');

  const operation = {
    op: 'scatter', name: 'Trees',
    zone: { min: [-100, -100], max: [100, 100] }, density: 37.5, seed: 18273,
    templates: [
      { source: `${fixturesPath}.Tree`, weight: 2, kit: 'smoke-tree' },
      { source: `${fixturesPath}.TallTree`, weight: 1, kit: 'smoke-tall-tree' },
    ],
    ground: [`${fixturesPath}.Ground`], raycast: { top: 1100, bottom: 900 },
    rotation: [0, 360], scale: [0.8, 1.2], spacing: 2,
    avoid: [{ tag: 'RSMCPScatterAvoid', distance: 3 }], maxSlope: 15,
    tags: ['RSMCPScatterSmoke'], attributes: { zone: 'scatter-smoke' },
  };
  const scatter = (overrides = {}) => client.callTool('build_instances', {
    path: scatterPath, instance_id: instanceId,
    operations: [{ ...operation, ...overrides }],
  });
  const readScatter = async () => {
    const read = await client.callTool('execute_luau', {
      target: 'edit', instance_id: instanceId,
      code: `
local root = workspace.__RSMCP_ToolingSmoke.ScatterBuild
local group = root:FindFirstChild("Trees")
assert(group and group:IsA("Model"), "scatter group must be a Model")
local collection = game:GetService("CollectionService")
assert(group:GetAttribute("RoqerScatterVersion") == 1 and collection:HasTag(group, "RoqerScatter"), "scatter ownership")
local rows, kits = {}, {}
for _, tree in group:GetChildren() do
  assert(collection:HasTag(tree, "RSMCPScatterSmoke") and tree:GetAttribute("zone") == "scatter-smoke", "scatter metadata")
  local kit = tree:GetAttribute("RoqerKit")
  assert(kit == "smoke-tree" or kit == "smoke-tall-tree", "scatter kit metadata")
  assert(collection:HasTag(tree, "RoqerKit"), "scatter kit tag")
  assert((kit == "smoke-tree" and tree:IsA("BasePart")) or (kit == "smoke-tall-tree" and tree:IsA("Model")), "scatter preserves template types")
  kits[kit] = true
  local pivot = tree:IsA("BasePart") and tree.CFrame or tree:GetPivot()
  local p = pivot.Position
  local parts = tree:IsA("BasePart") and {tree} or tree:GetDescendants()
  local radius, bottom, partCount = 0, math.huge, 0
  local partRows = {}
  for _, part in parts do
    if part:IsA("BasePart") then
      partCount += 1
      assert(part.Anchored, "scatter preserved template properties")
      for _, x in {-1, 1} do for _, y in {-1, 1} do for _, z in {-1, 1} do
        local corner = part.CFrame:PointToWorldSpace(Vector3.new(part.Size.X * x / 2, part.Size.Y * y / 2, part.Size.Z * z / 2))
        radius = math.max(radius, Vector2.new(corner.X - p.X, corner.Z - p.Z).Magnitude)
        bottom = math.min(bottom, corner.Y)
        assert(math.abs(corner.X) <= 100.01 and math.abs(corner.Z) <= 100.01, "all model parts stay inside the zone")
      end end end
      local values = {part.CFrame:GetComponents()}
      table.insert(values, part.Size.X)
      table.insert(values, part.Size.Y)
      table.insert(values, part.Size.Z)
      local row = {part.Name}
      for _, value in values do table.insert(row, string.format("%.5f", value)) end
      table.insert(partRows, table.concat(row, ","))
    end
  end
  assert(partCount == (kit == "smoke-tree" and 1 or 2), "scatter clones all template parts")
  assert(math.abs(p.X) + radius <= 100.01 and math.abs(p.Z) + radius <= 100.01, "scatter footprint stays inside zone")
  assert(math.abs(bottom - 1001) < 0.01, "scatter physical bottom touches the selected ground")
  for _, obstacle in workspace.__RSMCP_ToolingSmoke.ScatterFixtures:GetChildren() do
    if collection:HasTag(obstacle, "RSMCPScatterAvoid") then
      local dx = math.max(math.abs(p.X - obstacle.Position.X) - obstacle.Size.X / 2, 0)
      local dz = math.max(math.abs(p.Z - obstacle.Position.Z) - obstacle.Size.Z / 2, 0)
      assert(math.sqrt(dx * dx + dz * dz) + 0.01 >= radius + 3, "scatter avoids the path and building footprint")
    end
  end
  local values = {pivot:GetComponents()}
  local row = {tree.Name, kit}
  for _, value in values do table.insert(row, string.format("%.5f", value)) end
  table.sort(partRows)
  table.insert(row, table.concat(partRows, ";"))
  table.insert(rows, table.concat(row, ","))
end
table.sort(rows)
local layout = table.concat(rows, "|")
local digest = 0
for i = 1, #layout do digest = (digest * 131 + string.byte(layout, i)) % 2147483647 end
local groups = 0
for _, child in root:GetChildren() do if child.Name == "Trees" then groups += 1 end end
return game:GetService("HttpService"):JSONEncode({count = #rows, groups = groups, digest = tostring(digest), bothKits = kits["smoke-tree"] == true and kits["smoke-tall-tree"] == true})`,
    });
    assert(read.success === true, `scatter readback verifies live geometry and metadata (${JSON.stringify(read)})`);
    return JSON.parse(String(read.returnValue));
  };

  const initial = await scatter();
  assertNoError(initial, 'one scatter call places 150 instances');
  assert(initial.scatter?.requested === 150 && initial.scatter?.placed === 150 && initial.cloned === 150,
    `scatter reports all 150 placements (${JSON.stringify(initial)})`);
  assert(initial.created === 1 && initial.undoable === true, 'scatter creates one undoable group');
  const first = await readScatter();
  assert(first.count === 150 && first.groups === 1 && first.bothKits, 'scatter has exactly 150 clones from both weighted templates');

  const collision = await scatter();
  assert(typeof collision.error === 'string', 'scatter requires explicit replacement for an existing group');
  assert((await readScatter()).digest === first.digest, 'refused collision preserves the existing layout');
  const repeated = await scatter({ replace: true });
  assertNoError(repeated, 'scatter can explicitly replace its owned group');
  assert(repeated.removed === 1 && repeated.cloned === 150, 'replacement reports the removed group and new clones');
  const same = await readScatter();
  assert(same.digest === first.digest && same.count === 150 && same.groups === 1,
    'same seed recreates positions, rotations, and scales without duplicate groups');

  const changed = await scatter({ replace: true, seed: 82731 });
  assertNoError(changed, 'scatter accepts a different seed');
  const different = await readScatter();
  assert(different.count === 150 && different.digest !== first.digest, 'a different seed produces a different complete layout');
  const undo = await client.callTool('execute_luau', {
    target: 'edit', instance_id: instanceId,
    code: 'game:GetService("ChangeHistoryService"):Undo() return true',
  });
  assert(undo.success === true, 'Studio undoes the scatter replacement');
  const restored = await readScatter();
  assert(restored.digest === first.digest && restored.count === 150 && restored.groups === 1,
    'one Studio undo restores the previous scatter group and its entire layout');

  const invalid = await scatter({ replace: true, ground: [`${fixturesPath}.MissingGround`] });
  assert(typeof invalid.error === 'string', 'scatter refuses an unresolved ground before replacement');
  assert((await readScatter()).digest === first.digest, 'invalid scatter leaves the previous layout intact');
  const clamped = await scatter({ replace: true, templates: [{ source: `${fixturesPath}.Tiny`, weight: 1 }], scale: [0.05, 0.05] });
  assert(typeof clamped.error === 'string' && clamped.error.includes('clamped'), 'scatter refuses engine-clamped template sizes');
  assert((await readScatter()).digest === first.digest, 'clamped scale leaves the previous layout intact');
  const multipart = await scatter({ replace: true, templates: [{ source: `${fixturesPath}.MultipartPart`, weight: 1 }] });
  assert(typeof multipart.error === 'string', 'scatter requires a Model for a template containing multiple parts');
  assert((await readScatter()).digest === first.digest, 'refused multipart BasePart preserves the previous scatter layout');
  const unowned = await client.callTool('execute_luau', {
    target: 'edit', instance_id: instanceId,
    code: `local group = Instance.new("Model") group.Name = "Unowned" group:SetAttribute("Keep", "original") group.Parent = workspace.__RSMCP_ToolingSmoke.ScatterBuild return true`,
  });
  assert(unowned.success === true, 'creates an unowned model beside the scatter');
  const refused = await scatter({ name: 'Unowned', replace: true });
  assert(typeof refused.error === 'string', 'scatter refuses to replace an unowned model');
  const preserved = await client.callTool('execute_luau', {
    target: 'edit', instance_id: instanceId,
    code: `local root = workspace.__RSMCP_ToolingSmoke.ScatterBuild local group = root:FindFirstChild("Unowned") return group ~= nil and group:GetAttribute("Keep") == "original" and #group:GetChildren() == 0 and #root:GetChildren() == 2`,
  });
  assert(preserved.success === true && String(preserved.returnValue) === 'true', 'refused replacement preserves the unowned model');
  assert((await readScatter()).digest === first.digest, 'refused replacement also preserves the existing scatter');
}

async function runEditModeToolSmoke(client, instanceId) {
  console.log('\n=== edit-mode regular tooling smoke ===');

  const listed = await client.rpc('tools/list', {});
  const names = new Set((listed.tools ?? []).map((tool) => tool.name));
  for (const tool of [
    'get_place_info',
    'get_project_structure',
    'set_properties',
    'build_instances',
    'get_instance_properties',
    'set_script_source',
    'get_script_source',
    'edit_script_lines',
    'insert_script_lines',
    'delete_script_lines',
    'find_and_replace_in_scripts',
    'get_attributes',
    'selection',
    'execute_luau',
  ]) {
    assert(names.has(tool), `tools/list exposes ${tool}`);
  }
  for (const removed of [
    'get_services',
    'create_object',
    'set_property',
    'set_attribute',
    'add_tag',
    'delete_object',
    'get_selection',
    'set_selection',
    'focus_viewport',
  ]) {
    assert(!names.has(removed), `tools/list omits removed ${removed}`);
  }

  const place = await client.callTool('get_place_info', { instance_id: instanceId });
  assertNoError(place, 'get_place_info succeeds');
  assert(place.workspace?.className === 'Workspace', 'get_place_info returns workspace metadata');

  const tree = await client.callTool('get_project_structure', { path: 'game.Workspace', maxDepth: 2, instance_id: instanceId });
  assertNoError(tree, 'get_project_structure succeeds');

  const folderPath = 'game.Workspace.__RSMCP_ToolingSmoke';
  const partPath = `${folderPath}.SmokePart`;
  const scriptPath = `${folderPath}.SmokeScript`;
  const nestedScriptPath = `${scriptPath}.NestedModule`;
  const setup = await client.callTool('execute_luau', {
    target: 'edit',
    instance_id: instanceId,
    code: `
local old = workspace:FindFirstChild("__RSMCP_ToolingSmoke")
if old then old:Destroy() end
local folder = Instance.new("Folder")
folder.Name = "__RSMCP_ToolingSmoke"
folder.Parent = workspace
local part = Instance.new("Part")
part.Name = "SmokePart"
part.Anchored = true
part.Size = Vector3.new(4, 1, 2)
part.Position = Vector3.new(0, 5, 0)
part:SetAttribute("SmokeAttr", "ok")
game:GetService("CollectionService"):AddTag(part, "RSMCPToolingSmoke")
part.Parent = folder
local script = Instance.new("Script")
script.Name = "SmokeScript"
script.Enabled = false
script.Parent = folder
local nested = Instance.new("ModuleScript")
nested.Name = "NestedModule"
nested.Source = 'return "NESTED_OLD"'
nested.Parent = script
return true
`,
  });
  assert(setup.success === true && String(setup.returnValue) === 'true', 'execute_luau creates smoke fixtures');

  const assertExactScriptSource = async (expectedLines, message) => {
    const source = await client.callTool('get_script_source', {
      instancePath: scriptPath,
      instance_id: instanceId,
    });
    const expected = expectedLines.map((line, index) => `${index + 1}: ${line}`).join('\n');
    assert(
      source.source === expected,
      `${message} (${JSON.stringify({ expected, actual: source.source })})`,
    );
  };

  const replaceWholeScript = async (sourceText) => {
    const current = await client.callTool('get_script_source', {
      instancePath: scriptPath,
      instance_id: instanceId,
    });
    assert(typeof current.revision === 'string', 'get_script_source returns a source revision');
    assert(typeof current.instanceRef === 'string', 'get_script_source returns a stable Instance reference');
    return client.callTool('set_script_source', {
      instancePath: scriptPath,
      instanceRef: current.instanceRef,
      source: sourceText,
      expectedRevision: current.revision,
      instance_id: instanceId,
    });
  };

  try {
    const fullTree = await client.callTool('get_project_structure', {
      path: folderPath,
      maxDepth: 5,
      instance_id: instanceId,
    });
    assertNoError(fullTree, 'get_project_structure returns smoke fixture');
    assert(Array.isArray(fullTree.children), 'get_project_structure preserves populated children');
    const partNode = fullTree.children.find((child) => child.name === 'SmokePart');
    const scriptNode = fullTree.children.find((child) => child.name === 'SmokeScript');
    const nestedNode = scriptNode?.children?.find((child) => child.name === 'NestedModule');
    assert(partNode && !Object.hasOwn(partNode, 'children'), 'get_project_structure omits children from a leaf');
    assert(Array.isArray(scriptNode?.children), 'get_project_structure preserves a branch children array');
    assert(
      nestedNode && !Object.hasOwn(nestedNode, 'children'),
      'get_project_structure omits children from a nested leaf',
    );

    const truncatedTree = await client.callTool('get_project_structure', {
      path: folderPath,
      maxDepth: 0,
      instance_id: instanceId,
    });
    const truncatedPart = truncatedTree.children?.find((child) => child.name === 'SmokePart');
    assert(
      truncatedPart?.hasMore === true &&
        truncatedPart.childCount === 0 &&
        !Object.hasOwn(truncatedPart, 'children'),
      'get_project_structure preserves max-depth markers when children are omitted',
    );

    const setProp = await client.callTool('set_properties', {
      instancePath: partPath,
      instanceRef: partNode.instanceRef,
      properties: { Transparency: 0.25 },
      instance_id: instanceId,
    });
    assert(setProp.summary?.failed === 0, 'set_properties updates smoke part');

    // Phase 4 found a destructive failure while repairing a nested canopy with
    // two ordinary BasePart properties: set_properties returned an instance-ref
    // error and the containing scene disappeared. Pin that exact shape here so
    // a model-quality eval never has to rediscover a bridge regression.
    const repairFixturePath = `${folderPath}.RepairFixture`;
    const repairCanopyPath = `${repairFixturePath}.BadTree.Canopy`;
    const repairSetup = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: `
local root = workspace.__RSMCP_ToolingSmoke
local fixture = Instance.new("Model")
fixture.Name = "RepairFixture"
fixture.Parent = root
local tree = Instance.new("Model")
tree.Name = "BadTree"
tree.Parent = fixture
local canopy = Instance.new("Part")
canopy.Name = "Canopy"
canopy.Anchored = true
canopy.Shape = Enum.PartType.Ball
canopy.Size = Vector3.new(38, 38, 38)
canopy.Color = Color3.new(1, 0, 2/3)
canopy.Parent = tree
return true
`,
    });
    assert(repairSetup.success === true, 'creates a nested visual-repair fixture');

    // Control for the wrapper: run the same two-property edit through Roblox's
    // ChangeHistoryService directly on a sibling fixture. If this detaches too,
    // the engine/history boundary owns the bug; if it stays live while
    // set_properties detaches the next fixture, PropertyHandlers owns it.
    const historyControl = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: `
local root = workspace.__RSMCP_ToolingSmoke
local fixture = Instance.new("Model")
fixture.Name = "HistoryControl"
fixture.Parent = root
local tree = Instance.new("Model")
tree.Name = "BadTree"
tree.Parent = fixture
local canopy = Instance.new("Part")
canopy.Name = "Canopy"
canopy.Anchored = true
canopy.Shape = Enum.PartType.Ball
canopy.Size = Vector3.new(38, 38, 38)
canopy.Color = Color3.new(1, 0, 2/3)
canopy.Parent = tree

local history = game:GetService("ChangeHistoryService")
local before = canopy:IsDescendantOf(game)
local recording = history:TryBeginRecording("RSMCP nested property control")
if not recording then
  return game:GetService("HttpService"):JSONEncode({
    began = false,
    before = before,
    scene = workspace:FindFirstChild("__RSMCP_ToolingSmoke") ~= nil,
    fixture = root:FindFirstChild("HistoryControl") ~= nil,
  })
end
canopy.Size = Vector3.new(11, 11, 11)
canopy.Color = Color3.new(0.2627, 0.5686, 0.2902)
local afterWrite = canopy:IsDescendantOf(game)
history:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
return game:GetService("HttpService"):JSONEncode({
  began = true,
  before = before,
  afterWrite = afterWrite,
  afterFinish = canopy:IsDescendantOf(game),
  scene = workspace:FindFirstChild("__RSMCP_ToolingSmoke") ~= nil,
  fixture = root:FindFirstChild("HistoryControl") ~= nil,
})
`,
    });
    assert(
      historyControl.success === true,
      `raw ChangeHistory control executes (${JSON.stringify(historyControl)})`,
    );
    const historyState = JSON.parse(String(historyControl.returnValue));
    assert(
      historyState.began === true && historyState.before === true &&
        historyState.afterWrite === true && historyState.afterFinish === true &&
        historyState.scene === true && historyState.fixture === true,
      `raw ChangeHistory Size+Color write keeps its nested fixture live (${JSON.stringify(historyState)})`,
    );

    const repairWrite = await client.callTool('set_properties', {
      instancePath: repairCanopyPath,
      properties: { Size: [11, 11, 11], Color: [0.2627, 0.5686, 0.2902] },
      instance_id: instanceId,
    });
    assertNoError(repairWrite, 'set_properties keeps a nested scene live while changing Size and Color');
    assert(repairWrite.summary?.failed === 0, 'nested Size+Color write succeeds atomically');

    const repairRead = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: `
local fixture = workspace.__RSMCP_ToolingSmoke:FindFirstChild("RepairFixture")
local tree = fixture and fixture:FindFirstChild("BadTree")
local canopy = tree and tree:FindFirstChild("Canopy")
if not canopy then return "missing" end
return string.format("%.1f|%.1f|%.1f|%.4f|%.4f|%.4f",
  canopy.Size.X, canopy.Size.Y, canopy.Size.Z,
  canopy.Color.R, canopy.Color.G, canopy.Color.B)
`,
    });
    const repairValues = String(repairRead.returnValue).split('|').map(Number);
    assert(
      repairRead.success === true &&
        repairValues.length === 6 &&
        repairValues.slice(0, 3).every((value) => Math.abs(value - 11) < 0.01) &&
        Math.abs(repairValues[3] - 0.2627) <= 1 / 255 + 0.0001 &&
        Math.abs(repairValues[4] - 0.5686) <= 1 / 255 + 0.0001 &&
        Math.abs(repairValues[5] - 0.2902) <= 1 / 255 + 0.0001,
      `nested Size+Color write preserves the fixture and lands both properties (${JSON.stringify(repairRead)})`,
    );

    const repairBuild = await client.callTool('build_instances', {
      path: repairFixturePath,
      instance_id: instanceId,
      operations: [{
        op: 'set',
        target: repairCanopyPath,
        properties: { Size: [12, 12, 12], Color: [0.3, 0.6, 0.32] },
      }],
    });
    assertNoError(repairBuild, 'build_instances set accepts the same nested Size+Color repair');
    assert(repairBuild.updated === 1, 'build_instances reports the nested repair as one update');

    const repairBuildRead = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: `
local fixture = workspace.__RSMCP_ToolingSmoke:FindFirstChild("RepairFixture")
local tree = fixture and fixture:FindFirstChild("BadTree")
local canopy = tree and tree:FindFirstChild("Canopy")
if not canopy then return "missing" end
return string.format("%.1f|%.1f|%.1f|%.4f|%.4f|%.4f",
  canopy.Size.X, canopy.Size.Y, canopy.Size.Z,
  canopy.Color.R, canopy.Color.G, canopy.Color.B)
`,
    });
    const repairBuildValues = String(repairBuildRead.returnValue).split('|').map(Number);
    assert(
      repairBuildRead.success === true &&
        repairBuildValues.length === 6 &&
        repairBuildValues.slice(0, 3).every((value) => Math.abs(value - 12) < 0.01) &&
        Math.abs(repairBuildValues[3] - 0.3) <= 1 / 255 + 0.0001 &&
        Math.abs(repairBuildValues[4] - 0.6) <= 1 / 255 + 0.0001 &&
        Math.abs(repairBuildValues[5] - 0.32) <= 1 / 255 + 0.0001,
      `build_instances nested Size+Color repair preserves the fixture and lands both properties (${JSON.stringify(repairBuildRead)})`,
    );

    const props = await client.callTool('get_instance_properties', {
      instancePath: partPath,
      instance_id: instanceId,
    });
    assertNoError(props, 'get_instance_properties succeeds');
    assert(props.properties?.Name === 'SmokePart', 'get_instance_properties returns updated object');
    assert(typeof props.instanceRef === 'string', 'get_instance_properties returns a stable Instance reference');

    const atomicFailure = await client.callTool('set_properties', {
      instancePath: partPath,
      instanceRef: props.instanceRef,
      properties: { Anchored: false, ClassName: 'Folder' },
      instance_id: instanceId,
    });
    assert(atomicFailure.summary?.succeeded === 0, 'set_properties rejects the whole property batch on one invalid property');
    const afterAtomicFailure = await client.callTool('get_instance_properties', {
      instancePath: partPath,
      instanceRef: props.instanceRef,
      instance_id: instanceId,
    });
    assert(afterAtomicFailure.properties?.Anchored === props.properties?.Anchored,
      'set_properties rolls back properties applied before a later failure');

    const renamed = await client.callTool('set_properties', {
      instancePath: partPath,
      instanceRef: props.instanceRef,
      properties: { Name: 'RenamedSmokePart' },
      instance_id: instanceId,
    });
    assert(renamed.success !== false && renamed.summary?.failed === 0, 'set_properties renames through a stable reference');
    const resolvedAfterRename = await client.callTool('get_instance_properties', {
      instancePath: partPath,
      instanceRef: props.instanceRef,
      instance_id: instanceId,
    });
    assert(resolvedAfterRename.properties?.Name === 'RenamedSmokePart',
      'instanceRef keeps targeting the same Instance after its path becomes stale');
    const restoredName = await client.callTool('set_properties', {
      instancePath: partPath,
      instanceRef: props.instanceRef,
      properties: { Name: 'SmokePart' },
      instance_id: instanceId,
    });
    assert(restoredName.summary?.failed === 0, 'stable reference restores the smoke fixture name');

    const attrs = await client.callTool('get_attributes', {
      instancePath: partPath,
      instance_id: instanceId,
    });
    assert(attrs.attributes?.SmokeAttr?.value === 'ok', 'get_attributes returns smoke attribute');

    const emptyAttrs = await client.callTool('get_attributes', {
      instancePath: scriptPath,
      instance_id: instanceId,
    });
    assert(
      emptyAttrs.count === 0 && !Object.hasOwn(emptyAttrs, 'attributes'),
      'get_attributes omits an empty attributes collection while preserving count',
    );

    const tag = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: 'return game:GetService("CollectionService"):HasTag(workspace.__RSMCP_ToolingSmoke.SmokePart, "RSMCPToolingSmoke")',
    });
    assert(tag.success === true && String(tag.returnValue) === 'true', 'execute_luau handles project-specific tag work');

    const sourceBeforeReplace = await client.callTool('get_script_source', {
      instancePath: scriptPath,
      instance_id: instanceId,
    });
    const setSource = await client.callTool('set_script_source', {
      instancePath: scriptPath,
      instanceRef: sourceBeforeReplace.instanceRef,
      source: 'local value = 41\nreturn value + 1\n',
      expectedRevision: sourceBeforeReplace.revision,
      instance_id: instanceId,
    });
    assert(setSource.success === true, 'set_script_source updates smoke script');

    const staleSource = await client.callTool('set_script_source', {
      instancePath: scriptPath,
      instanceRef: sourceBeforeReplace.instanceRef,
      source: 'error("stale overwrite")',
      expectedRevision: sourceBeforeReplace.revision,
      instance_id: instanceId,
    });
    assert(staleSource.errorCode === 'source_revision_conflict', 'set_script_source rejects a stale full-source write');

    const source = await client.callTool('get_script_source', {
      instancePath: scriptPath,
      line_range: '1-2',
      instance_id: instanceId,
    });
    assertContains(source.source, 'return value + 1', 'get_script_source returns edited source');

    const escapeHeavyLines = [
      String.raw`local newline = "\n"`,
      String.raw`local tab = "\t"`,
      String.raw`local carriage = "\r"`,
      String.raw`local quote = "say \"hi\""`,
      String.raw`local windowsPath = "C:\\Users\\dev\\file.lua"`,
      'return newline .. tab .. carriage .. quote .. windowsPath',
    ];
    const escapedSetSource = await replaceWholeScript(escapeHeavyLines.join('\n'));
    assert(escapedSetSource.success === true, 'set_script_source accepts escape-heavy source');
    await assertExactScriptSource(
      escapeHeavyLines,
      'set_script_source preserves already-decoded source text exactly',
    );

    const quotedReplacement = String.raw`local quote = "say \"bye\""`;
    const escapedEdit = await client.callTool('edit_script_lines', {
      instancePath: scriptPath,
      old_string: escapeHeavyLines[3],
      new_string: quotedReplacement,
      line_range: '4',
      instance_id: instanceId,
    });
    assert(escapedEdit.success === true, 'edit_script_lines accepts escape-heavy source text');
    escapeHeavyLines[3] = quotedReplacement;
    await assertExactScriptSource(
      escapeHeavyLines,
      'edit_script_lines preserves already-decoded search and replacement text exactly',
    );

    const insertedEscapeLines = [
      String.raw`local pattern = "\\n\\t"`,
      String.raw`local json = "{\"key\":\"value\\n\"}"`,
    ];
    const escapedInsert = await client.callTool('insert_script_lines', {
      instancePath: scriptPath,
      afterLine: 5,
      newContent: insertedEscapeLines.join('\n'),
      instance_id: instanceId,
    });
    assert(escapedInsert.success === true, 'insert_script_lines accepts escape-heavy source text');
    escapeHeavyLines.splice(5, 0, ...insertedEscapeLines);
    await assertExactScriptSource(
      escapeHeavyLines,
      'insert_script_lines preserves already-decoded source text exactly',
    );

    const pathPattern = String.raw`C:\\Users\\dev\\file.lua`;
    const pathReplacement = String.raw`D:\\Build\\out.lua`;
    const escapedFindAndReplace = await client.callTool('find_and_replace_in_scripts', {
      pattern: pathPattern,
      replacement: pathReplacement,
      caseSensitive: true,
      path: scriptPath,
      classFilter: 'Script',
      instance_id: instanceId,
    });
    assert(
      escapedFindAndReplace.success === true
        && escapedFindAndReplace.totalReplacements === 1
        && escapedFindAndReplace.scriptsModified === 1,
      `find_and_replace_in_scripts accepts exact escape-heavy text (${JSON.stringify(escapedFindAndReplace)})`,
    );
    escapeHeavyLines[4] = escapeHeavyLines[4].replace(pathPattern, pathReplacement);
    await assertExactScriptSource(
      escapeHeavyLines,
      'find_and_replace_in_scripts preserves already-decoded pattern and replacement text exactly',
    );

    const openedDraft = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: `
local script = workspace.__RSMCP_ToolingSmoke.SmokeScript
local editor = game:GetService("ScriptEditorService")
local opened, openError = editor:OpenScriptDocumentAsync(script)
if not opened then error(openError) end
local document = editor:FindScriptDocument(script)
if not document then error("ScriptDocument did not open") end
local lineCount = document:GetLineCount()
local lastLine = document:GetLine(lineCount)
local edited, editError = document:EditTextAsync("", 1, 1, lineCount, #lastLine + 1)
if not edited then error(editError) end
return document:GetText()
`,
    });
    assert(openedDraft.success === true, 'execute_luau opens and empties a live ScriptDocument');
    assert(String(openedDraft.returnValue) === '', 'open ScriptDocument exposes its empty live draft');

    const draftSource = await client.callTool('get_script_source', {
      instancePath: scriptPath,
      line_range: '1',
      instance_id: instanceId,
    });
    assert(draftSource.source === '1: ',
      `get_script_source preserves an empty live editor draft (${JSON.stringify(draftSource)})`);

    const populatedDraft = await replaceWholeScript('local beforeClear = true\nreturn beforeClear\n');
    assert(populatedDraft.success === true && populatedDraft.method === 'UpdateSourceAsync',
      `set_script_source populates the empty live editor draft editor-safely (${JSON.stringify(populatedDraft)})`);

    const populatedRead = await client.callTool('get_script_source', {
      instancePath: scriptPath,
      instance_id: instanceId,
    });
    assertContains(populatedRead.source, 'return beforeClear',
      'get_script_source confirms the live editor draft is non-empty before clearing');

    const clearedSource = await replaceWholeScript('');
    assert(clearedSource.success === true && clearedSource.method === 'UpdateSourceAsync',
      `set_script_source clears a non-empty live editor draft editor-safely (${JSON.stringify(clearedSource)})`);

    const clearedRead = await client.callTool('get_script_source', {
      instancePath: scriptPath,
      instance_id: instanceId,
    });
    assert(clearedRead.source === '1: ',
      `set_script_source cleared the non-empty live draft exactly (${JSON.stringify(clearedRead)})`);

    const restoredDraft = await replaceWholeScript('local value = 40\nreturn value + 1\n');
    assert(restoredDraft.success === true, 'set_script_source restores an empty live editor draft');

    const editedLines = await client.callTool('edit_script_lines', {
      instancePath: scriptPath,
      old_string: 'local value = 40',
      new_string: 'local value = 41',
      line_range: '1',
      instance_id: instanceId,
    });
    assert(editedLines.success === true, 'edit_script_lines verifies its open-document write');
    // Every script mutation reports the revision it wrote, and that revision is
    // what a following read returns. A caller reading a write back — Roqer
    // does it after each one — has no other way to tell its own change from
    // someone else's, and a mutation that reports nothing can never be verified.
    assert(typeof editedLines.revision === 'string', 'edit_script_lines reports the revision it wrote');
    const afterEdit = await client.callTool('get_script_source', {
      instancePath: scriptPath,
      instance_id: instanceId,
    });
    assert(afterEdit.revision === editedLines.revision,
      `edit_script_lines reports the revision a read-back returns (${editedLines.revision} vs ${afterEdit.revision})`);

    const insertedLines = await client.callTool('insert_script_lines', {
      instancePath: scriptPath,
      afterLine: 1,
      newContent: 'local bonus = 1',
      instance_id: instanceId,
    });
    assert(insertedLines.success === true, 'insert_script_lines verifies its open-document write');
    assert(typeof insertedLines.revision === 'string', 'insert_script_lines reports the revision it wrote');
    assert(insertedLines.previousRevision === editedLines.revision,
      'insert_script_lines reports the revision it replaced');

    const editedReturn = await client.callTool('edit_script_lines', {
      instancePath: scriptPath,
      old_string: 'return value + 1',
      new_string: 'return value + bonus',
      line_range: '3',
      instance_id: instanceId,
    });
    assert(editedReturn.success === true, 'edit_script_lines updates inserted line positions');

    const deletedLines = await client.callTool('delete_script_lines', {
      instancePath: scriptPath,
      line_range: '2',
      instance_id: instanceId,
    });
    assert(deletedLines.success === true, 'delete_script_lines verifies its open-document write');
    assert(typeof deletedLines.revision === 'string', 'delete_script_lines reports the revision it wrote');
    const afterDelete = await client.callTool('get_script_source', {
      instancePath: scriptPath,
      instance_id: instanceId,
    });
    assert(afterDelete.revision === deletedLines.revision,
      `delete_script_lines reports the revision a read-back returns (${deletedLines.revision} vs ${afterDelete.revision})`);

    const replacedDraft = await client.callTool('find_and_replace_in_scripts', {
      pattern: 'bonus',
      replacement: '1',
      path: scriptPath,
      classFilter: 'Script',
      instance_id: instanceId,
    });
    assert(replacedDraft.success === true && replacedDraft.scriptsModified === 1 && replacedDraft.scriptsFailed === 0,
      `find_and_replace_in_scripts verifies its open-document write (${JSON.stringify(replacedDraft)})`);

    const replacedNested = await client.callTool('find_and_replace_in_scripts', {
      pattern: 'NESTED_OLD',
      replacement: 'NESTED_NEW',
      path: scriptPath,
      classFilter: 'ModuleScript',
      instance_id: instanceId,
    });
    assert(replacedNested.success === true && replacedNested.scriptsModified === 1,
      `find_and_replace_in_scripts traverses children of a filtered parent script (${JSON.stringify(replacedNested)})`);

    const finalSource = await client.callTool('get_script_source', {
      instancePath: scriptPath,
      instance_id: instanceId,
    });
    assertContains(finalSource.source, 'return value + 1', 'line mutation sequence lands in the live draft');

    const nestedSource = await client.callTool('get_script_source', {
      instancePath: nestedScriptPath,
      instance_id: instanceId,
    });
    assertContains(nestedSource.source, 'NESTED_NEW', 'nested script replacement lands');

    const exec = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: 'return workspace:FindFirstChild("__RSMCP_ToolingSmoke") ~= nil',
    });
    assert(exec.success === true, 'execute_luau edit target succeeds');
    assert(String(exec.returnValue) === 'true', 'execute_luau can read edited Workspace state');

    await runBuildInstancesSmoke(client, instanceId, folderPath, partPath);

    const viewed = await client.callTool('selection', {
      action: 'view',
      path: partPath,
      padding: 1.1,
      instance_id: instanceId,
    });
    assert(viewed.success === true && viewed.cameraPosition, 'selection view frames the smoke part');

    const opened = await client.callTool('selection', {
      action: 'open',
      path: scriptPath,
      instance_id: instanceId,
    });
    assert(
      opened.success === true && opened.instancePath === scriptPath,
      `selection open opens the smoke script editor (${JSON.stringify(opened)})`,
    );

    const selected = await client.callTool('selection', {
      action: 'set',
      paths: [partPath],
      instance_id: instanceId,
    });
    assert(selected.success === true && selected.selected === 1, 'selection set selects the smoke part');

    const selection = await client.callTool('selection', {
      action: 'get',
      instance_id: instanceId,
    });
    assertNoError(selection, 'selection get succeeds');
    assert(
      selection.selection?.some((entry) => entry.path === partPath),
      'selection get returns the smoke part',
    );

    const cleared = await client.callTool('selection', {
      action: 'set',
      paths: [],
      instance_id: instanceId,
    });
    assert(cleared.success === true && cleared.selected === 0, 'selection set clears with empty paths');
  } finally {
    const deleted = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: `local folder = workspace:FindFirstChild("__RSMCP_ToolingSmoke")
if folder then
  local script = folder:FindFirstChild("SmokeScript")
  if script then
    local document = game:GetService("ScriptEditorService"):FindScriptDocument(script)
    if document then document:CloseAsync() end
  end
  folder:Destroy()
end
return true`,
    });
    assert(deleted.success === true, 'execute_luau cleans up smoke folder');
  }
}


async function main() {
  const existingInstanceId = process.env.MCP_INSTANCE_ID?.trim();
  if (existingInstanceId) {
    const client = new McpClient('regular-tooling-existing', { env: SERVER_ENV });
    try {
      await client.start();
      await client.initialize();
      await runEditModeToolSmoke(client, existingInstanceId);
    } finally {
      await client.stop();
    }
    return;
  }

  if (await isPortOpen(BASE_PORT)) {
    throw new Error(`Port ${BASE_PORT} is already occupied. Stop existing MCP servers before running this smoke test.`);
  }
  if (!windowsPortIsAvailable(BASE_PORT)) {
    throw new Error(
      `A Windows process is listening on port ${BASE_PORT}. ` +
      'Studio would connect to it instead of the test server.',
    );
  }

  await configureStudioDirectoryIsolation({ requireStudioClosed: false });
  const worker = createIsolatedStudioDirectory({ prefix: 'tooling-smoke' });
  const { version } = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  let client;
  let launch;
  let bodyError;

  try {
    client = new McpClient('regular-tooling-primary', {
      command: 'node',
      args: [DIST, '--auto-install-plugin'],
      env: {
        ...SERVER_ENV,
        MCP_PLUGINS_DIR: worker.pluginsDirectory,
        RSMCP_STUDIO_WORKING_DIRECTORY: worker.workingDirectory,
      },
      startupTimeoutMs: 60000,
    });
    await client.start();
    await client.initialize();

    launch = await launchManagedPlace(client, worker.workingDirectory);
    const edit = await waitForEditInstance(client, version, launch.instance_id);
    await runEditModeToolSmoke(client, edit.instanceId);
  } catch (error) {
    bodyError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (client && launch) {
      try {
        await closeManagedInstance(client, launch);
      } catch (error) {
        cleanupErrors.push(error);
        try {
          await closeStudioProcess({
            processId: launch.pid,
            startedAtFileTime: launch.process_started_at_file_time,
          });
        } catch (identityError) {
          cleanupErrors.push(identityError);
        }
      }
    }
    if (client) {
      try {
        await client.stop();
        await waitPortClosed(BASE_PORT);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await configureStudioDirectoryIsolation({ requireStudioClosed: false });
    } catch (error) {
      cleanupErrors.push(error);
    }
    await delay(1000);
    try {
      worker.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      if (bodyError) {
        throw new AggregateError(
          [bodyError, ...cleanupErrors],
          `Studio tooling smoke failed and cleanup also failed: ${cleanupErrors.map(String).join('; ')}`,
          { cause: bodyError },
        );
      }
      throw new AggregateError(cleanupErrors, 'Studio tooling smoke cleanup failed');
    }
  }
}

try {
  await main();
} catch (err) {
  console.error(`\n❌ regular Studio tooling smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
