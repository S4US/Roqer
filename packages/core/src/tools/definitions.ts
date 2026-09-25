import type { ToolAnnotations } from '@modelcontextprotocol/server';
import { MAX_PNG_BASE64_CHARACTERS } from '../image-decode.js';

export type ToolCategory = 'read' | 'write';

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: object;
  outputSchema?: object;
  annotations?: ToolAnnotations;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // === File & Instance Browsing ===
  // === Place & Service Info ===
  {
    name: 'get_place_info',
    category: 'read',
    description: 'Use when you need the current place\'s identity or settings.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      }
    }
  },
  {
    name: 'search_objects',
    category: 'read',
    description: 'Use to find instances by name, class, or property value.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text, class, or property value to match.'
        },
        searchType: {
          type: 'string',
          enum: ['name', 'class', 'property'],
          description: 'Field to search; defaults to name.'
        },
        propertyName: {
          type: 'string',
          description: 'Property to search when searchType is property.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['query']
    }
  },

  // === Instance Inspection ===
  {
    name: 'get_instance_properties',
    category: 'read',
    description: 'Use to inspect properties.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Target path.'
        },
        instanceRef: {
          type: 'string',
          description: 'Opaque ref; overrides path.'
        },
        excludeSource: {
          type: 'boolean',
          description: 'Omit Source text.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place.'
        }
      },
      required: ['instancePath']
    }
  },
  // === Project Structure ===
  {
    name: 'get_project_structure',
    category: 'read',
    description: 'Use to inspect a subtree.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Root; defaults to Workspace.'
        },
        maxDepth: {
          type: 'number',
          description: 'Depth; defaults to 3.'
        },
        scriptsOnly: {
          type: 'boolean',
          description: 'Only scripts.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      }
    }
  },
  {
    name: 'set_properties',
    category: 'write',
    description: 'Use to set properties atomically.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Target path.'
        },
        instanceRef: {
          type: 'string',
          description: 'Opaque ref; overrides path.'
        },
        properties: {
          type: 'object',
          description: 'New values.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place.'
        }
      },
      required: ['instancePath', 'properties']
    }
  },
  {
    name: 'build_instances',
    category: 'write',
    description: 'Use to build, edit, remove, or scatter instances atomically under one root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Build root; created if missing.'
        },
        operations: {
          type: 'array',
          description: 'Steps; all apply or none do.',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: ['create', 'clone', 'set', 'remove', 'scatter'],
                description: 'Step kind.'
              },
              id: {
                type: 'string',
                description: 'Name for later $id references.'
              },
              className: {
                type: 'string',
                description: 'Class to create.'
              },
              source: {
                type: 'string',
                description: 'Clone template path or $id.'
              },
              parent: {
                type: 'string',
                description: 'Parent path or $id; default root.'
              },
              target: {
                type: 'string',
                description: 'Set or remove target path or $id.'
              },
              name: {
                type: 'string',
                description: 'Instance name.'
              },
              properties: {
                type: 'object',
                description: 'Property values by name.'
              },
              position: {
                type: 'array',
                items: { type: 'number' },
                description: 'World [x, y, z] position.'
              },
              rotation: {
                type: 'array',
                items: { type: 'number' },
                description: 'Orientation [x,y,z] degrees; scatter uses [minYaw,maxYaw], default [0,360].'
              },
              transforms: {
                type: 'array',
                description: 'Each {position, rotation, scale}.',
                items: { type: 'object' }
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Tags to add.'
              },
              attributes: {
                type: 'object',
                description: 'Attributes: string, number, bool.'
              },
              zone: {
                type: 'object',
                description: 'Scatter XZ rectangle: {min:[x,z],max:[x,z]}.'
              },
              density: {
                type: 'number',
                description: 'Scatter target per 10,000 square studs; floor(area*density/10000), 1-1000.'
              },
              seed: {
                type: 'integer', minimum: 0, maximum: 2147483646,
                description: 'Scatter deterministic seed.'
              },
              templates: {
                type: 'array', items: { type: 'object' },
                description: 'Scatter 1-16 {source:path,weight:positive,kit?:string}.'
              },
              ground: {
                type: 'array', items: { type: 'string' },
                description: 'Scatter 1-16 live Workspace ground paths; raycasts include only these.'
              },
              raycast: {
                type: 'object',
                description: 'Scatter {top,bottom}: world Y search interval, at most 100000 studs.'
              },
              scale: {
                type: 'array', items: { type: 'number' },
                description: 'Scatter [min,max] scale, 0.05-20; default [1,1].'
              },
              spacing: {
                type: 'number', minimum: 0,
                description: 'Scatter extra clearance between footprint circles; default 0.'
              },
              avoid: {
                type: 'array', items: { type: 'object' },
                description: 'Scatter up to 16 {tag,distance} rules; distance is extra clearance from bounds.'
              },
              maxSlope: {
                type: 'number', minimum: 0, maximum: 89,
                description: 'Scatter maximum surface slope in degrees; default 30.'
              },
              replace: {
                type: 'boolean',
                description: 'Scatter replaces only its owned named group; default false. Scatter must be the sole step.'
              }
            },
            required: ['op']
          }
        },
        instance_id: {
          type: 'string',
          description: 'Connected place.'
        }
      },
      required: ['path', 'operations']
    }
  },

  // === Calculated/Relative Properties ===
  // === Script Read/Write ===
  {
    name: 'get_script_source',
    category: 'read',
    description: 'Use to read script source.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Script path.'
        },
        instanceRef: {
          type: 'string',
          description: 'Opaque ref; overrides path.'
        },
        line_range: {
          type: 'string',
          description: 'Lines: N, N-M, N-, or -M.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place.'
        }
      },
      required: ['instancePath']
    }
  },
  {
    name: 'set_script_source',
    category: 'write',
    description: 'Use to replace full script source safely.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Script path.'
        },
        instanceRef: {
          type: 'string',
          description: 'Opaque ref; overrides path.'
        },
        source: {
          type: 'string',
          description: 'Replacement source.'
        },
        expectedRevision: {
          type: 'string',
          description: 'Read revision.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place.'
        }
      },
      required: ['instancePath', 'source', 'expectedRevision']
    }
  },
  {
    name: 'edit_script_lines',
    category: 'write',
    description: 'Use for an exact, localized replacement in one script.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path of the script.'
        },
        old_string: {
          type: 'string',
          description: 'Exact text; must be unique unless line_range is set.'
        },
        new_string: {
          type: 'string',
          description: 'Replacement source text.'
        },
        line_range: {
          type: 'string',
          description: 'Line where old_string starts, or "N-M" covering it.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['instancePath', 'old_string', 'new_string']
    }
  },
  {
    name: 'edit_script_batch',
    category: 'write',
    description: 'Use for several exact, non-overlapping replacements in one script, applied as one transaction.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path of the script.'
        },
        instanceRef: {
          type: 'string',
          description: 'Opaque ref; overrides path.'
        },
        edits: {
          type: 'array',
          maxItems: 20,
          description: 'Each {old_string, new_string, line_range?}; all applied together or none.',
          items: {
            type: 'object',
            properties: {
              old_string: {
                type: 'string',
                description: 'Exact text; must be unique unless line_range is set.'
              },
              new_string: {
                type: 'string',
                description: 'Replacement source text.'
              },
              line_range: {
                type: 'string',
                description: 'Line where old_string starts, or "N-M" covering it.'
              }
            },
            required: ['old_string', 'new_string'],
            additionalProperties: false
          }
        },
        expectedRevision: {
          type: 'string',
          description: 'Read revision; refuses the batch if the script changed.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['instancePath', 'edits', 'expectedRevision']
    }
  },
  {
    name: 'insert_script_lines',
    category: 'write',
    description: 'Use to add source after a known line in one script.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path of the script.'
        },
        afterLine: {
          type: 'number',
          description: 'Line to insert after; 0 means before line 1.'
        },
        newContent: {
          type: 'string',
          description: 'Source text to insert.'
        },
        expectedRevision: {
          type: 'string',
          description: 'Read revision; refuses the edit if the script changed.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['instancePath', 'newContent']
    }
  },
  {
    name: 'delete_script_lines',
    category: 'write',
    description: 'Use to remove a known inclusive line range from one script.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path of the script.'
        },
        line_range: {
          type: 'string',
          description: 'Inclusive "N-M" or "N" range; open ends are invalid.'
        },
        expectedRevision: {
          type: 'string',
          description: 'Read revision; refuses the edit if the script changed.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['instancePath', 'line_range']
    }
  },
  {
    name: 'get_attributes',
    category: 'read',
    description: 'Use to inspect every attribute on one instance.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path of the instance.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['instancePath']
    }
  },

  // === Selection ===
  {
    name: 'selection',
    category: 'read',
    description: 'Use to get, set, open, or frame Studio context.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'open', 'view'],
          description: 'Open shows a script; view frames a 3D target.'
        },
        paths: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: 'Set needs paths; empty clears in set mode.'
        },
        mode: {
          type: 'string',
          enum: ['set', 'add', 'remove'],
          default: 'set',
          description: 'How set applies paths.'
        },
        path: {
          type: 'string',
          minLength: 1,
          description: 'Open and view need an instance path.'
        },
        from: {
          type: 'number',
          description: 'View azimuth: 0 +X, 90 +Z.'
        },
        padding: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: 10,
          default: 1,
          description: 'View distance scale.'
        },
        angleY: {
          type: 'number',
          minimum: -89,
          maximum: 89,
          description: 'View elevation in degrees.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID if multiple are open.'
        }
      },
      required: ['action']
    }
  },

  {
    name: 'execute_luau',
    category: 'write',
    description: 'Use for custom Studio traversal, edits, or peer execution.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Luau code to execute.'
        },
        target: {
          type: 'string',
          description: 'Execution peer; defaults to edit.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['code']
    }
  },
  {
    name: 'eval_server_runtime',
    category: 'write',
    description: 'Use to run Luau in the live server VM with its require cache.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Luau code; return a value to include it in the result.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['code']
    }
  },
  {
    name: 'eval_client_runtime',
    category: 'write',
    description: 'Use to run Luau in a live client VM with its require cache.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Luau code; return a value to include it in the result.'
        },
        target: {
          type: 'string',
          description: 'Client peer; defaults to client-1.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['code']
    }
  },

  // === Script Search ===
  {
    name: 'grep_scripts',
    category: 'read',
    description: 'Use to locate text or Lua pattern matches across script sources.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          minLength: 1,
          description: 'Literal text, or a Lua pattern when usePattern is true. To list scripts instead, use get_project_structure with scriptsOnly.'
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Literal match casing; patterns are always case-sensitive.'
        },
        usePattern: {
          type: 'boolean',
          description: 'Use Lua patterns with top-level | alternation; not PCRE.'
        },
        contextLines: {
          type: 'number',
          description: 'Lines before and after each match; defaults to 0.'
        },
        maxResults: {
          type: 'number',
          description: 'Total match limit; defaults to 100.'
        },
        maxResultsPerScript: {
          type: 'number',
          description: 'Match limit per script.'
        },
        filesOnly: {
          type: 'boolean',
          description: 'Return only script paths; defaults to false.'
        },
        path: {
          type: 'string',
          description: 'Canonical subtree to search.'
        },
        classFilter: {
          type: 'string',
          enum: ['Script', 'LocalScript', 'ModuleScript'],
          description: 'Script class to include.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['pattern']
    }
  },

  // === Studio Instance Management ===
  {
    name: 'manage_instance',
    category: 'write',
    description: 'Use to manage Studio processes or list place revisions.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['launch', 'authorize', 'complete', 'close', 'status', 'list_place_versions'],
          description: 'Operation; authorize and complete only resume identity launches.'
        },
        source: {
          type: 'string',
          enum: ['baseplate', 'local_file', 'published_place', 'place_revision'],
          description: 'Launch source; local_file needs path, published needs place_id.'
        },
        local_place_file: {
          type: 'string',
          description: '.rbxl or .rbxlx path; required for local_file.'
        },
        place_id: {
          type: 'number',
          description: 'Place ID; required for published sources and version listing.'
        },
        place_version: {
          type: 'number',
          description: 'Revision number; required for place_revision.'
        },
        require_process_identity: {
          type: 'boolean',
          description: 'Require PID attestation and explicit authorization.'
        },
        wait_for_connection: {
          type: 'boolean',
          description: 'Wait for instance_id; false returns launch_id.'
        },
        timeout_ms: {
          type: 'number',
          description: 'Plugin timeout in ms; default 120000; ignored in identity mode.'
        },
        studio_working_directory: {
          type: 'string',
          description: 'Studio process working directory; isolates relative plugin folders per launch.'
        },
        max_page_size: {
          type: 'number',
          description: 'Versions per page; clamped to 1-50, default 10.'
        },
        page_token: {
          type: 'string',
          description: 'Prior list_place_versions page token.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected instance for close or status; excludes launch_id.'
        },
        launch_id: {
          type: 'string',
          description: 'Launch for close or status; excludes instance_id.'
        }
      },
      required: ['action']
    }
  },

  // === Playtest ===
  {
    name: 'solo_playtest',
    category: 'write',
    description: 'Use to start, stop, or inspect a single-player Studio playtest.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'status'],
          description: 'Lifecycle action to run.'
        },
        mode: {
          type: 'string',
          enum: ['play', 'run'],
          description: 'Required for action="start".'
        },
        timeout: {
          type: 'number',
          description: 'Wait in seconds; start defaults to 60 and stop to 15.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'set_network_profile',
    category: 'write',
    description: 'Use to simulate client latency, jitter, or packet loss.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          enum: ['great', 'good', 'poor', 'custom'],
          description: 'Network preset; custom requires overrides.'
        },
        target: {
          type: 'string',
          description: 'Client peer or all-clients; defaults to client-1.'
        },
        overrides: {
          type: 'object',
          additionalProperties: false,
          properties: {
            InboundNetworkMinDelayMs: {
              type: 'number',
              minimum: 0,
              description: 'Server-to-client minimum delay in ms.'
            },
            OutboundNetworkMinDelayMs: {
              type: 'number',
              minimum: 0,
              description: 'Client-to-server minimum delay in ms.'
            },
            InboundNetworkJitterMs: {
              type: 'number',
              minimum: 0,
              description: 'Server-to-client jitter in ms.'
            },
            OutboundNetworkJitterMs: {
              type: 'number',
              minimum: 0,
              description: 'Client-to-server jitter in ms.'
            },
            InboundNetworkLossPercent: {
              type: 'number',
              minimum: 0,
              maximum: 0.5,
              description: 'Server-to-client packet loss percent.'
            },
            OutboundNetworkLossPercent: {
              type: 'number',
              minimum: 0,
              maximum: 0.5,
              description: 'Client-to-server packet loss percent.'
            }
          },
          description: 'NetworkSettings fields that override or define the profile.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['profile']
    }
  },
  {
    name: 'get_simulation_state',
    category: 'read',
    description: 'Use to inspect current network and device simulation.',
    inputSchema: {
      type: 'object',
      properties: {
        include: {
          type: 'string',
          enum: ['network', 'deviceSimulator', 'both'],
          description: 'State group; defaults to both.'
        },
        target: {
          type: 'string',
          description: 'Edit or client scope; servers are invalid.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      }
    }
  },
  {
    name: 'reset_simulation_state',
    category: 'write',
    description: 'Use to clear network and device simulation state.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Edit or client scope; servers are invalid.'
        },
        network: {
          type: 'boolean',
          description: 'Reset network simulation; defaults to true.'
        },
        deviceSimulator: {
          type: 'boolean',
          description: 'Stop device simulation; defaults to true.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      }
    }
  },
  {
    name: 'get_device_simulator_state',
    category: 'read',
    description: 'Use to inspect device simulation or list device presets.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Edit or client peer; defaults to edit. Servers are invalid.'
        },
        deviceId: {
          type: 'string',
          description: 'Built-in preset to inspect.'
        },
        includeDeviceList: {
          type: 'boolean',
          description: 'Include built-in presets; defaults to true.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      }
    }
  },
  {
    name: 'set_device_simulator',
    category: 'write',
    description: 'Use to manage device simulation in edit or a playtest client.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Edit, client-N, or all-clients; defaults to edit.'
        },
        deviceId: {
          type: 'string',
          description: 'Built-in device preset ID.'
        },
        orientation: {
          type: 'string',
          description: 'ScreenOrientation enum name.'
        },
        resolution: {
          type: 'object',
          additionalProperties: false,
          properties: {
            width: {
              type: 'number',
              description: 'Viewport width in pixels.'
            },
            height: {
              type: 'number',
              description: 'Viewport height in pixels.'
            }
          },
          required: ['width', 'height'],
          description: 'Resolution override after the preset.'
        },
        pixelDensity: {
          type: 'number',
          description: 'Positive density override after the preset.'
        },
        scalingMode: {
          type: 'string',
          description: 'DeviceSimulatorScalingMode enum name.'
        },
        stopSimulation: {
          type: 'boolean',
          description: 'Stop simulation; excludes other simulator settings.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      }
    }
  },
  {
    name: 'capture_device_matrix',
    category: 'write',
    description: 'Use to compare viewport screenshots across up to six device settings.',
    inputSchema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          maxItems: 6,
          description: 'Ordered device settings to capture.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: {
                type: 'string',
                description: 'Screenshot metadata label.'
              },
              deviceId: {
                type: 'string',
                description: 'Built-in device preset ID.'
              },
              orientation: {
                type: 'string',
                description: 'ScreenOrientation enum name.'
              },
              resolution: {
                type: 'object',
                additionalProperties: false,
                description: 'Viewport override for this capture.',
                properties: {
                  width: {
                    type: 'number',
                    description: 'Viewport width in pixels.'
                  },
                  height: {
                    type: 'number',
                    description: 'Viewport height in pixels.'
                  }
                },
                required: ['width', 'height']
              },
              pixelDensity: {
                type: 'number',
                description: 'Positive density override.'
              },
              scalingMode: {
                type: 'string',
                description: 'DeviceSimulatorScalingMode enum name.'
              }
            }
          }
        },
        target: {
          type: 'string',
          description: 'Edit or one client-N; not server or all-clients.'
        },
        format: {
          type: 'string',
          enum: ['jpeg', 'png'],
          description: 'Image format; defaults to jpeg. png is lossless.'
        },
        quality: {
          type: 'number',
          description: 'JPEG quality 1-100; defaults to 92. Ignored for png.'
        },
        settleSeconds: {
          type: 'number',
          description: 'Delay per capture in seconds; defaults to 0.3.'
        },
        restoreAfter: {
          type: 'boolean',
          description: 'Restore a preset afterward; custom devices cannot be restored.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['entries']
    }
  },
  {
    name: 'multiplayer_playtest',
    category: 'write',
    description: 'Use to run or inspect a multi-client Studio playtest.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'status', 'add_players', 'leave_client', 'end'],
          description: 'Lifecycle action to run.'
        },
        numPlayers: {
          type: 'number',
          description: 'Client count for start or add_players; 1-8.'
        },
        target: {
          type: 'string',
          description: 'Client for leave_client; defaults to client-1.'
        },
        testArgs: {
          description: 'JSON value exposed through GetTestArgs on server and clients.'
        },
        value: {
          description: 'JSON value returned by end to the edit process.'
        },
        timeout: {
          type: 'number',
          description: 'Wait in seconds; defaults to 30.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'get_runtime_logs',
    category: 'read',
    description: 'Use to read recent Studio output from edit, server, or client peers.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Log buffer: edit, server, client-N, or all; all deduplicates.'
        },
        since: {
          type: 'number',
          description: 'Sequence floor; reuse returned nextSince values for later reads.'
        },
        tail: {
          type: 'number',
          description: 'Last N entries after filtering.'
        },
        filter: {
          type: 'string',
          description: 'Literal message substring applied before tail.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      }
    }
  },
  {
    name: 'capture_script_profiler',
    category: 'read',
    description: 'Use to find Luau CPU hotspots on a running server or client.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          pattern: '^(server|client-[0-9]+)$',
          description: 'Running server or client-N; edit is invalid.'
        },
        duration_ms: {
          type: 'number',
          default: 1000,
          minimum: 100,
          maximum: 15000,
          description: 'Capture length in ms.'
        },
        frequency: {
          type: 'number',
          default: 1000,
          minimum: 1,
          maximum: 10000,
          description: 'Samples per second.'
        },
        max_functions: {
          type: 'number',
          default: 20,
          minimum: 1,
          maximum: 100,
          description: 'Returned function and debug-label limit.'
        },
        min_total_us: {
          type: 'number',
          default: 0,
          minimum: 0,
          description: 'Minimum function TotalDuration in microseconds.'
        },
        filter: {
          type: 'string',
          description: 'Case-insensitive function name or source substring.'
        },
        include_native: {
          type: 'boolean',
          description: 'Include native frames; defaults to false.'
        },
        include_plugin: {
          type: 'boolean',
          description: 'Include plugin frames; defaults to false.'
        },
        output_path: {
          type: 'string',
          description: 'Raw JSON file; the response returns only its path.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      }
    }
  },
  {
    name: 'capture_micro_profiler',
    category: 'read',
    description: 'Use to profile engine and game frame time on a live peer.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          pattern: '^(server|client-[0-9]+)$',
          description: 'Running server or client-N; edit is invalid.'
        },
        duration_ms: {
          type: 'number',
          default: 1000,
          minimum: 100,
          maximum: 5000,
          description: 'Capture length in ms.'
        },
        focus: {
          type: 'string',
          enum: ['all', 'script', 'physics', 'render', 'network', 'jobs'],
          default: 'all',
          description: 'Subsystem filter.'
        },
        filter: {
          type: 'string',
          description: 'Case-insensitive timer or group substring.'
        },
        max_timers: {
          type: 'number',
          default: 20,
          minimum: 1,
          maximum: 100,
          description: 'Returned timer limit.'
        },
        max_groups: {
          type: 'number',
          default: 20,
          minimum: 1,
          maximum: 100,
          description: 'Returned group limit; each group includes hot timers.'
        },
        max_timers_per_group: {
          type: 'number',
          default: 5,
          minimum: 0,
          maximum: 20,
          description: 'Nested timers per group; 0 omits them.'
        },
        max_related_timers: {
          type: 'number',
          default: 3,
          minimum: 0,
          maximum: 10,
          description: 'Parent, child, and thread rows per timer; 0 omits them.'
        },
        min_total_us: {
          type: 'number',
          default: 0,
          minimum: 0,
          description: 'Minimum inclusive_us after other filters.'
        },
        include_idle: {
          type: 'boolean',
          description: 'Include idle timers; defaults to false.'
        },
        include_gpu: {
          type: 'boolean',
          description: 'Include GPU events; defaults to false.'
        },
        max_events: {
          type: 'number',
          default: 250000,
          minimum: 10000,
          maximum: 1000000,
          description: 'LibMP event inspection limit.'
        },
        frame_window: {
          type: 'number',
          default: 240,
          minimum: 1,
          maximum: 2000,
          description: 'Trailing frames to analyze.'
        },
        output_path: {
          type: 'string',
          description: 'Raw snapshot file; the response stays summarized.'
        },
        summary_output_path: {
          type: 'string',
          description: 'Summary JSON file with its comparison index.'
        },
        baseline_path: {
          type: 'string',
          description: 'Summary file used as the baseline.'
        },
        baseline: {
          type: 'object',
          description: 'Inline summary used as the baseline.'
        },
        baseline_label: {
          type: 'string',
          description: 'Baseline comparison label.'
        },
        current_label: {
          type: 'string',
          description: 'Current comparison label.'
        },
        max_comparison_rows: {
          type: 'number',
          default: 20,
          minimum: 1,
          maximum: 100,
          description: 'Rows returned per comparison section.'
        },
        include_comparison_index: {
          type: 'boolean',
          description: 'Return the full comparison index; defaults to false.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      }
    }
  },
  {
    name: 'breakpoints',
    category: 'write',
    description: 'Use to trace script execution with breakpoints or logpoints.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set', 'remove', 'clear', 'list'],
          description: 'Operation; set/remove need location; clear targets MCP entries.'
        },
        clear_all: {
          type: 'boolean',
          description: 'With clear, also remove user-created breakpoints.'
        },
        script_path: {
          type: 'string',
          description: 'Script path; required for set and remove.'
        },
        line: {
          type: 'number',
          description: '1-based line for set or remove.'
        },
        enabled: {
          type: 'boolean',
          description: 'Initial enabled state; defaults to true.'
        },
        condition: {
          type: 'string',
          description: 'Luau condition for set.'
        },
        log_message: {
          type: 'string',
          description: 'Luau expressions to log; quote literal text.'
        },
        continue_execution: {
          type: 'boolean',
          description: 'Continue after hit; defaults true; false needs a resumer.'
        },
        target: {
          type: 'string',
          description: 'Edit, server, or client-N; defaults to edit.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['action']
    }
  },

  // === Multi-Instance ===
  {
    name: 'get_connected_instances',
    category: 'read',
    description: 'Use to discover connected places and the roles available in each.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },

  // === Asset Tools ===
  {
    name: 'search_assets',
    category: 'read',
    description: 'Use to find public Creator Store assets by type or keyword.',
    inputSchema: {
      type: 'object',
      properties: {
        assetType: {
          type: 'string',
          enum: ['Audio', 'Model', 'Decal', 'Image', 'Particle', 'VFX', 'Plugin', 'MeshPart', 'Video', 'FontFamily'],
          description: 'Asset type; Image maps to Decal, Particle and VFX to Model.'
        },
        query: {
          type: 'string',
          description: 'Terms; Particle and VFX add an effect suffix.'
        },
        maxResults: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'Result limit; defaults to 25.'
        },
        sortBy: {
          type: 'string',
          enum: ['Relevance', 'Trending', 'Top', 'AudioDuration', 'CreateTime', 'UpdatedTime', 'Ratings'],
          description: 'Sort order; defaults to Relevance.'
        },
        robloxCreatedOnly: {
          type: 'boolean',
          default: false,
          description: 'Only Roblox-created assets; defaults to false.'
        }
      },
      required: ['assetType']
    }
  },
  {
    name: 'get_asset_details',
    category: 'read',
    description: 'Use to inspect a shortlisted Creator Store asset.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'number',
          description: 'Roblox asset ID.'
        }
      },
      required: ['assetId']
    }
  },
  {
    name: 'get_asset_thumbnail',
    category: 'read',
    description: 'Use when an asset thumbnail would help with visual review.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'number',
          description: 'Roblox asset ID.'
        },
        size: {
          type: 'string',
          enum: ['150x150', '420x420', '768x432'],
          description: 'Thumbnail dimensions; defaults to 420x420.'
        }
      },
      required: ['assetId']
    }
  },
  {
    name: 'insert_asset',
    category: 'write',
    description: 'Use to sanitize and insert a Creator Store asset into a Studio place.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'number',
          description: 'Roblox asset ID to insert.'
        },
        parentPath: {
          type: 'string',
          description: 'Canonical parent; defaults to game.Workspace.'
        },
        position: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'World X coordinate.' },
            y: { type: 'number', description: 'World Y coordinate.' },
            z: { type: 'number', description: 'World Z coordinate.' }
          },
          description: 'World position for the inserted asset.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['assetId']
    }
  },
  {
    name: 'generate_model',
    category: 'write',
    description: 'Use to stage a Roblox model from text or an image.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Generation prompt; required without an image.'
        },
        image_path: {
          type: 'string',
          description: 'Local PNG; excludes other image inputs.'
        },
        image_base64: {
          type: 'string',
          maxLength: MAX_PNG_BASE64_CHARACTERS,
          description: 'PNG base64; image/png required; single source.'
        },
        image_mime_type: {
          type: 'string',
          enum: ['image/png'],
          description: 'MIME type; required with image_base64.'
        },
        image_asset_id: {
          type: 'number',
          description: 'Roblox image ID; excludes other image inputs.'
        },
        schema: {
          type: 'string',
          enum: ['Body1', 'Car5'],
          default: 'Body1',
          description: 'Part layout; Body1 is one mesh, Car5 is five vehicle parts.'
        },
        schema_groups: {
          type: 'array',
          items: { type: 'string' },
          description: 'Custom part names; excludes schema.'
        },
        name: {
          type: 'string',
          description: 'Generated Model name in __MCPGeneratedModels.'
        },
        size: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'Approximate X size in studs.' },
            y: { type: 'number', description: 'Approximate Y size in studs.' },
            z: { type: 'number', description: 'Approximate Z size in studs.' }
          },
          description: 'Requested size; generation may vary.'
        },
        max_triangles: {
          type: 'number',
          minimum: 1,
          description: 'Triangle cap; lower values are more faceted.'
        },
        generate_textures: {
          type: 'boolean',
          description: 'Generate textures; defaults to true.'
        },
        timeout_ms: {
          type: 'number',
          minimum: 1,
          maximum: 300000,
          default: 120000,
          description: 'Bridge timeout in ms.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      }
    }
  },
  {
    name: 'preview_asset',
    category: 'read',
    description: 'Use to inspect an asset\'s hierarchy and media without inserting it.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'number',
          description: 'Roblox asset ID to preview.'
        },
        includeProperties: {
          type: 'boolean',
          default: false,
          description: 'Include properties in displayed nodes.'
        },
        maxDepth: {
          type: 'number',
          default: 4,
          description: 'Displayed depth; result caps at 100 nodes, but all are scanned.'
        },
        includeAudio: {
          type: 'boolean',
          default: true,
          description: 'Return inline audio; needs asset:read and never writes files.'
        },
        maxAudioPreviews: {
          type: 'number',
          minimum: 1,
          maximum: 5,
          default: 3,
          description: 'Inline audio limit; byte caps still apply.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['assetId']
    }
  },
  {
    name: 'upload_asset',
    category: 'write',
    description: 'Use to upload a local asset or check a previous upload operation.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['upload', 'status'],
          default: 'upload',
          description: 'Upload a file, or check a returned operation ID.'
        },
        operationId: {
          type: 'string',
          minLength: 1,
          description: 'Returned operation ID; required for status.'
        },
        filePath: {
          type: 'string',
          description: 'Absolute local file path; required for upload.'
        },
        assetType: {
          type: 'string',
          enum: ['Audio', 'Decal', 'Model', 'Animation', 'Video'],
          description: 'Upload type; required for upload and must match the file.'
        },
        displayName: {
          type: 'string',
          description: 'Asset name; required for upload, at most 50 characters.'
        },
        description: {
          type: 'string',
          description: 'Asset description; defaults to empty.'
        },
        userId: {
          type: 'string',
          description: 'Creator user ID; overrides the environment default.'
        },
        groupId: {
          type: 'string',
          description: 'Creator group ID; overrides userId and environment defaults.'
        },
        instance_id: {
          type: 'string',
          description: 'Place for Decal image-ID lookup.'
        }
      },
      oneOf: [
        {
          properties: { action: { enum: ['upload'], description: 'Upload argument branch.' } },
          required: ['filePath', 'assetType', 'displayName']
        },
        {
          properties: { action: { enum: ['status'], description: 'Status argument branch.' } },
          required: ['action', 'operationId']
        }
      ]
    }
  },
  {
    name: 'capture_screenshot',
    category: 'read',
    description: 'Use to capture the Studio viewport or map input coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['jpeg', 'png'],
          description: 'Format; jpeg is smaller, png lossless; default jpeg.'
        },
        quality: {
          type: 'number',
          description: 'JPEG quality 1-100; defaults to 92. Ignored for png.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
    }
  },
  {
    name: 'inspect_ui',
    category: 'read',
    description: 'Use to inspect or audit semantic UI rendered by a live playtest client.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['inspect', 'audit', 'snapshot'],
          description: 'Result mode; defaults to inspect.'
        },
        root: {
          type: 'object',
          description: 'Optional PlayerGui subtree root.',
          properties: {
            path: {
              type: 'string',
              description: 'Canonical runtime instance path.'
            },
            ref: {
              type: 'string',
              description: 'Stable client-session ref; overrides path.'
            }
          }
        },
        visible_only: {
          type: 'boolean',
          description: 'Return only effectively visible elements.'
        },
        max_depth: {
          type: 'number',
          minimum: 0,
          maximum: 32,
          description: 'Traversal depth; defaults to 8.'
        },
        max_nodes: {
          type: 'number',
          minimum: 1,
          maximum: 1000,
          description: 'Element limit; defaults to 250.'
        },
        include_text: {
          type: 'boolean',
          description: 'Include text content; defaults to true.'
        },
        include_styles: {
          type: 'boolean',
          description: 'Include compact colors and font metadata.'
        },
        target: {
          type: 'string',
          description: 'Live client-N role; defaults to the first client.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      }
    }
  },
  {
    name: 'interact_ui',
    category: 'write',
    description: 'Use to interact with semantic UI on a live playtest client.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['click', 'focus', 'type', 'scroll_into_view', 'set_scroll'],
          description: 'Semantic interaction to perform.'
        },
        selector: {
          type: 'object',
          minProperties: 1,
          description: 'Fields compose and must resolve one PlayerGui element.',
          properties: {
            ref: { type: 'string', description: 'Stable ref from the same live client.' },
            path: { type: 'string', description: 'Exact canonical runtime path.' },
            name: { type: 'string', description: 'Exact Instance name.' },
            class: { type: 'string', description: 'Exact Roblox class name.' },
            role: {
              type: 'string',
              enum: ['button', 'text', 'image', 'input', 'scroll_container', 'viewport', 'container', 'gui'],
              description: 'Semantic UI role.'
            },
            text: { type: 'string', description: 'Exact rendered text.' },
            ancestor: { type: 'string', description: 'Ancestor name, path, or stable ref.' },
            visible_only: { type: 'boolean', description: 'Filter selector to effectively visible elements.' }
          }
        },
        text: {
          type: 'string',
          description: 'Text to send for the type action.'
        },
        canvas_position: {
          type: 'object',
          description: 'Canvas coordinates for set_scroll.',
          properties: {
            x: { type: 'number', description: 'Horizontal canvas coordinate.' },
            y: { type: 'number', description: 'Vertical canvas coordinate.' }
          },
          required: ['x', 'y']
        },
        target: {
          type: 'string',
          description: 'Live client-N role; defaults to the first client.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['action', 'selector']
    }
  },

  // === Input Simulation ===
  {
    name: 'simulate_mouse_input',
    category: 'write',
    description: 'Use to click the live playtest viewport at known pixel coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['click', 'mouseDown', 'mouseUp'],
          description: 'Mouse action; click performs down, then up.'
        },
        x: {
          type: 'number',
          description: 'Viewport pixel X coordinate.'
        },
        y: {
          type: 'number',
          description: 'Viewport pixel Y coordinate.'
        },
        button: {
          type: 'string',
          enum: ['Left', 'Right', 'Middle'],
          description: 'Mouse button; defaults to Left.'
        },
        target: {
          type: 'string',
          description: 'Peer; prefers a running client, then edit.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['action', 'x', 'y']
    }
  },
  {
    name: 'simulate_keyboard_input',
    category: 'write',
    description: 'Use to send key presses or text to a live playtest client.',
    inputSchema: {
      type: 'object',
      properties: {
        keyCode: {
          type: 'string',
          description: 'Enum.KeyCode name; omit when using text.'
        },
        action: {
          type: 'string',
          enum: ['press', 'release', 'tap'],
          description: 'Key action; tap presses, waits, and releases. Defaults to tap.'
        },
        duration: {
          type: 'number',
          description: 'Tap hold in seconds; defaults to 0.1.'
        },
        text: {
          type: 'string',
          description: 'Text for the focused TextBox; excludes keyCode and action.'
        },
        target: {
          type: 'string',
          description: 'Peer; prefers a running client, then edit.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      }
    }
  },

  // === Per-peer memory breakdown ===
  {
    name: 'get_memory_breakdown',
    category: 'read',
    description: 'Use to compare memory categories across Studio peers.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Edit, server, client-N, or all; defaults to all.'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'DeveloperMemoryTag filter; unknown tags return zero.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      }
    }
  },
  {
    name: 'get_scene_analysis',
    category: 'read',
    description: 'Use to attribute scene cost across instances and content.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['all', 'instance_composition', 'script_memory', 'unparented_instances', 'triangle_composition', 'animation_memory', 'audio_memory'],
          description: 'Analysis mode; defaults to all.'
        },
        target: {
          type: 'string',
          description: 'Edit, server, client-N, or all; defaults to all.'
        },
        topN: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'Flattened entries per mode; defaults to 10.'
        },
        raw: {
          type: 'boolean',
          description: 'Include full nested result trees; defaults to false.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      }
    }
  },

  // === SerializationService round-trip ===
  {
    name: 'export_rbxm',
    category: 'read',
    description: 'Use to save selected DataModel instances as a local .rbxm file.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Canonical instance paths to serialize.'
        },
        output_path: {
          type: 'string',
          description: 'Absolute .rbxm output path.'
        },
        target: {
          type: 'string',
          enum: ['edit', 'server'],
          description: 'Source DataModel; defaults to edit. server reads live state.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['instance_paths', 'output_path']
    }
  },
  {
    name: 'import_rbxm',
    category: 'write',
    description: 'Use to load a local, remote, or inline .rbxm under a chosen parent.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'object',
          description: 'Exactly one path, URL, or base64 source; URLs cap at 50 MiB.',
          properties: {
            path: { type: 'string', description: 'Absolute local .rbxm path.' },
            url: { type: 'string', description: 'HTTP or HTTPS .rbxm URL.' },
            base64: { type: 'string', description: 'Base64-encoded .rbxm bytes.' }
          },
          oneOf: [
            { required: ['path'] },
            { required: ['url'] },
            { required: ['base64'] }
          ]
        },
        parent_path: {
          type: 'string',
          description: 'Canonical parent path for imported instances.'
        },
        target: {
          type: 'string',
          enum: ['edit', 'server'],
          description: 'Destination DataModel; defaults to edit. server uses live state.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['source', 'parent_path']
    }
  },

  // === Find and Replace ===
  {
    name: 'find_and_replace_in_scripts',
    category: 'write',
    description: 'Use to preview or apply one replacement across scripts.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Literal text or Lua pattern.'
        },
        replacement: {
          type: 'string',
          description: 'Replacement; Lua patterns support %1, %2, and so on.'
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Literal match casing; patterns require true.'
        },
        usePattern: {
          type: 'boolean',
          description: 'Use Lua patterns; requires caseSensitive.'
        },
        path: {
          type: 'string',
          description: 'Canonical subtree to search.'
        },
        classFilter: {
          type: 'string',
          enum: ['Script', 'LocalScript', 'ModuleScript'],
          description: 'Script class to include.'
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview without edits; defaults to false.'
        },
        maxReplacements: {
          type: 'number',
          description: 'Replacement safety cap; defaults to 1000.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected place ID; required with multiple places.'
        }
      },
      required: ['pattern', 'replacement']
    }
  },

  // === Installed Studio Skills ===
  {
    name: 'get_roblox_skills',
    category: 'read',
    description: 'Use to read installed Roblox Studio Assistant skills.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get'],
          description: 'List skills or get one document.'
        },
        name: {
          type: 'string',
          description: 'Listed skill name; required for get.'
        }
      },
      required: ['action']
    }
  },

  // === Documentation ===
  {
    name: 'get_roblox_docs',
    category: 'read',
    description: 'Use to read official Roblox engine or Luau references.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact engine or Luau reference name; case-sensitive.'
        },
        doc_type: {
          type: 'string',
          enum: ['classes', 'enums', 'datatypes', 'libraries', 'globals'],
          description: 'Reference category; defaults to classes.'
        },
        section: {
          type: 'string',
          description: 'Level-two heading to return.'
        }
      },
      required: ['name']
    }
  },
];

export const getReadOnlyTools = () => TOOL_DEFINITIONS.filter(t => t.category === 'read');
export const getAllTools = () => [...TOOL_DEFINITIONS];
