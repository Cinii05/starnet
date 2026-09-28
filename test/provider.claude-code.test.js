/* node test/provider.claude-code.test.js — hardened Claude Code subscription bridge v0.1. */
'use strict';
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const A = require('./_assert.js');
const C = require('../sidecar/providers/claude-code.js');
const ErrorClass = require('../sidecar/providers/errorClass.js');

function childWith(stdoutText, stderrText, opts) {
  opts = opts || {};
  const ch = new EventEmitter();
  ch.pid = opts.pid || 999999;
  ch.stdout = Readable.from(stdoutText == null ? [] : [String(stdoutText)]);
  ch.stderr = Readable.from(stderrText == null ? [] : [String(stderrText)]);
  ch.killed = false;
  ch.kill = () => { ch.killed = true; setImmediate(() => ch.emit('close', null, 'SIGTERM')); return true; };
  ch.stdin = {
    ended: '',
    end(data) { this.ended = String(data == null ? '' : data); if (opts.onStdin) opts.onStdin(this.ended, ch); }
  };
  if (!opts.deferClose) setImmediate(() => ch.emit('close', opts.code == null ? 0 : opts.code, opts.signal || null));
  return ch;
}

function queueSpawn(specs, calls) {
  const q = specs.slice();
  return (exe, args, options) => {
    calls.push({ exe, args: args.slice(), options });
    if (!q.length) throw new Error('unexpected spawn: ' + exe + ' ' + args.join(' '));
    const spec = q.shift();
    if (typeof spec === 'function') return spec(exe, args, options);
    return childWith(spec.stdout, spec.stderr, spec);
  };
}

const READY_AUTH = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  subscriptionType: 'pro',
  email: 'must-not-leak@example.invalid',
  orgId: 'must-not-leak'
});

module.exports = (async () => {
  A.eq(C.PROVIDER_ID, 'claude-code', 'provider id is frozen');
  A.eq(C.MODEL_ID, 'sonnet', 'v0.1 model id is frozen');
  for (const flag of ['--safe-mode','--strict-mcp-config','--permission-prompts','--no-session-persistence','--disable-slash-commands','--no-chrome','--output-format','--include-partial-messages','--verbose']) {
    A.ok(C.BASE_ARGS.includes(flag), 'hardened CLI includes ' + flag);
  }
  const toolsAt = C.BASE_ARGS.indexOf('--tools');
  A.ok(toolsAt >= 0 && C.BASE_ARGS[toolsAt + 1] === '', 'Claude-side tools are explicitly empty');
  const modelAt = C.BASE_ARGS.indexOf('--model');
  A.eq(C.BASE_ARGS[modelAt + 1], 'sonnet', 'CLI model uses stable sonnet alias');
  const suggestionsAt = C.BASE_ARGS.indexOf('--prompt-suggestions');
  A.ok(suggestionsAt >= 0 && C.BASE_ARGS[suggestionsAt + 1] === 'false', 'auxiliary prompt-suggestion inference is disabled');

  const env = C.sanitizedEnv({
    PATH: 'keep-me',
    ANTHROPIC_API_KEY: 'secret',
    ANTHROPIC_AUTH_TOKEN: 'secret2',
    ANTHROPIC_BASE_URL: 'https://wrong.example',
    CLAUDE_CODE_OAUTH_TOKEN: 'do-not-forward',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1'
  });
  A.eq(env.PATH, 'keep-me', 'ordinary environment survives sanitation');
  A.eq(env.ANTHROPIC_API_KEY, undefined, 'ANTHROPIC_API_KEY is stripped');
  A.eq(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'OAuth-token override is stripped');
  A.eq(env.CLAUDE_CODE_USE_BEDROCK, undefined, 'Bedrock override is stripped');

  {
    const calls = [];
    const spawn = queueSpawn([
      { stdout: '2.1.263 (Claude Code)\n' },
      { stdout: READY_AUTH + '\n' }
    ], calls);
    const h = await C.healthCheckClaudeCode({ spawn, executable: 'claude-test' });
    A.eq(h.state, 'READY', 'first-party Claude subscription is READY');
    A.eq(h.subscriptionType, 'pro', 'subscription type is retained');
    A.ok(!Object.prototype.hasOwnProperty.call(h, 'email'), 'health response does not expose email');
    A.ok(!Object.prototype.hasOwnProperty.call(h, 'orgId'), 'health response does not expose org id');
    A.eq(calls[0].args.join(' '), '--version', 'health starts with --version');
    A.eq(calls[1].args.join(' '), 'auth status', 'health uses auth status without inference');
    A.eq(calls.some(c => c.args.includes('-p')), false, 'health check never performs inference');
  }

  {
    const calls = [];
    const spawn = queueSpawn([
      { stdout: '2.1.263\n' },
      { stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'anthropic', subscriptionType: 'pro' }) + '\n' }
    ], calls);
    const h = await C.healthCheckClaudeCode({ spawn, executable: 'claude-test' });
    A.eq(h.state, 'AUTH_UNSUPPORTED', 'API-key/unsupported auth route is rejected');
    A.eq(h.ready, false, 'unsupported auth is not runnable');
  }

  {
    const calls = [];
    let prompt = '';
    const streamLines = [
      JSON.stringify({ type:'system', subtype:'init', tools:[], mcp_servers:[], model:'claude-sonnet-5' }),
      JSON.stringify({ type:'stream_event', event:{ type:'content_block_delta', delta:{ type:'text_delta', text:'review ' } } }),
      JSON.stringify({ type:'stream_event', event:{ type:'content_block_delta', delta:{ type:'text_delta', text:'complete' } } }),
      JSON.stringify({
        type:'result', subtype:'success', is_error:false, stop_reason:'end_turn',
        usage:{ input_tokens:10, cache_creation_input_tokens:2, cache_read_input_tokens:3, output_tokens:4, output_tokens_details:{thinking_tokens:1} },
        modelUsage:{ 'claude-sonnet-5':{ canonicalModel:'claude-sonnet-5', contextWindow:1000000, costUSD:0.99, costBasis:'list' } },
        total_cost_usd:0.99, result:'review complete'
      })
    ].join('\n') + '\n';
    const spawn = queueSpawn([
      { stdout:'2.1.263\n' },
      { stdout:READY_AUTH + '\n' },
      (exe,args,options) => childWith(streamLines, '', { onStdin:s => { prompt=s; } })
    ], calls);
    const p = C.makeClaudeCodeProvider({ spawn, executable:'claude-test', cwd:'C:\\safe' });
    const events = [];
    for await (const e of p.stream({ model:'sonnet', messages:[
      { role:'system', content:'Review only.' },
      { role:'user', content:'TMC_SECRET_PROMPT_731' }
    ] })) events.push(e);

    A.eq(events.filter(e => e.type === 'text').map(e => e.delta).join(''), 'review complete', 'text deltas stream incrementally');
    A.eq(events.filter(e => e.type === 'usage').length, 1, 'usage is emitted exactly once');
    const usage = events.find(e => e.type === 'usage').usage;
    A.eq(usage.prompt_tokens, 15, 'prompt usage includes input + cache create + cache read');
    A.eq(usage.completion_tokens, 4, 'completion usage maps output tokens');
    A.eq(usage.reasoning_tokens, 1, 'thinking usage is retained');
    A.eq(events[events.length - 1].type, 'done', 'successful run terminates with done');
    A.eq(p.priceOf('sonnet'), null, 'subscription provider has no billable token price');
    A.eq(p.supportsTools('sonnet'), false, 'v0.1 is explicitly tool-less');
    A.eq(p.canonicalModel(), 'claude-sonnet-5', 'canonical resolved model is captured from result');
    A.eq(p.contextLimit('sonnet'), 1000000, 'live canonical model context window updates metadata');
    A.ok(prompt.includes('TMC_SECRET_PROMPT_731'), 'project prompt is supplied on stdin');
    const inferenceCall = calls[2];
    A.eq(inferenceCall.args.some(a => String(a).includes('TMC_SECRET_PROMPT_731')), false, 'project prompt never appears in process arguments');
    A.eq(inferenceCall.options.shell, false, 'process launch never uses shell interpolation');
    A.eq(inferenceCall.options.env.ANTHROPIC_API_KEY, undefined, 'inference child cannot inherit Anthropic API key');
  }

  {
    const p = C.makeClaudeCodeProvider({ spawn: () => { throw new Error('must not spawn'); }, executable:'claude-test' });
    let code = '';
    try { for await (const _ of p.stream({ model:'opus', messages:[] })) {} }
    catch (e) { code = e.code; }
    A.eq(code, 'CLAUDE_CODE_PROTOCOL_ERROR', 'non-Sonnet model request fails closed before spawning');
  }

  {
    const calls = [];
    const badInit = [
      JSON.stringify({ type:'system', subtype:'init', tools:['Read'], mcp_servers:[], model:'claude-sonnet-5' }),
      JSON.stringify({ type:'result', subtype:'success', is_error:false, usage:{}, modelUsage:{} })
    ].join('\n') + '\n';
    const spawn = queueSpawn([
      { stdout:'2.1.263\n' },
      { stdout:READY_AUTH + '\n' },
      { stdout:badInit }
    ], calls);
    const p = C.makeClaudeCodeProvider({ spawn, executable:'claude-test' });
    let code = '';
    try { for await (const _ of p.stream({ model:'sonnet', messages:[{role:'user',content:'x'}] })) {} }
    catch (e) { code = e.code; }
    A.eq(code, 'CLAUDE_CODE_TOOL_PROTOCOL_VIOLATION', 'unexpected Claude-side tools fail closed');
  }


  {
    const calls = [];
    const spawn = queueSpawn([
      { stdout: '2.1.263\n' },
      { stdout: JSON.stringify({ loggedIn:false, authMethod:'claude.ai', apiProvider:'firstParty' }) + '\n' }
    ], calls);
    const h = await C.healthCheckClaudeCode({ spawn, executable:'claude-test' });
    A.eq(h.state, 'NOT_SIGNED_IN', 'signed-out Claude Code is not ready');
    A.eq(h.ready, false, 'signed-out health is false');
  }

  {
    const calls = [];
    const malformed = '{"type":"system","subtype":"init","tools":[],"mcp_servers":[]}\n{not-json}\n';
    const spawn = queueSpawn([
      { stdout:'2.1.263\n' },
      { stdout:READY_AUTH + '\n' },
      { stdout:malformed }
    ], calls);
    const p = C.makeClaudeCodeProvider({ spawn, executable:'claude-test' });
    let code = '';
    try { for await (const _ of p.stream({ model:'sonnet', messages:[{role:'user',content:'x'}] })) {} }
    catch (e) { code = e.code; }
    A.eq(code, 'CLAUDE_CODE_PROTOCOL_ERROR', 'malformed stream-json fails closed');
  }

  {
    const errorStream = (result) => [
      JSON.stringify({ type:'system', subtype:'init', tools:[], mcp_servers:[], model:'claude-sonnet-5' }),
      JSON.stringify({ type:'result', subtype:'error', is_error:true, result, usage:{}, modelUsage:{} })
    ].join('\n') + '\n';

    const rateSpawn = queueSpawn([
      { stdout:'2.1.263\n' }, { stdout:READY_AUTH + '\n' }, { stdout:errorStream('Rate limit reached') }
    ], []);
    const rate = C.makeClaudeCodeProvider({ spawn:rateSpawn, executable:'claude-test' });
    let rateCode = '';
    try { for await (const _ of rate.stream({ model:'sonnet', messages:[{role:'user',content:'x'}] })) {} }
    catch (e) { rateCode = e.code; }
    A.eq(rateCode, 'CLAUDE_CODE_RATE_LIMITED', 'rate-limit result gets a typed provider error');

    const limitSpawn = queueSpawn([
      { stdout:'2.1.263\n' }, { stdout:READY_AUTH + '\n' }, { stdout:errorStream('Weekly usage limit reached') }
    ], []);
    const limit = C.makeClaudeCodeProvider({ spawn:limitSpawn, executable:'claude-test' });
    let limitCode = '';
    try { for await (const _ of limit.stream({ model:'sonnet', messages:[{role:'user',content:'x'}] })) {} }
    catch (e) { limitCode = e.code; }
    A.eq(limitCode, 'CLAUDE_CODE_SUBSCRIPTION_LIMIT', 'subscription allowance gets a typed provider error');
  }

  {
    let target = null, taskkillSeen = false;
    const spawn = (exe, args) => {
      if (args[0] === '--version') return childWith('2.1.263\n', '');
      if (args[0] === 'auth') return childWith(READY_AUTH + '\n', '');
      if (String(exe).toLowerCase().endsWith('taskkill.exe')) {
        taskkillSeen = true;
        if (target) {
          target.killed = true;
          try { target.stdout.destroy(); } catch (_) {}
          setImmediate(() => target.emit('close', 1, 'SIGTERM'));
        }
        return childWith('', '');
      }
      target = childWith('', '', { deferClose:true });
      target.stdout = new Readable({ read() {} });
      target.kill = () => {
        target.killed = true;
        try { target.stdout.destroy(); } catch (_) {}
        setImmediate(() => target.emit('close', 1, 'SIGTERM'));
        return true;
      };
      return target;
    };
    const p = C.makeClaudeCodeProvider({ spawn, executable:'claude-test' });
    const ac = new AbortController();
    const hold = setInterval(() => {}, 50);   // keep the synthetic child test alive until its close event is observed
    setTimeout(() => ac.abort(), 10);
    const events = [];
    try {
      for await (const e of p.stream({ model:'sonnet', messages:[{role:'user',content:'cancel me'}], signal:ac.signal })) events.push(e);
    } finally { clearInterval(hold); }
    A.eq(events.length, 0, 'cancelled run produces no late provider events');
    A.ok(target && target.killed, 'cancellation terminates the owned Claude child process');
    if (process.platform === 'win32') A.ok(taskkillSeen, 'Windows cancellation uses process-tree termination');
  }

  {
    const calls = [];
    const spawn = queueSpawn([
      { stdout:'2.1.263\n' },
      { stdout:READY_AUTH + '\n' }
    ], calls);
    const p = C.makeClaudeCodeProvider({ spawn, executable:'claude-test' });
    const models = await p.listModels();
    A.eq(models.length, 1, 'v0.1 exposes exactly one Claude model');
    A.eq(models[0].id, 'sonnet', 'v0.1 model catalog is Sonnet-only');
    A.eq(JSON.stringify(models[0].reasoningEfforts), JSON.stringify(['none']), 'v0.1 exposes no fake reasoning-effort dial');
  }

  {
    const raw = 'provider failed with sk-ant-AbCdEfGhIjKlMnOp and more detail\nsecond line';
    const safe = C._internals.safeErrorText(raw);
    A.eq(safe.includes('sk-ant-AbCdEfGhIjKlMnOp'), false, 'raw Anthropic-shaped secrets are redacted from CLI errors');
    A.ok(safe.includes('[redacted-key]'), 'redacted CLI error preserves a non-secret diagnostic marker');
    A.eq(safe.includes('\n'), false, 'CLI stderr is flattened before surfacing');
  }

  {
    const classify = (code, message) => ErrorClass.classifyApiError(Object.assign(new Error(message || code), { code }), {});
    A.eq(classify('CLAUDE_CODE_RATE_LIMITED').reason, 'rate_limit', 'StarNet classifies Claude rate limits');
    A.eq(classify('CLAUDE_CODE_SUBSCRIPTION_LIMIT').reason, 'quota_exhausted', 'StarNet classifies Claude subscription limits');
    A.eq(classify('CLAUDE_CODE_NOT_AUTHENTICATED').reason, 'auth', 'StarNet classifies Claude auth failures');
    A.eq(classify('CLAUDE_CODE_TIMEOUT').reason, 'timeout', 'StarNet classifies Claude timeout');
    A.eq(classify('CLAUDE_CODE_PROTOCOL_ERROR').reason, 'format_error', 'StarNet classifies Claude protocol failures');
    A.eq(classify('CLAUDE_CODE_NOT_AVAILABLE').reason, 'local_error', 'StarNet classifies missing local Claude runtime');
  }

  A.report('provider.claude-code.test');
})();
