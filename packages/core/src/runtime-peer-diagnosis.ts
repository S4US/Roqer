/**
 * Why a playtest's runtime peers did not register, in a sentence the agent and
 * the user can act on.
 *
 * The play server's plugin registers a playtest's runtime peers: itself as
 * `server`, and a `client-N` for each player that joins. When it cannot reach
 * the bridge, the bridge has nothing of its own to go on, so the edit plugin
 * reads back what the play server's plugin recorded about its connection
 * (`/api/runtime-peer-report`), and this turns that into the reason.
 */

export type RuntimePeerStage = 'loaded' | 'connecting' | 'retrying' | 'failed' | 'registered';

export interface RuntimePeerDiagnosis {
  /** What went wrong, as far as the evidence goes. */
  diagnosis: string;
  /** The evidence: what the edit plugin and the play server's plugin last recorded. */
  runtimePeer: {
    /** `none`: the play server's plugin never reported. `unavailable`: the edit plugin could not be asked. */
    stage: RuntimePeerStage | 'none' | 'unavailable';
    playtestRunning?: boolean;
    playModeError?: string;
    url?: string;
    detail?: string;
    role?: string;
  };
}

const STAGES: ReadonlySet<string> = new Set<RuntimePeerStage>(['loaded', 'connecting', 'retrying', 'failed', 'registered']);
const MAX_TEXT_LENGTH = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  return value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH)}...` : value;
}

function seconds(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)} s`;
}

/**
 * `response` is the edit plugin's `/api/runtime-peer-report` answer, or an
 * `{ error }` standing in for one that could not be had. `roles` are the
 * peers connected when the wait ended; `requiredRoles`, the ones it waited
 * for; `waitedSeconds`, how long it waited. A plugin that has not reported is
 * only evidence for that long: a play server can take longer to start.
 */
export function diagnoseRuntimePeers(
  response: unknown,
  roles: readonly string[],
  requiredRoles: readonly string[],
  waitedSeconds: number,
): RuntimePeerDiagnosis {
  const body = isRecord(response) ? response : {};
  if (body.success !== true) {
    const reason = text(body.error) ?? 'it gave no answer';
    return {
      diagnosis: `The edit plugin could not say what the play server's plugin did: ${reason}`,
      runtimePeer: { stage: 'unavailable' },
    };
  }
  if (body.playStartRequested !== true) {
    return {
      diagnosis: 'The edit plugin has no record of starting this playtest, so it cannot say what the play server\'s plugin did.',
      runtimePeer: { stage: 'unavailable' },
    };
  }

  const playtestRunning = typeof body.playtestRunning === 'boolean' ? body.playtestRunning : undefined;
  const playModeError = text(body.playModeError);
  const report = isRecord(body.report) && typeof body.report.stage === 'string' && STAGES.has(body.report.stage)
    ? body.report
    : undefined;
  const stage = (report?.stage as RuntimePeerStage | undefined) ?? 'none';
  const url = text(report?.url);
  const detail = text(report?.detail);
  const role = text(report?.role);
  const runtimePeer: RuntimePeerDiagnosis['runtimePeer'] = {
    stage,
    ...(playtestRunning === undefined ? {} : { playtestRunning }),
    ...(playModeError === undefined ? {} : { playModeError }),
    ...(url === undefined ? {} : { url }),
    ...(detail === undefined ? {} : { detail }),
    ...(role === undefined ? {} : { role }),
  };

  if (playModeError !== undefined) {
    return { diagnosis: `Studio ended the playtest with an error: ${playModeError}`, runtimePeer };
  }

  const at = url === undefined ? 'the bridge' : `the bridge at ${url}`;
  let diagnosis: string;
  switch (stage) {
    case 'none':
      return {
        diagnosis: playtestRunning === false
          ? 'Studio is not running the playtest, and the MCP plugin never reported from its play server.'
          : `Studio is running the playtest, but after ${seconds(waitedSeconds)} the MCP plugin had not reported from the play server: it had not started there.`,
        runtimePeer,
      };
    case 'loaded':
      diagnosis = `The MCP plugin started in the play server but had not tried to reach the bridge after ${seconds(waitedSeconds)}.`;
      break;
    case 'failed':
      diagnosis = `The MCP plugin in the play server could not start its connection: ${detail ?? 'no reason given'}`;
      break;
    case 'connecting':
      diagnosis = `The MCP plugin in the play server is still waiting for ${at} to answer.`;
      break;
    case 'retrying':
      diagnosis = `The MCP plugin in the play server could not register with ${at}: ${detail ?? 'no reason given'}`;
      break;
    case 'registered': {
      const missing = requiredRoles.filter((required) => !roles.includes(required));
      diagnosis = missing.includes('server')
        ? `The MCP plugin in the play server registered as ${role ?? 'server'}, but the bridge no longer lists it.`
        : `The play server registered, but ${missing.join(', ') || 'no client'} did not: the play server's plugin registers each player that joins.`;
      break;
    }
  }
  if (playtestRunning === false) diagnosis += ' Studio is no longer running the playtest.';
  return { diagnosis, runtimePeer };
}
