/* node test/provider.claude-code.test.js — hardened Claude Code subscription bridge v0.1. */
'use strict';
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const A = require('./_assert.js');
const C = require('../sidecar/providers/claude-code.js');

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

  A.report('provider.claude-code.test');
})();
