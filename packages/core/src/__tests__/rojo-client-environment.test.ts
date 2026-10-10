import { captureSourceEnvironment, validateSourceEnvironment, SourceEnvironmentError, SOURCE_ENVIRONMENT_VALUE_LIMIT } from '../rojo/client-environment.js';

describe('private source command environment', () => {
  test('only source configuration is forwarded, without provider/proxy credentials', () => {
    const secret = 'DO_NOT_TRANSFER_provider_secret';
    const result = captureSourceEnvironment({ PATH: 'caller-path', HOME: 'caller-home', OPENAI_API_KEY: secret, ANTHROPIC_API_KEY: secret, GITHUB_TOKEN: secret, HTTPS_PROXY: `http://user:${secret}@proxy/` });
    expect(result).toMatchObject({ PATH: 'caller-path', HOME: 'caller-home' });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).not.toHaveProperty('OPENAI_API_KEY');
    expect(result).not.toHaveProperty('HTTPS_PROXY');
    expect(validateSourceEnvironment(result)).toEqual(result);
  });
  test('receivers reject unknown fields without reflecting their values', () => {
    const secret = 'DO_NOT_REFLECT_secret';
    try { validateSourceEnvironment({ PATH: 'caller', OPENAI_API_KEY: secret }); fail('expected rejection'); }
    catch (error) { expect(error).toBeInstanceOf(SourceEnvironmentError); expect(String(error)).not.toContain(secret); }
  });
  test('ownership Git configuration is retained and unrelated credential pairs are removed', () => {
    const result = captureSourceEnvironment({ GIT_DIR: '/repo/.git', GIT_CONFIG_GLOBAL: '/caller/global', GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'DO_NOT_TRANSFER',
      GIT_CONFIG_KEY_1: 'core.excludesFile', GIT_CONFIG_VALUE_1: '/caller/ignored files',
      GIT_CONFIG_KEY_2: 'safe.directory', GIT_CONFIG_VALUE_2: '/repo',
    });
    expect(result).toMatchObject({ GIT_DIR: '/repo/.git', GIT_CONFIG_GLOBAL: '/caller/global', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: '/caller/ignored files', GIT_CONFIG_KEY_1: 'safe.directory', GIT_CONFIG_VALUE_1: '/repo' });
    expect(JSON.stringify(result)).not.toContain('DO_NOT_TRANSFER');
    expect(validateSourceEnvironment(result)).toEqual(result);
  });
  test('quoted Git parameters preserve paths but exclude authorization configuration', () => {
    const result = captureSourceEnvironment({ GIT_CONFIG_PARAMETERS: "'http.extraheader=Authorization: DO_NOT_TRANSFER' 'core.excludesfile=/path with spaces' 'core.bare'" });
    expect(result.GIT_CONFIG_PARAMETERS).toBe("'core.excludesfile=/path with spaces' 'core.bare=true'");
    expect(validateSourceEnvironment(result)).toEqual(result);
  });
  test('Git single quote escaping round-trips', () => {
    const result = captureSourceEnvironment({ GIT_CONFIG_PARAMETERS: "'core.excludesfile=/it'\\''s/path'" });
    expect(result.GIT_CONFIG_PARAMETERS).toBe("'core.excludesfile=/it'\\''s/path'");
    expect(validateSourceEnvironment(result)).toEqual(result);
  });
  test('bad shapes, NUL, malformed parameters and large values refuse', () => {
    for (const input of [[], null, { PATH: 3 }, { PATH: 'x\0y' }, { PATH: 'x'.repeat(SOURCE_ENVIRONMENT_VALUE_LIMIT + 1) }, { GIT_CONFIG_PARAMETERS: "'unfinished" }, { GIT_CONFIG_COUNT: '1' }]) {
      expect(() => validateSourceEnvironment(input)).toThrow(SourceEnvironmentError);
    }
  });
  test('two owners cannot inherit each other or mutate the parent environment', () => {
    const before = process.env.PATH;
    const a = captureSourceEnvironment({ PATH: 'A', GIT_CONFIG_GLOBAL: '/A/git' });
    const b = captureSourceEnvironment({ PATH: 'B' });
    expect(a.PATH).toBe('A'); expect(b.PATH).toBe('B'); expect(b.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(process.env.PATH).toBe(before);
  });
});
