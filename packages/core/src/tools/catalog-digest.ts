import { createHash } from 'crypto';
import { TOOL_DEFINITIONS } from './definitions.js';

/**
 * Which tool definitions this server was built from: a sha256 of them as
 * JSON. `/health` reports it, so a client generated from a checkout's
 * definitions (Roqer's desktop and its eval harness) can tell a bridge built
 * from other ones, such as an installed app's own or an older build, before it
 * offers a model tools that bridge does not have.
 */
export const TOOL_CATALOG_DIGEST = createHash('sha256').update(JSON.stringify(TOOL_DEFINITIONS), 'utf8').digest('hex');
