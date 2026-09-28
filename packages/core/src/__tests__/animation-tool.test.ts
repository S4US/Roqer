import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import {
  PREVIEW_SAMPLES,
  prepareAnimation,
  previewSampleTimes,
  verifyPlayback,
  type PreviewSample,
} from '../animation/animation-tool.js';
import { buildTracks, sampleTrack } from '../animation/motion.js';
import { compilePoseAnimation, type KeyframeSequenceDescription } from '../animation/pose-compiler.js';
import { R15_RIG } from '../animation/r15-rig.js';

function wave(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Wave',
    rig: 'R15',
    loop: true,
    keyframes: [
      { time: 0, joints: { RightShoulder: { rotation: [0, 0, 60] }, RightElbow: { rotation: [30, 0, 0] } } },
      { time: 0.5, joints: { RightShoulder: { rotation: [0, 0, 100] }, RightElbow: { rotation: [60, 0, 0] } } },
      { time: 1, joints: { RightShoulder: { rotation: [0, 0, 60] }, RightElbow: { rotation: [30, 0, 0] } } },
    ],
    ...overrides,
  };
}

function compiled(input: unknown): KeyframeSequenceDescription {
  const result = compilePoseAnimation(input);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.sequence;
}

/** What a faithful Studio would report: core's own sampler, as CFrame components. */
function faithfulSamples(sequence: KeyframeSequenceDescription, nudge = 0): PreviewSample[] {
  const tracks = buildTracks(sequence);
  return previewSampleTimes(sequence).map((time) => ({
    time,
    transforms: Object.fromEntries(R15_RIG.joints.map((joint) => {
      const frame = sampleTrack(tracks.get(joint.childPart), time);
      const c = [...frame.p, ...frame.r];
      if (joint.name === 'RightShoulder') c[0] += nudge;
      return [joint.childPart, c];
    })),
  }));
}

function body(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

describe('prepareAnimation', () => {
  test('refuses bad tool arguments together with compile errors', () => {
    const result = prepareAnimation({ ...wave(), rig: 'R6' }, { locomotion: 'yes', waive: ['gait', 'velocity'] });
    expect(result).toEqual({
      ok: false,
      errors: [
        'locomotion: must be true or false',
        'waive: unknown check "gait"; checks are jointLimits, velocity, rootDrift, loopContinuity, groundContact, footSliding, gaitSymmetry',
        'rig: must be one of R15',
      ],
    });
  });

  test('separates failures the caller waived from those that block a build', () => {
    const still = { name: 'Stand', rig: 'R15', loop: true, keyframes: [{ time: 0, joints: { Neck: {} } }, { time: 1, joints: { Neck: {} } }] };
    const blocked = prepareAnimation(still, { locomotion: true });
    expect(blocked.ok && blocked.value.failing).toEqual(['gaitSymmetry']);
    const waived = prepareAnimation(still, { locomotion: true, waive: ['gaitSymmetry'] });
    expect(waived.ok && [waived.value.failing, waived.value.waived]).toEqual([[], ['gaitSymmetry']]);
  });
});

describe('verifyPlayback', () => {
  test('samples the middle of equal spans, and accepts a faithful playback', () => {
    const sequence = compiled(wave());
    const times = previewSampleTimes(sequence);
    expect(times).toHaveLength(PREVIEW_SAMPLES);
    expect(times[0]).toBeCloseTo(1 / 16);
    expect(times[PREVIEW_SAMPLES - 1]).toBeCloseTo(15 / 16);
    expect(verifyPlayback(sequence, faithfulSamples(sequence))).toEqual({ verified: true, samples: 8, maxDegrees: 0, maxStuds: 0 });
  });

  test('refuses a playback that strays from the checked model, or one that is malformed', () => {
    const sequence = compiled(wave());
    const strayed = verifyPlayback(sequence, faithfulSamples(sequence, 0.2));
    expect(strayed).toMatchObject({ verified: false, maxStuds: 0.2 });
    expect(strayed.reason).toBe('Studio played it up to 0° and 0.2 studs from the checked model; the limit is 1.5° and 0.05 studs');
    expect(verifyPlayback(sequence, [])).toMatchObject({ verified: false, reason: 'Studio returned no preview samples' });
    const missing = faithfulSamples(sequence);
    delete missing[3].transforms.Head;
    expect(verifyPlayback(sequence, missing)).toMatchObject({ verified: false, reason: 'the preview dummy reported no joint for Head' });
  });
});

describe('RobloxStudioTools.animation', () => {
  type Payload = Record<string, unknown> & { sampleTimes?: number[]; expectedRevision?: string };
  function toolsWith(responses: Record<string, (data: Payload) => unknown>) {
    const tools = new RobloxStudioTools(new BridgeService());
    const calls: { endpoint: string; data: Payload; instance_id?: string }[] = [];
    // The plugin round trip, replaced: each endpoint answers from `responses`.
    (tools as unknown as { _callSingle: unknown })._callSingle = async (endpoint: string, data: Payload, _target: unknown, instance_id?: string) => {
      calls.push({ endpoint, data, instance_id });
      const respond = responses[endpoint];
      if (!respond) throw new Error(`unexpected call to ${endpoint}`);
      return respond(data);
    };
    return { tools, calls };
  }

  test('check compiles and measures without calling Studio', async () => {
    const { tools, calls } = toolsWith({});
    const result = body(await tools.animation('check', wave(), undefined, undefined, undefined, undefined));
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ valid: true, animation: { name: 'Wave', keyframes: 3, loop: true, joints: ['RightShoulder', 'RightElbow'] }, checks: { passed: true } });
    expect(result.checks.results.map((check: { id: string }) => check.id)).toEqual([
      'jointLimits', 'velocity', 'rootDrift', 'loopContinuity', 'groundContact', 'footSliding', 'gaitSymmetry',
    ]);
    expect(body(await tools.animation('check', { ...wave(), keyframes: [] }, undefined, undefined, undefined, undefined)))
      .toEqual({ valid: false, errors: ['keyframes: must be a non-empty array'] });
  });

  test('build refuses a failing check before Studio sees anything', async () => {
    const { tools, calls } = toolsWith({});
    const neckTwist = { name: 'Owl', rig: 'R15', keyframes: [{ time: 0, joints: { Neck: { rotation: [0, 150, 0] } } }] };
    const result = body(await tools.animation('build', neckTwist, 'game.ServerStorage', undefined, undefined, undefined));
    expect(calls).toEqual([]);
    expect(result.error).toBe('A motion check failed (jointLimits); nothing was built. Fix the motion, or waive a failure you intend.');
    expect(result.checks.results[0]).toMatchObject({ id: 'jointLimits', status: 'fail', measured: { Neck: 150 } });
  });

  test('build previews, verifies and then writes, routing instance_id to both calls', async () => {
    const sequence = compiled(wave());
    const { tools, calls } = toolsWith({
      '/api/preview-animation': () => ({ length: 1, samples: faithfulSamples(sequence) }),
      '/api/build-animation': () => ({
        path: 'game.ServerStorage.Animations.Wave', instanceRef: 'ref-1', revision: 'kr1:abc', stampMatches: true,
        replaced: false, keyframes: 3, poses: sequence.poseCount, undoable: true,
      }),
    });
    const result = body(await tools.animation('build', wave(), 'game.ServerStorage.Animations', undefined, undefined, undefined, 'place-1'));
    expect(calls.map((call) => [call.endpoint, call.instance_id])).toEqual([
      ['/api/preview-animation', 'place-1'],
      ['/api/build-animation', 'place-1'],
    ]);
    expect(calls[0].data.sampleTimes).toHaveLength(8);
    expect(calls[1].data).toMatchObject({ parentPath: 'game.ServerStorage.Animations', sequence: { name: 'Wave', loop: true, priority: 'Action' } });
    expect(result).toMatchObject({
      built: true,
      path: 'game.ServerStorage.Animations.Wave',
      revision: 'kr1:abc',
      replaced: false,
      undoable: true,
      readBack: { keyframes: 3, poses: sequence.poseCount, matchesCompiled: true },
      playback: { verified: true, samples: 8 },
      checks: { passed: true },
    });
  });

  test('build writes nothing when the preview fails or strays', async () => {
    const sequence = compiled(wave());
    const failed = toolsWith({ '/api/preview-animation': () => ({ error: 'the preview track never loaded.' }) });
    expect(body(await failed.tools.animation('build', wave(), 'game.ServerStorage', undefined, undefined, undefined)).error)
      .toBe('Studio could not preview the animation: the preview track never loaded. Nothing was built.');
    expect(failed.calls.map((call) => call.endpoint)).toEqual(['/api/preview-animation']);

    const strayed = toolsWith({ '/api/preview-animation': () => ({ length: 1, samples: faithfulSamples(sequence, 0.3) }) });
    const result = body(await strayed.tools.animation('build', wave(), 'game.ServerStorage', undefined, undefined, undefined));
    expect(result.error).toMatch(/^The preview did not play as checked: Studio played it up to .*\. Nothing was built\.$/);
    expect(strayed.calls.map((call) => call.endpoint)).toEqual(['/api/preview-animation']);
  });

  test('a refused write comes back with its reason and current revision', async () => {
    const sequence = compiled(wave());
    const { tools } = toolsWith({
      '/api/preview-animation': () => ({ length: 1, samples: faithfulSamples(sequence) }),
      '/api/build-animation': (data) => ({
        error: 'game.ServerStorage.Wave changed since that revision; build again with the current one. Nothing was built.',
        errorCode: 'revision_conflict',
        currentRevision: 'kr1:new',
        sent: data.expectedRevision,
      }),
    });
    const result = body(await tools.animation('build', wave(), 'game.ServerStorage', 'kr1:old', undefined, undefined));
    expect(result).toMatchObject({ errorCode: 'revision_conflict', currentRevision: 'kr1:new', sent: 'kr1:old' });
  });

  test('rejects malformed arguments outright', async () => {
    const { tools } = toolsWith({});
    await expect(tools.animation('play', wave(), undefined, undefined, undefined, undefined)).rejects.toThrow('animation action must be "check" or "build"');
    await expect(tools.animation('build', wave(), '', undefined, undefined, undefined)).rejects.toThrow(/parent .* is required/);
    await expect(tools.animation('build', wave(), 'game.ServerStorage', 7, undefined, undefined)).rejects.toThrow('expected_revision must be');
  });
});
