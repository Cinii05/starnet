'use strict';
const A = require('./_assert.js');
const { makeSkillRegistry, compareSemver, compareInstalled } = require('../sidecar/skills/registry.js');
(async () => {
  const registry = makeSkillRegistry({ fetchDocument: async url => ({ url, text: JSON.stringify({
    format: 'starnet-skill-registry/v1', name: 'Team tap', skills: [
      { name: 'Release Review', description: 'Audit a release', sourceUrl: './release/SKILL.md', version: '2' },
      { name: 'Research', description: 'Find sources', sourceUrl: 'https://skills.example/research/SKILL.md' }
    ]
  }) }) });
  const found = await registry.search({ url: 'https://registry.example/index.json', query: 'release' });
  A.eq(found.entries.length, 1, 'registry search filters bounded entries');
  A.eq(found.entries[0].sourceUrl, 'https://registry.example/release/SKILL.md', 'registry package URLs resolve against the index');
  let error = ''; try { await registry.search({ url: 'http://registry.example/index.json' }); } catch (e) { error = e.message; }
  A.ok(/HTTPS/.test(error), 'non-HTTPS registries are refused');
  const discovered = await registry.discover({ site: 'https://registry.example/products/start', query: 'research' });
  A.eq(discovered.registryUrl, 'https://registry.example/.well-known/starnet-skills.json', 'well-known discovery uses the site origin');

  const fallbackCalls = [];
  const fallback = makeSkillRegistry({ fetchDocument: async url => {
    fallbackCalls.push(url);
    if (url === 'https://pages.example/.well-known/starnet-skills.json') throw new Error('skill source returned HTTP 404');
    return { url, text: JSON.stringify({ format: 'starnet-skill-registry/v1', name: 'Project tap', skills: [
      { name: 'Project Skill', description: 'Path scoped', sourceUrl: './skill/SKILL.md', version: '1.0.0', digest: 'abc' }
    ] }) };
  } });
  const scoped = await fallback.discover({ site: 'https://pages.example/project/agentops/' });
  A.eq(scoped.registryUrl, 'https://pages.example/project/agentops/.well-known/starnet-skills.json', '404 at the origin root falls back to the site path');
  A.eq(fallbackCalls.length, 2, 'path-aware discovery performs one bounded fallback request');

  const invalidCalls = [];
  const invalid = makeSkillRegistry({ fetchDocument: async url => {
    invalidCalls.push(url); return { url, text: 'not json' };
  } });
  let invalidError = ''; try { await invalid.discover({ site: 'https://pages.example/project/agentops/' }); } catch (e) { invalidError = e.message; }
  A.ok(/invalid JSON/.test(invalidError), 'invalid root registry remains authoritative and is not masked by a path fallback');
  A.eq(invalidCalls.length, 1, 'only HTTP 404 permits the path-aware fallback');

  A.eq(compareSemver('1.1.0', '1.0.0'), 1, 'semantic versions detect a newer registry release');
  A.eq(compareSemver('1.0.0', '1.0.0'), 0, 'equal semantic versions compare equal');
  A.eq(compareSemver('1.0.0-beta.2', '1.0.0'), -1, 'prerelease sorts below the corresponding final release');
  A.eq(compareSemver('legacy', '1.0.0'), null, 'non-semver values remain unranked');

  const compared = compareInstalled([
    { name: 'same', version: '1.0.0', digest: 'aaa' },
    { name: 'newer', version: '1.1.0', digest: 'bbb' },
    { name: 'drift', version: '1.0.0', digest: 'ccc' },
    { name: 'older', version: '0.9.0', digest: 'ddd' },
    { name: 'fresh', version: '1.0.0', digest: 'eee' }
  ], [
    { id: 'same', name: 'same', sourceVersion: '1.0.0', packageDigest: 'aaa' },
    { id: 'newer', name: 'newer', sourceVersion: '1.0.0', packageDigest: 'old' },
    { id: 'drift', name: 'drift', sourceVersion: '1.0.0', packageDigest: 'old' },
    { id: 'older', name: 'older', sourceVersion: '1.0.0', packageDigest: 'old' }
  ]);
  const statuses = Object.fromEntries(compared.map(row => [row.name, row.status]));
  A.eq(statuses.same, 'current', 'matching package digest is current');
  A.eq(statuses.newer, 'update', 'newer registry version is an update');
  A.eq(statuses.drift, 'changed', 'same version with different bytes is surfaced as changed');
  A.eq(statuses.older, 'older', 'older registry version does not masquerade as an update');
  A.eq(statuses.fresh, 'not-installed', 'uninstalled registry entries remain distinct');
  A.report('skill-registry.test.js');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
