/** Luau shared by the Studio probes; kept apart so their pure tests import no client. */

/**
 * Luau defining `vertexColors(meshId)`: how many distinct vertex colours a mesh
 * holds, read through EditableMesh, or `{ error }` when Studio refuses.
 */
export const VERTEX_COLORS_LUAU = `
local AssetService = game:GetService("AssetService")
local function rgb(c) return { math.floor(c.R * 255 + 0.5), math.floor(c.G * 255 + 0.5), math.floor(c.B * 255 + 0.5) } end
local function vertexColors(meshId)
  if meshId == nil or meshId == "" then return { error = "no MeshId" } end
  local ok, mesh = pcall(function() return AssetService:CreateEditableMeshAsync(Content.fromUri(meshId)) end)
  if not ok then
    local firstError = tostring(mesh)
    ok, mesh = pcall(function() return AssetService:CreateEditableMeshAsync(meshId) end)
    if not ok then return { error = firstError .. " / " .. tostring(mesh) } end
  end
  local seen, sample, total, distinct = {}, {}, 0, 0
  local okRead, readError = pcall(function()
    for _, id in ipairs(mesh:GetColors()) do
      total += 1
      local key = table.concat(rgb(mesh:GetColor(id)), ",")
      if not seen[key] then
        seen[key] = true
        distinct += 1
        if #sample < 8 then table.insert(sample, key) end
      end
    end
  end)
  pcall(function() mesh:Destroy() end)
  if not okRead then return { error = tostring(readError) } end
  return { total = total, distinct = distinct, sample = sample }
end
`.trim();
