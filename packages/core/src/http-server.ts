import express from 'express';
import type { Express } from 'express';
import http from 'http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { RobloxStudioTools } from './tools/index.js';
import { BridgeService, RoutingFailure, toPublic } from './bridge-service.js';
import type { RegisterInstanceResult } from './bridge-service.js';
import type { ToolDefinition } from './tools/definitions.js';
import { createToolHttpHandler, normalizeToolResult, publicToolErrorBody } from './mcp-runtime.js';
import { tokensMatch } from './auth.js';
import { StudioLaunchPreDispatchError } from './studio-instance-manager.js';
import type { PluginVariant } from './install-plugin-helpers.js';
import {
  SseStudioTransport,
  MAX_ACTIVE_EVENT_STREAMS,
  type EventStreamHandle,
  type StudioStatusEvent,
} from './studio-transport.js';

export interface HttpSecurityOptions {
  /** When set, tool-invoking endpoints require this token. */
  authToken?: string;
  /** Where the token came from — used to build a helpful 401 message. */
  authTokenHint?: string;
  /** Origins allowed to make cross-origin (browser) requests. Default: none. */
  allowedOrigins?: string[];
}

export interface RobloxStudioHttpApp extends Express {
  isPluginConnected(): boolean;
  setMCPServerActive(active: boolean): void;
  isMCPServerActive(): boolean;
  trackMCPActivity(): void;
  closeMcpHandler(): Promise<void> | undefined;
  cleanup(): Promise<void>;
}

interface StreamableHttpConfig {
  name: string;
  version: string;
  tools: ToolDefinition[];
  /** The plugin build this server pairs with; see ServerConfig.pluginVariant. */
  pluginVariant?: PluginVariant;
}

export type ToolHandler = (tools: RobloxStudioTools, body: any) => Promise<any>;

type ParsedLineRange = {
  startLine?: number;
  endLine?: number;
};

/**
 * Normalize a line_range string into internal [startLine, endLine] coordinates.
 * Accepts "100-200", "100:200", open-ended "100-" / "-200", or a single "42".
 * Returns undefined when nothing usable is present.
 */
export function parseLineRange(lineRange: unknown): ParsedLineRange | undefined {
  const validLine = (line: number | undefined) => line === undefined || line >= 1;
  if (typeof lineRange === 'string') {
    const ranged = lineRange.match(/^\s*(\d+)?\s*[-:]\s*(\d+)?\s*$/);
    if (ranged) {
      const s = ranged[1] !== undefined ? parseInt(ranged[1], 10) : undefined;
      const e = ranged[2] !== undefined ? parseInt(ranged[2], 10) : undefined;
      if (!validLine(s) || !validLine(e)) return undefined;
      if (s !== undefined && e !== undefined && s > e) return undefined;
      if (s !== undefined || e !== undefined) return { startLine: s, endLine: e };
    }
    const single = lineRange.match(/^\s*(\d+)\s*$/);
    if (single) {
      const n = parseInt(single[1], 10);
      if (n < 1) return undefined;
      return { startLine: n, endLine: n };
    }
  }
  return undefined;
}

function optionalLineRange(body: any, toolName: string): ParsedLineRange {
  if (body.line_range === undefined) return {};
  const parsed = parseLineRange(body.line_range);
  if (!parsed) throw new Error(`${toolName} line_range must be a string like "42", "10-20", "10-", or "-20"`);
  return parsed;
}

/**
 * An edit anchors on the line where old_string begins; where it ends is implied
 * by old_string itself, so a single "42" is the natural shape. A closed "N-M" is
 * accepted as well, because the sibling line tools take a range and a caller
 * reaches for the same shape here — but M is checked against the span old_string
 * covers rather than quietly discarded, so a range that means something else is
 * still refused.
 */
function optionalLineAnchor(body: any, toolName: string): number | undefined {
  const { startLine, endLine } = optionalLineRange(body, toolName);
  if (startLine === undefined && endLine === undefined) return undefined;
  if (startLine === undefined || endLine === undefined) {
    throw new Error(`${toolName} line_range must be a single line like "42" or a closed range like "42-48"`);
  }
  if (endLine === startLine) return startLine;

  const oldString = body.old_string;
  // A missing old_string is the tool's own required-argument error to report.
  if (typeof oldString !== 'string') return startLine;

  const lastLine = startLine + oldString.split('\n').length - 1;
  // A trailing newline reads either way: for text ending after line 47, both
  // "40-47" and "40-48" describe the same edit.
  const trailingNewline = oldString.endsWith('\n');
  if (endLine === lastLine || (trailingNewline && endLine === lastLine - 1)) return startLine;

  const covered = trailingNewline ? lastLine - 1 : lastLine;
  throw new Error(
    `${toolName} line_range "${startLine}-${endLine}" disagrees with old_string, which covers lines ${startLine}-${covered}. `
    + `Pass "${startLine}" to anchor on the first line of old_string, or correct the range.`
  );
}

/**
 * Normalize a batch's per-edit line anchors with the same rule a single edit
 * uses, so `edit_script_batch` and `edit_script_lines` cannot disagree about
 * what a `line_range` on an edit means.
 */
function batchEdits(body: any, toolName: string): unknown {
  if (!Array.isArray(body.edits)) return body.edits;
  return body.edits.map((entry: any, index: number) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const startLine = optionalLineAnchor(entry, `${toolName} edit ${index + 1}`);
    // `line_range` has been resolved into `startLine`; carrying both to the
    // plugin would leave two spellings of the same anchor to disagree.
    const normalized: Record<string, unknown> = { ...entry };
    delete normalized.line_range;
    if (startLine !== undefined) normalized.startLine = startLine;
    return normalized;
  });
}

function requiredClosedLineRange(body: any, toolName: string): { startLine: number; endLine: number } {
  const parsed = optionalLineRange(body, toolName);
  if (parsed.startLine === undefined || parsed.endLine === undefined) {
    throw new Error(`${toolName} requires line_range as "start-end" or a single line like "42"`);
  }
  return { startLine: parsed.startLine, endLine: parsed.endLine };
}

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  get_roblox_skills: (tools, body) => tools.getRobloxSkills(body.action, body.name),
  get_roblox_docs: (tools, body) => tools.getRobloxDocs(body.name, body.doc_type, body.section),
  get_place_info: (tools, body) => tools.getPlaceInfo(body.instance_id),
  search_objects: (tools, body) => tools.searchObjects(body.query, body.searchType, body.propertyName, body.instance_id),
  get_instance_properties: (tools, body) => tools.getInstanceProperties(body.instancePath, body.excludeSource, body.instance_id, body.instanceRef),
  get_project_structure: (tools, body) => tools.getProjectStructure(body.path, body.maxDepth, body.scriptsOnly, body.instance_id, body.instanceRef),
  set_properties: (tools, body) => tools.setProperties(body.instancePath, body.properties, body.instance_id, body.instanceRef),
  build_instances: (tools, body) => tools.buildInstances(body.path, body.operations, body.instance_id),
  grep_scripts: (tools, body) => tools.grepScripts(body.pattern, {
    caseSensitive: body.caseSensitive,
    usePattern: body.usePattern,
    contextLines: body.contextLines,
    maxResults: body.maxResults,
    maxResultsPerScript: body.maxResultsPerScript,
    filesOnly: body.filesOnly,
    path: body.path,
    classFilter: body.classFilter,
  }, body.instance_id),
  get_script_source: (tools, body) => {
    const { startLine, endLine } = optionalLineRange(body, 'get_script_source');
    return tools.getScriptSource(body.instancePath, startLine, endLine, body.instance_id, body.instanceRef);
  },
  set_script_source: (tools, body) => tools.setScriptSource(body.instancePath, body.source, body.instance_id, body.expectedRevision, body.instanceRef),
  edit_script_lines: (tools, body) => tools.editScriptLines(body.instancePath, body.old_string, body.new_string, optionalLineAnchor(body, 'edit_script_lines'), body.instance_id, body.instanceRef),
  edit_script_batch: (tools, body) => tools.editScriptBatch(body.instancePath, batchEdits(body, 'edit_script_batch'), body.instance_id, body.expectedRevision, body.instanceRef),
  insert_script_lines: (tools, body) => tools.insertScriptLines(body.instancePath, body.afterLine, body.newContent, body.instance_id, body.instanceRef, body.expectedRevision),
  delete_script_lines: (tools, body) => {
    const { startLine, endLine } = requiredClosedLineRange(body, 'delete_script_lines');
    return tools.deleteScriptLines(body.instancePath, startLine, endLine, body.instance_id, body.instanceRef, body.expectedRevision);
  },
  get_attributes: (tools, body) => tools.getAttributes(body.instancePath, body.instance_id),
  selection: (tools, body) => tools.selection(body.action, body, body.instance_id),
  execute_luau: (tools, body) => tools.executeLuau(body.code, body.target, body.instance_id),
  eval_server_runtime: (tools, body) => tools.evalServerRuntime(body.code, body.instance_id),
  eval_client_runtime: (tools, body) => tools.evalClientRuntime(body.code, body.target, body.instance_id),
  set_network_profile: (tools, body) => tools.setNetworkProfile(body.profile, body.target, body.overrides, body.instance_id),
  get_simulation_state: (tools, body) => tools.getSimulationState(body.include, body.target, body.instance_id),
  reset_simulation_state: (tools, body) => tools.resetSimulationState(body.target, body.network, body.deviceSimulator, body.instance_id),
  get_device_simulator_state: (tools, body) => tools.getDeviceSimulatorState(body.target, body.deviceId, body.includeDeviceList, body.instance_id),
  set_device_simulator: (tools, body) => tools.setDeviceSimulator(body.target, body.deviceId, body.orientation, body.resolution, body.pixelDensity, body.scalingMode, body.stopSimulation, body.instance_id),
  capture_device_matrix: (tools, body) => tools.captureDeviceMatrix(body.entries, body.target, body.format, body.quality, body.settleSeconds, body.restoreAfter, body.instance_id),
  manage_instance: (tools, body) => tools.manageInstance(body),
  solo_playtest: (tools, body) => tools.soloPlaytest(body.action, body.mode, body.timeout, body.instance_id),
  multiplayer_playtest: (tools, body) => tools.multiplayerPlaytest(body.action, body.numPlayers, body.target, body.testArgs, body.value, body.timeout, body.instance_id),
  get_runtime_logs: (tools, body) => tools.getRuntimeLogs(body.target, body.since, body.tail, body.filter, body.instance_id),
  capture_script_profiler: (tools, body) => tools.captureScriptProfiler(body.target, {
    duration_ms: body.duration_ms,
    frequency: body.frequency,
    max_functions: body.max_functions,
    min_total_us: body.min_total_us,
    filter: body.filter,
    include_native: body.include_native,
    include_plugin: body.include_plugin,
    output_path: body.output_path,
  }, body.instance_id),
  capture_micro_profiler: (tools, body) => tools.captureMicroProfiler(body.target, {
    duration_ms: body.duration_ms,
    focus: body.focus,
    filter: body.filter,
    max_timers: body.max_timers,
    min_total_us: body.min_total_us,
    include_idle: body.include_idle,
    include_gpu: body.include_gpu,
    max_events: body.max_events,
    frame_window: body.frame_window,
    max_groups: body.max_groups,
    max_timers_per_group: body.max_timers_per_group,
    max_related_timers: body.max_related_timers,
    summary_output_path: body.summary_output_path,
    baseline_path: body.baseline_path,
    baseline: body.baseline,
    baseline_label: body.baseline_label,
    current_label: body.current_label,
    max_comparison_rows: body.max_comparison_rows,
    include_comparison_index: body.include_comparison_index,
    output_path: body.output_path,
  }, body.instance_id),
  breakpoints: (tools, body) => tools.breakpoints(body.action, body, body.target, body.instance_id),
  get_connected_instances: (tools) => tools.getConnectedInstances(),
  search_assets: (tools, body) => tools.searchAssets(body.assetType, body.query, body.maxResults, body.sortBy, body.robloxCreatedOnly),
  get_asset_details: (tools, body) => tools.getAssetDetails(body.assetId),
  get_asset_thumbnail: (tools, body) => tools.getAssetThumbnail(body.assetId, body.size),
  insert_asset: (tools, body) => tools.insertAsset(body.assetId, body.parentPath, body.position, body.instance_id),
  generate_model: (tools, body) => tools.generateModel(body, body.instance_id),
  preview_asset: (tools, body) => tools.previewAsset(
    body.assetId,
    body.includeProperties,
    body.maxDepth,
    body.instance_id,
    body.includeAudio,
    body.maxAudioPreviews,
  ),
  upload_asset: (tools, body) => tools.uploadAsset(
    body.filePath,
    body.assetType,
    body.displayName,
    body.description,
    body.userId,
    body.groupId,
    body.action,
    body.operationId,
    body.instance_id,
  ),
  capture_screenshot: (tools, body) => tools.captureScreenshot(body.instance_id, body.format, body.quality),
  inspect_ui: (tools, body) => tools.inspectUi(
    body.mode,
    body.root,
    body.visible_only,
    body.max_depth,
    body.max_nodes,
    body.include_text,
    body.include_styles,
    body.target,
    body.instance_id,
  ),
  interact_ui: (tools, body) => tools.interactUi(
    body.action,
    body.selector,
    body.text,
    body.canvas_position,
    body.target,
    body.instance_id,
  ),
  simulate_mouse_input: (tools, body) => tools.simulateMouseInput(body.action, body.x, body.y, body.button, body.scrollDirection, body.target, body.instance_id),
  simulate_keyboard_input: (tools, body) => tools.simulateKeyboardInput(body.keyCode, body.action, body.duration, body.text, body.target, body.instance_id),
  get_memory_breakdown: (tools, body) => tools.getMemoryBreakdown(body.target, body.tags, body.instance_id),
  get_scene_analysis: (tools, body) => tools.getSceneAnalysis(body.mode, body.target, body.topN, body.raw, body.instance_id),
  export_rbxm: (tools, body) => tools.exportRbxm(body.instance_paths, body.output_path, body.target, body.instance_id),
  import_rbxm: (tools, body) => tools.importRbxm(body.source, body.parent_path, body.target, body.instance_id),
  find_and_replace_in_scripts: (tools, body) => tools.findAndReplaceInScripts(body.pattern, body.replacement, {
    caseSensitive: body.caseSensitive,
    usePattern: body.usePattern,
    path: body.path,
    classFilter: body.classFilter,
    dryRun: body.dryRun,
    maxReplacements: body.maxReplacements,
  }, body.instance_id),
};

export function createHttpServer(tools: RobloxStudioTools, bridge: BridgeService, allowedTools?: Set<string>, serverConfig?: StreamableHttpConfig, security?: HttpSecurityOptions): RobloxStudioHttpApp {
  // Express cannot know about the lifecycle controls attached below.
  const app = express() as unknown as RobloxStudioHttpApp;
  const studioLifecycleCallable = !allowedTools || allowedTools.has('manage_instance');
  const studioLifecycleCapabilities = studioLifecycleCallable
    ? tools.getStudioLifecycleCapabilities()
    : undefined;
  let mcpServerActive = false;
  let lastMCPActivity = 0;
  let mcpServerStartTime = 0;
  const proxyInstances = new Set<string>();
  const rejectedVersionSessions = new Set<string>();
  const eventTransport = new SseStudioTransport(bridge);
  const eventStreamHandles = new Set<EventStreamHandle>();

  const setMCPServerActive = (active: boolean) => {
    mcpServerActive = active;
    if (active) {
      mcpServerStartTime = Date.now();
      lastMCPActivity = Date.now();
    } else {
      mcpServerStartTime = 0;
      lastMCPActivity = 0;
    }
    eventTransport.refreshStatus();
  };

  const trackMCPActivity = () => {
    if (mcpServerActive) {
      const wasConnected = (Date.now() - lastMCPActivity) < 30000;
      lastMCPActivity = Date.now();
      if (!wasConnected) eventTransport.refreshStatus();
    }
  };

  const isMCPServerActive = () => {
    if (!mcpServerActive) return false;
    return (Date.now() - lastMCPActivity) < 30000;
  };

  const eventStatus = (physicalSessionId: string): StudioStatusEvent => {
    const instance = bridge.getInstanceBySessionId(physicalSessionId);
    const knownInstance = instance?.physicalSessionId === physicalSessionId;
    return {
      kind: 'status',
      knownInstance,
      mcpConnected: isMCPServerActive(),
      serverVersion: serverConfig?.version,
      pluginVersion: instance?.pluginVersion,
      pluginVariant: instance?.pluginVariant,
    };
  };

  const isPluginConnected = () => {
    return bridge.getInstances().length > 0;
  };

  // -- Origin policy --
  // The Studio plugin is a native HTTP client and never sends an Origin
  // header. Any request that DOES carry one comes from a browser context; we
  // reject it unless the origin is explicitly allowlisted. This replaces the
  // previous blanket `cors()` (allow-all), which let any web page drive the
  // API via the victim's browser.
  const allowedOrigins = new Set(security?.allowedOrigins ?? []);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === '') {
      next();
      return;
    }
    if (!allowedOrigins.has(origin)) {
      res.status(403).json({
        error: 'forbidden_origin',
        message: `Cross-origin requests are not allowed from ${origin}. ` +
          'Set ROBLOX_STUDIO_ALLOWED_ORIGINS to allowlist specific origins.',
      });
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-MCP-Auth, Mcp-Protocol-Version, Mcp-Method, Mcp-Name');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // -- Shared-secret auth --
  // Tool-invoking endpoints require the token; plugin-facing endpoints
  // (/ready, /events, /response, /disconnect) and passive status endpoints
  // stay open because the Studio plugin cannot read local files. These routes
  // only register or receive downstream work; they cannot invoke tools.
  const authToken = security?.authToken;
  const authRequired = (path: string) =>
    path === '/mcp' || path.startsWith('/mcp/') ||
    path === '/proxy' || path === '/instances' || path === '/unregister-instance-id';
  app.use((req, res, next) => {
    if (!authToken || !authRequired(req.path)) {
      next();
      return;
    }
    const headerToken = req.headers['x-mcp-auth'];
    const bearer = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice('Bearer '.length)
      : undefined;
    const provided = typeof headerToken === 'string' && headerToken !== '' ? headerToken : bearer;
    if (provided !== undefined && tokensMatch(provided, authToken)) {
      next();
      return;
    }
    res.status(401).json({
      error: 'unauthorized',
      message: 'Missing or invalid auth token. Send it as "X-MCP-Auth: <token>" or "Authorization: Bearer <token>". ' +
        (security?.authTokenHint ?? 'The token is in ~/.robloxstudio-mcp/auth-token (or ROBLOX_STUDIO_AUTH_TOKEN).'),
    });
  });

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));


  app.get('/health', (req, res) => {
    const instances = bridge.getInstances();
    const publicInstances = instances.map(toPublic);
    res.json({
      status: 'ok',
      service: 'robloxstudio-mcp',
      serverName: serverConfig?.name ?? 'robloxstudio-mcp',
      version: serverConfig?.version,
      serverVersion: serverConfig?.version,
      capabilities: studioLifecycleCallable ? {
        studioLifecycle: {
          protocolVersion: 3,
          endpoint: '/mcp/manage_instance',
          hostPlatform: studioLifecycleCapabilities?.hostPlatform,
          windowsInteropAvailable: studioLifecycleCapabilities?.windowsInteropAvailable,
          processIdentity: studioLifecycleCapabilities?.processIdentity,
        },
      } : {},
      pluginConnected: instances.length > 0,
      instanceCount: instances.length,
      instances: publicInstances,
      mcpServerActive: isMCPServerActive(),
      uptime: mcpServerActive ? Date.now() - mcpServerStartTime : 0,
      pendingRequests: bridge.getPendingRequestCount(),
      proxyInstanceCount: proxyInstances.size,
      activeEventStreams: eventTransport.activeStreamCount,
      streamableHttp: !!serverConfig,
    });
  });


  app.post('/ready', (req, res) => {
    const {
      pluginSessionId,
      physicalSessionId,
      instanceId,
      role,
      placeId,
      placeName,
      dataModelName,
      isRunning,
      pluginVersion,
      pluginVariant,
    } = req.body;
    const requestContext = {
      physicalSessionId: typeof physicalSessionId === 'string' ? physicalSessionId : undefined,
      instanceId: typeof instanceId === 'string' ? instanceId : undefined,
      role: typeof role === 'string' ? role : undefined,
      placeId: typeof placeId === 'number' ? placeId : undefined,
      placeName: typeof placeName === 'string' ? placeName : undefined,
      dataModelName: typeof dataModelName === 'string' ? dataModelName : undefined,
      isRunning: typeof isRunning === 'boolean' ? isRunning : undefined,
      pluginVersion: typeof pluginVersion === 'string' ? pluginVersion : undefined,
      pluginVariant: typeof pluginVariant === 'string' ? pluginVariant : undefined,
    };

    const missingFields = [
      typeof pluginSessionId !== 'string' || pluginSessionId === '' ? 'pluginSessionId' : undefined,
      typeof physicalSessionId !== 'string' || physicalSessionId === '' ? 'physicalSessionId' : undefined,
      typeof instanceId !== 'string' || instanceId === '' ? 'instanceId' : undefined,
      typeof role !== 'string' || role === '' ? 'role' : undefined,
      typeof pluginVersion !== 'string' || pluginVersion === '' ? 'pluginVersion' : undefined,
      typeof pluginVariant !== 'string' || pluginVariant === '' ? 'pluginVariant' : undefined,
    ].filter((field): field is string => !!field);
    if (missingFields.length > 0) {
      res.status(400).json({
        success: false,
        error: 'missing_ready_fields',
        message: `/ready missing required field(s): ${missingFields.join(', ')}`,
        missingFields,
        request: requestContext,
      });
      return;
    }
    const serverVersion = serverConfig?.version;
    if (!serverVersion) {
      res.status(503).json({
        success: false,
        error: 'server_version_unavailable',
        message: 'The MCP server cannot accept Studio connections without a configured version.',
        request: requestContext,
      });
      return;
    }
    if (pluginVersion !== serverVersion) {
      if (!rejectedVersionSessions.has(pluginSessionId)) {
        if (rejectedVersionSessions.size >= 256) rejectedVersionSessions.clear();
        rejectedVersionSessions.add(pluginSessionId);
        console.error(
          `[plugin-version-rejected] Studio plugin v${pluginVersion} (${pluginVariant}) ` +
          `does not match MCP server v${serverVersion} for ${instanceId}/${role}`,
        );
      }
      res.status(426).json({
        success: false,
        error: 'plugin_version_mismatch',
        message: `Studio plugin v${pluginVersion} does not match MCP server v${serverVersion}.`,
        pluginVersion,
        serverVersion,
        request: requestContext,
      });
      return;
    }

    // A full plugin behind an inspector server, or an inspector plugin behind a
    // full server, would let one edition act through the other's promise: the
    // inspector plugin says "read-only" in Studio, and only the server decides
    // what it is sent.
    const expectedVariant = serverConfig?.pluginVariant;
    if (expectedVariant !== undefined && pluginVariant !== expectedVariant) {
      res.status(409).json({
        success: false,
        error: 'plugin_variant_mismatch',
        message: `This ${expectedVariant === 'inspector' ? 'read-only inspector' : 'full'} MCP server pairs with the `
          + `${expectedVariant} Studio plugin, not the ${pluginVariant} one. Install one plugin variant at a time.`,
        pluginVariant,
        expectedVariant,
        request: requestContext,
      });
      return;
    }

    const isClientRole = role === 'client' || /^client-[1-9]\d*$/.test(role);
    const isLogicalSession = physicalSessionId !== pluginSessionId;
    if (
      (isLogicalSession && !isClientRole) ||
      (!isLogicalSession && isClientRole) ||
      (!isClientRole && role !== 'edit' && role !== 'server')
    ) {
      res.status(400).json({
        success: false,
        error: 'invalid_session_topology',
        message: 'Physical sessions must use the edit or server role; client roles must use a distinct physical server session.',
        request: requestContext,
      });
      return;
    }

    if (isLogicalSession) {
      const physicalOwner = bridge.getInstanceBySessionId(physicalSessionId);
      const requestedInstanceId = typeof placeId === 'number' && Number.isFinite(placeId) && placeId > 0
        ? `place:${Math.trunc(placeId)}`
        : bridge.resolveInstanceId(instanceId);
      if (
        !physicalOwner ||
        physicalOwner.pluginSessionId !== physicalSessionId ||
        physicalOwner.physicalSessionId !== physicalSessionId ||
        physicalOwner.role !== 'server' ||
        physicalOwner.instanceId !== requestedInstanceId
      ) {
        res.status(409).json({
          success: false,
          error: 'physical_session_unavailable',
          message: 'A logical client requires a registered physical server session for the same Studio instance.',
          request: requestContext,
        });
        return;
      }
    }


    let result: RegisterInstanceResult;
    try {
      result = bridge.registerInstance({
        pluginSessionId,
        physicalSessionId,
        instanceId,
        role,
        placeId: typeof placeId === 'number' ? placeId : 0,
        placeName: typeof placeName === 'string' ? placeName : '',
        dataModelName: typeof dataModelName === 'string' ? dataModelName : '',
        isRunning: !!isRunning,
        pluginVersion,
        pluginVariant,
        serverVersion,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: 'ready_registration_exception',
        message: err instanceof Error ? err.message : String(err),
        request: requestContext,
      });
      return;
    }

    if (!result.ok) {
      res.status(409).json({
        success: false,
        error: result.error.code,
        message: result.error.message,
        request: requestContext,
        existing: result.error.existing,
      });
      return;
    }
    eventTransport.refreshStatus(physicalSessionId);

    res.json({
      success: true,
      assignedRole: result.assignedRole,
      instanceId: result.instanceId,
      serverVersion,
    });
  });


  app.post('/disconnect', (req, res) => {
    const { pluginSessionId } = req.body;

    if (pluginSessionId) {
      bridge.unregisterInstance(pluginSessionId);
    }
    res.json({ success: true });
  });

  app.post('/unregister-instance-id', (req, res) => {
    const { instanceId } = req.body;
    if (typeof instanceId !== 'string' || instanceId.length === 0) {
      res.status(400).json({ error: 'instanceId is required' });
      return;
    }

    const removed = bridge.unregisterInstanceId(instanceId);
    res.json({ success: true, removed });
  });


  app.get('/status', (req, res) => {
    const instances = bridge.getInstances();
    const publicInstances = instances.map(toPublic);
    res.json({
      pluginConnected: instances.length > 0,
      instanceCount: instances.length,
      instances: publicInstances,
      serverVersion: serverConfig?.version,
      mcpServerActive: isMCPServerActive(),
      lastMCPActivity,
      uptime: mcpServerActive ? Date.now() - mcpServerStartTime : 0
    });
  });


  app.get('/instances', (req, res) => {
    // Includes internal logical and physical transport session IDs so
    // proxy-mode subprocesses can reproduce PluginInstance for bookkeeping.
    // Neither identifier is exposed through MCP tools.
    const instances = bridge.getInstances();
    res.json({
      instances,
      serverVersion: serverConfig?.version,
    });
  });

  // Bytes an import request was too large to carry. Plugin-facing like
  // /response, single use, and useless without the id the request event named.
  app.get('/import-payload/:id', (req, res) => {
    const base64 = bridge.takeImportPayload(req.params.id);
    if (base64 === undefined) {
      res.status(404).json({ error: 'unknown_payload', message: 'That import payload is unknown or already collected.' });
      return;
    }
    res.json({ base64 });
  });

  app.get('/events', (req, res) => {
    const pluginSessionId = typeof req.query.pluginSessionId === 'string'
      ? req.query.pluginSessionId
      : undefined;
    if (!pluginSessionId) {
      res.status(400).json({
        error: 'missing_plugin_session_id',
        message: 'pluginSessionId is required',
      });
      return;
    }

    const instance = bridge.getInstanceBySessionId(pluginSessionId);
    if (!instance) {
      res.status(404).json({
        error: 'unknown_session',
        knownInstance: false,
      });
      return;
    }
    if (instance.physicalSessionId !== pluginSessionId) {
      res.status(409).json({
        error: 'logical_session_has_no_event_stream',
        physicalSessionId: instance.physicalSessionId,
      });
      return;
    }
    if (!eventTransport.canOpen(pluginSessionId)) {
      res.setHeader('Retry-After', '1');
      res.status(503).json({
        error: 'event_stream_capacity_reached',
        capacity: MAX_ACTIVE_EVENT_STREAMS,
      });
      return;
    }

    bridge.updateInstanceActivity(pluginSessionId);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const handle = eventTransport.open(
      pluginSessionId,
      res,
      () => eventStatus(pluginSessionId),
    );
    if (!handle) {
      res.end();
      return;
    }
    eventStreamHandles.add(handle);
    res.once('close', () => eventStreamHandles.delete(handle));
  });




  app.post('/response', (req, res) => {
    const { requestId, response, error } = req.body;
    if (typeof requestId !== 'string' || requestId.length === 0) {
      res.status(400).json({
        success: false,
        error: 'invalid_request_id',
      });
      return;
    }

    const disposition = error !== undefined
      ? bridge.rejectRequest(requestId, error)
      : bridge.resolveRequest(requestId, response);
    if (disposition === 'unknown') {
      res.status(404).json({ success: false, disposition });
      return;
    }

    res.json({ success: true, disposition });
  });


  app.post('/proxy', async (req, res) => {
    const { endpoint, data, targetInstanceId, targetRole, proxyInstanceId, pluginVariant } = req.body;

    if (!endpoint || !targetInstanceId || !targetRole) {
      res.status(400).json({ error: 'endpoint, targetInstanceId, and targetRole are required' });
      return;
    }
    // A proxy forwards raw plugin endpoints, past this server's own tool list.
    // Only a server of the same edition may do that, so an inspector primary
    // never carries a full server's writes. A proxy that does not say is the
    // full edition, which is what every server was before editions were named.
    const expectedVariant = serverConfig?.pluginVariant;
    const callerVariant = typeof pluginVariant === 'string' ? pluginVariant : 'main';
    if (expectedVariant !== undefined && callerVariant !== expectedVariant) {
      res.status(409).json({
        error: 'edition_mismatch',
        message: `The ${expectedVariant} MCP server already owns this port and will not forward requests for the `
          + `${callerVariant} edition. Run the editions on different ports with ROBLOX_STUDIO_PORT.`,
      });
      return;
    }

    if (proxyInstanceId) {
      proxyInstances.add(proxyInstanceId);
    }

    try {
      const response = await bridge.sendRequest(endpoint, data, targetInstanceId, targetRole);
      res.json({ response });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Proxy request failed' });
    }
  });


  // One v2 protocol boundary serves modern 2026-07-28 requests and the
  // stateless 2025 compatibility path from the same tool factory.
  const mcpHandler = serverConfig
    ? createToolHttpHandler({
        config: serverConfig,
        getTools: () => tools,
        allowedTools,
        invoke: async (currentTools, name, args) => {
          const handler = TOOL_HANDLERS[name];
          if (!handler) throw new Error(`Unknown tool: ${name}`);
          return handler(currentTools, args);
        },
      })
    : undefined;
  const nodeMcpHandler = mcpHandler ? toNodeHandler(mcpHandler) : undefined;

  if (nodeMcpHandler) {
    app.all('/mcp', async (req, res) => {
      trackMCPActivity();
      await nodeMcpHandler(req, res, req.body);
    });
  }

  app.use('/mcp/*', (req, res, next) => {
    trackMCPActivity();
    next();
  });

  // Register /mcp/* routes dynamically based on allowedTools
  for (const [toolName, handler] of Object.entries(TOOL_HANDLERS)) {
    if (allowedTools && !allowedTools.has(toolName)) continue;

    app.post(`/mcp/${toolName}`, async (req, res) => {
      try {
        const result = normalizeToolResult(await handler(tools, req.body), 'modern');
        if (result.structuredContent && result.content.length === 0) {
          res.json(result.structuredContent);
        } else {
          res.json(result);
        }
      } catch (error) {
        const status = error instanceof StudioLaunchPreDispatchError
          ? error.statusCode
          : error instanceof RoutingFailure ? 400 : 500;
        res.status(status).json(publicToolErrorBody(toolName, error));
      }
    });
  }


  app.isPluginConnected = isPluginConnected;
  app.setMCPServerActive = setMCPServerActive;
  app.isMCPServerActive = isMCPServerActive;
  app.trackMCPActivity = trackMCPActivity;
  app.closeMcpHandler = () => mcpHandler?.close();
  app.cleanup = async () => {
    for (const handle of eventStreamHandles) handle.close();
    eventStreamHandles.clear();
    eventTransport.close();
    await mcpHandler?.close();
  };

  return app;
}

/**
 * Attempt to bind an Express app to a port, using an explicit http.Server
 * so that EADDRINUSE errors are properly caught.
 */
export async function listenWithRetry(
  app: express.Express,
  host: string,
  startPort: number,
  maxAttempts: number = 5
): Promise<{ server: http.Server; port: number }> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    try {
      return { server: await bindPort(app, host, port), port };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      console.error(`Port ${port} in use, trying next...`);
    }
  }
  throw new Error(`All ports ${startPort}-${startPort + maxAttempts - 1} are in use. Stop some MCP server instances and retry.`);
}

function bindPort(app: express.Express, host: string, port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('error', onError);
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(server);
    });
  });
}
