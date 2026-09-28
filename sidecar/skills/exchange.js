/* sidecar/skills/exchange.js - staged installation of open SKILL.md documents.

   External instructions are untrusted bytes. The exchange therefore has one narrow lifecycle:
     inspect URL -> freeze exact bytes in a bounded, expiring stage -> install/update those bytes.

   The install operation never fetches again, so the Commander approves the same document that is
   persisted. Provenance rides on the ordinary per-agent skill record; the existing guard/gate then
   decides whether the model may read it. Pure apart from injected fetch/store/clock/hash seams. */
'use strict';

const catalog = require('./catalog.js');
const packageFormat = require('./package-format.js');

const MAX_DOCUMENT_BYTES = 256000;
const DEFAULT_STAGE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_STAGES = 40;

function str(v) { return v == null ? '' : String(v); }
function list(v) {
  if (Array.isArray(v)) return v.map(x => str(x).trim()).filter(Boolean);
  return v == null || v === '' ? [] : [str(v).trim()].filter(Boolean);
}

function normalizeSourceUrl(raw) {
  const input = str(raw).trim();
  if (!input || input.length > 2048) throw new Error('enter a public HTTPS URL to a SKILL.md file');
  let u;
  try { u = new URL(input); } catch (_) { throw new Error('that is not a valid URL'); }
  if (u.protocol !== 'https:') throw new Error('skill sources must use HTTPS');
  if (u.username || u.password) throw new Error('skill source URLs cannot contain credentials');
  u.hash = '';

  // GitHub's visible file page is what people naturally paste. Fetch the immutable document bytes,
  // not the surrounding HTML. Branch names containing slashes should be shared as raw URLs.
  if (u.hostname.toLowerCase() === 'github.com') {
    const bits = u.pathname.split('/').filter(Boolean);
    if (bits.length >= 5 && bits[2] === 'blob') {
      u = new URL('https://raw.githubusercontent.com/' + bits[0] + '/' + bits[1] + '/'
        + bits[3] + '/' + bits.slice(4).join('/'));
    }
  }
  return u.href;
}

function parseDocument(text, sourceUrl) {
  const raw = str(text).replace(/^\uFEFF/, '');
  if (!raw.trim()) throw new Error('the source returned an empty document');
  if (Buffer.byteLength(raw, 'utf8') > MAX_DOCUMENT_BYTES) throw new Error('SKILL.md is larger than 256 KB');
  const fm = catalog.parseFrontmatter(raw);
  const name = str(fm.meta.name).trim();
  const description = str(fm.meta.description).trim();
  const body = str(fm.body).trim();
  if (!name) throw new Error('SKILL.md frontmatter must include name');
  if (!description) throw new Error('SKILL.md frontmatter must include description');
  if (!body) throw new Error('SKILL.md needs instructions below its frontmatter');
  if (name.length > 80) throw new Error('skill name is longer than 80 characters');
  return {
    name,
    summary: description.slice(0, 280),
    description: description.slice(0, 280),
    body,
    category: str(fm.meta.category || 'Imported').trim().slice(0, 80) || 'Imported',
    requires: list(fm.meta.requires),
    platforms: list(fm.meta.platforms),
    sourceVersion: str(fm.meta.version).trim().slice(0, 80),
    sourceAuthor: str(fm.meta.author).trim().slice(0, 160),
    sourceLicense: str(fm.meta.license).trim().slice(0, 80),
    sourceUrl
  };
}

function cleanScan(scan) {
  scan = scan || {};
  return {
    verdict: str(scan.verdict || 'safe'),
    summary: str(scan.summary || 'safe'),
    findings: (Array.isArray(scan.findings) ? scan.findings : []).map(f => ({
      patternId: str(f && f.patternId), severity: str(f && f.severity), category: str(f && f.category),
      file: str(f && f.file), line: Number(f && f.line) || 0, description: str(f && f.description)
    }))
  };
}
function isTextPackagePath(path) {
  return path === 'SKILL.md' || !/^assets\//.test(path) || /\.(?:md|txt|json|ya?ml|js|mjs|cjs|ts|tsx|jsx|py|sh|ps1|html|css|xml|csv|svg)$/i.test(path);
}
function decodedPackageFiles(pkg) {
  return pkg.files.map(f => {
    const bytes = Buffer.from(f.content, 'base64');
    if (!isTextPackagePath(f.path)) return { path: f.path, bytes, sha256: f.sha256, text: null };
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(f.path + ' must be valid UTF-8 so it can be reviewed and scanned');
    return { path: f.path, bytes, sha256: f.sha256, text };
  });
}

function makeSkillExchange(deps) {
  deps = deps || {};
  const fetchDocument = deps.fetchDocument;
  const fetchPackage = deps.fetchPackage;
  const skillStore = deps.skillStore;
  const packageStore = deps.packageStore;
  const guard = deps.guard;
  const hash = deps.hash;
  const now = typeof deps.now === 'function' ? deps.now : () => 0;
  const makeId = typeof deps.makeId === 'function' ? deps.makeId : (() => { let n = 0; return () => 'stage-' + (++n); })();
  const ttlMs = deps.stageTtlMs > 0 ? deps.stageTtlMs : DEFAULT_STAGE_TTL_MS;
  const maxStages = deps.maxStages > 0 ? deps.maxStages : DEFAULT_MAX_STAGES;
  const stages = new Map();

  function sweep() {
    const t = now();
    for (const [id, stage] of stages) if (stage.expiresAt <= t) stages.delete(id);
    while (stages.size >= maxStages) stages.delete(stages.keys().next().value);
  }
  function digest(raw) {
    if (typeof hash !== 'function') throw new Error('skill exchange hash is unavailable');
    return str(hash(raw));
  }
  function previewOf(stage) {
    const d = stage.document;
    return {
      inspectionId: stage.id, expiresAt: stage.expiresAt, sourceUrl: d.sourceUrl,
      sourceDigest: stage.sourceDigest, name: d.name, summary: d.summary, category: d.category,
      requires: d.requires.slice(), platforms: d.platforms.slice(), version: d.sourceVersion,
      author: d.sourceAuthor, license: d.sourceLicense, body: d.body, scan: cleanScan(stage.scan),
      guardAction: stage.guardAction, packageDigest: stage.pkg.digest, packageBytes: stage.pkg.bytes,
      files: decodedPackageFiles(stage.pkg).map(f => ({
        path: f.path, bytes: f.bytes.length, sha256: f.sha256,
        encoding: f.text == null ? 'binary' : 'utf8', content: f.text == null ? '' : f.text
      }))
    };
  }
  async function inspect(input) {
    if (typeof fetchDocument !== 'function' && typeof fetchPackage !== 'function') throw new Error('skill fetching is unavailable');
    const sourceUrl = normalizeSourceUrl(input && input.url);
    const fetched = typeof fetchPackage === 'function' ? await fetchPackage(sourceUrl) : await fetchDocument(sourceUrl);
    const finalUrl = normalizeSourceUrl((fetched && fetched.url) || sourceUrl);
    const pkg = packageFormat.canonicalize(Array.isArray(fetched && fetched.files) ? fetched.files : [{ path: 'SKILL.md', content: str(fetched && fetched.text) }]);
    const decoded = decodedPackageFiles(pkg);
    const main = pkg.files.find(f => f.path === 'SKILL.md');
    const rawBytes = Buffer.from(main.content, 'base64');
    const raw = rawBytes.toString('utf8');
    if (!Buffer.from(raw, 'utf8').equals(rawBytes)) throw new Error('SKILL.md must be valid UTF-8');
    const document = parseDocument(raw, finalUrl);
    const projected = Object.assign({}, document, {
      setup: '', createdBy: 'community', files: decoded.filter(f => f.path !== 'SKILL.md').map(f => ({
        path: f.path, content: f.text == null ? '[binary asset: ' + f.bytes.length + ' bytes]' : f.text
      }))
    });
    const scan = guard && typeof guard.scanSkillRecord === 'function'
      ? guard.scanSkillRecord(projected, { source: 'community' }) : { verdict: 'safe', findings: [], summary: 'safe' };
    const policy = guard && typeof guard.shouldAllow === 'function'
      ? guard.shouldAllow(scan, { allowAsk: true }) : { action: 'allow' };
    sweep();
    const id = str(makeId());
    const stage = { id, createdAt: now(), expiresAt: now() + ttlMs, sourceDigest: pkg.digest, raw, pkg, document, scan, guardAction: str(policy.action || 'allow') };
    stages.set(id, stage);
    return previewOf(stage);
  }
  function getStage(id, expectedDigest) {
    sweep();
    const stage = stages.get(str(id));
    if (!stage) throw new Error('that inspection expired; inspect the source again');
    if (expectedDigest && str(expectedDigest) !== stage.sourceDigest) throw new Error('the inspected content digest does not match');
    return stage;
  }
  function findBySource(agentId, sourceUrl) {
    if (!skillStore || typeof skillStore.list !== 'function') return null;
    return skillStore.list(agentId, { includeArchived: true }).find(s => str(s.sourceUrl) === sourceUrl) || null;
  }
  function install(input) {
    if (!skillStore || typeof skillStore.manage !== 'function') throw new Error('skill storage is unavailable');
    const agentId = str(input && input.agentId) || 'agent';
    const stage = getStage(input && input.inspectionId, input && input.sourceDigest);
    if (stage.guardAction === 'block') throw new Error('the skill guard blocked this package; remove the dangerous instructions at the source and inspect it again');
    const d = stage.document;
    const bySource = findBySource(agentId, d.sourceUrl);
    const byName = skillStore.list(agentId, { includeArchived: true }).find(s => str(s.name).toLowerCase() === d.name.toLowerCase()) || null;
    let updateTarget = null;
    if (stage.updateTarget) {
      if (stage.updateTarget.agentId !== agentId) throw new Error('that reviewed update belongs to a different agent');
      updateTarget = skillStore.view(agentId, stage.updateTarget.id, { includeArchived: true, bump: false });
      if (!updateTarget) throw new Error('the installed skill changed after the update check');
      if (updateTarget.pinned) throw new Error('this skill is pinned; unpin it before applying an upstream update');
      if (str(updateTarget.name).toLowerCase() !== d.name.toLowerCase()) throw new Error('the reviewed update no longer matches the installed skill name');
      const currentDigest = str(updateTarget.packageDigest || updateTarget.sourceDigest).toLowerCase();
      if (updateTarget.packageDiverged || currentDigest !== stage.updateTarget.installedDigest) {
        throw new Error('the installed skill changed after the update check; check again');
      }
      if (bySource && bySource.id !== updateTarget.id) throw new Error('that update source is already attached to another skill');
    } else if (byName && (!bySource || byName.id !== bySource.id)) {
      throw new Error('a different skill named "' + d.name + '" already exists');
    }
    const common = {
      agentId, name: d.name, summary: d.summary, description: d.description, body: d.body,
      category: d.category, requires: d.requires, platforms: d.platforms, createdBy: 'community',
      sourceUrl: d.sourceUrl, sourceDigest: stage.sourceDigest, sourceFetchedAt: now(),
      sourceVersion: d.sourceVersion, sourceAuthor: d.sourceAuthor, sourceLicense: d.sourceLicense,
      packageDigest: stage.pkg.digest, packageBytes: stage.pkg.bytes, packageFiles: stage.pkg.files, packageDiverged: false,
      files: stage.pkg.files.filter(f => f.path !== 'SKILL.md').map(f => ({ path: f.path, encoding: 'base64', content: f.content }))
    };
    const prior = updateTarget || bySource;
    if (prior && packageStore && typeof packageStore.snapshot === 'function') {
      const current = skillStore.view(agentId, prior.id, { includeArchived: true, bump: false });
      if (current) packageStore.snapshot(current);
    }
    const result = prior
      ? skillStore.manage(Object.assign({}, common, { action: 'edit', target: prior.id }))
      : skillStore.manage(Object.assign({}, common, { action: 'create' }));
    if (!result || !result.ok) throw new Error((result && result.error) || 'could not install the skill');
    stages.delete(stage.id);
    return { ok: true, action: prior ? 'update' : 'install', skill: result.skill, guardAction: result.skill.guardAction || stage.guardAction };
  }
  async function check(input) {
    const agentId = str(input && input.agentId) || 'agent';
    const id = str(input && input.id);
    const current = skillStore && skillStore.view(agentId, id, { includeArchived: true, bump: false });
    if (!current) throw new Error('no such installed skill');
    const requestedSource = str(input && input.sourceUrl).trim();
    const sourceUrl = requestedSource || str(current.sourceUrl).trim();
    if (!sourceUrl) throw new Error('this skill has no update source; check it against a registry first');
    const preview = await inspect({ url: sourceUrl });
    const failPreview = message => { stages.delete(preview.inspectionId); throw new Error(message); };
    if (str(preview.name).toLowerCase() !== str(current.name).toLowerCase()) failPreview('the reviewed source name does not match the installed skill');
    const expectedDigest = str(input && input.expectedDigest).trim().toLowerCase();
    if (expectedDigest && str(preview.packageDigest).toLowerCase() !== expectedDigest) failPreview('the fetched package digest does not match the registry entry');
    const expectedVersion = str(input && input.expectedVersion).trim();
    if (expectedVersion && preview.version && str(preview.version) !== expectedVersion) failPreview('the fetched package version does not match the registry entry');
    const installedDigest = str(current.packageDigest || current.sourceDigest).toLowerCase();
    const stage = stages.get(preview.inspectionId);
    if (stage) {
      if (expectedVersion && !stage.document.sourceVersion) stage.document.sourceVersion = expectedVersion;
      stage.updateTarget = { agentId, id: current.id, installedDigest };
    }
    if (expectedVersion && !preview.version) preview.version = expectedVersion;
    return Object.assign({}, preview, {
      installedId: current.id, installedDigest, installedVersion: str(current.sourceVersion),
      updateAvailable: preview.packageDigest !== installedDigest, updateLocked: !!current.pinned,
      packageDiverged: !!current.packageDiverged
    });
  }

  function exportPackage(input) {
    const agentId = str(input && input.agentId) || 'agent';
    const current = skillStore && skillStore.view(agentId, str(input && input.id), { includeArchived: true, bump: false });
    if (!current) throw new Error('no such installed skill');
    if (!current.packageDigest || !Array.isArray(current.packageFiles) || !current.packageFiles.length || current.packageDiverged) {
      throw new Error('this skill has local changes; export requires a complete sealed package generation');
    }
    const pkg = packageFormat.fromEnvelope({ format: packageFormat.FORMAT, digest: current.packageDigest, files: current.packageFiles });
    return { filename: (current.id || 'skill') + '.starnet-skill.json', digest: pkg.digest, envelope: packageFormat.toEnvelope(pkg, {
      name: current.name, summary: current.summary || '', category: current.category || '', requires: current.requires || [], platforms: current.platforms || [],
      sourceUrl: current.sourceUrl || '', sourceDigest: current.sourceDigest || '', sourceFetchedAt: current.sourceFetchedAt || 0,
      sourceVersion: current.sourceVersion || '', sourceAuthor: current.sourceAuthor || '', sourceLicense: current.sourceLicense || ''
    }) };
  }
  function publishHandoff(input) {
    const exported = exportPackage(input);
    const envelope = JSON.parse(exported.envelope);
    const meta = envelope.metadata || {};
    return {
      package: exported,
      registryEntry: {
        name: str(meta.name), description: str(meta.summary), version: str(meta.sourceVersion),
        author: str(meta.sourceAuthor), license: str(meta.sourceLicense), digest: exported.digest,
        sourceUrl: '<HTTPS URL TO SKILL.md>'
      },
      instructions: [
        'Extract the standard skill folder represented by the package and host it without changing bytes.',
        'Set sourceUrl to the public HTTPS URL of SKILL.md and add the registry entry to a starnet-skill-registry/v1 index.',
        'Inspect the hosted URL in StarNet and confirm its package SHA-256 is ' + exported.digest + ' before sharing.'
      ],
      uploaded: false
    };
  }
  async function inspectEnvelope(input) {
    const pkg = packageFormat.fromEnvelope(input && input.envelope);
    const decoded = decodedPackageFiles(pkg);
    const main = packageFormat.fileBuffer(pkg, 'SKILL.md');
    if (!Buffer.from(main.toString('utf8'), 'utf8').equals(main)) throw new Error('SKILL.md must be valid UTF-8');
    const meta = pkg.metadata || {};
    const sourceUrl = /^https:\/\//.test(str(meta.sourceUrl)) ? str(meta.sourceUrl) : ('package://import/' + pkg.digest);
    const document = parseDocument(main.toString('utf8'), sourceUrl);
    if (meta.sourceVersion) document.sourceVersion = str(meta.sourceVersion).slice(0, 80);
    if (meta.sourceAuthor) document.sourceAuthor = str(meta.sourceAuthor).slice(0, 160);
    if (meta.sourceLicense) document.sourceLicense = str(meta.sourceLicense).slice(0, 80);
    if (meta.category) document.category = str(meta.category).slice(0, 80);
    if (Array.isArray(meta.requires)) document.requires = list(meta.requires);
    if (Array.isArray(meta.platforms)) document.platforms = list(meta.platforms);
    const projected = Object.assign({}, document, { setup: '', createdBy: 'community', files: decoded.filter(f => f.path !== 'SKILL.md').map(f => ({
      path: f.path, content: f.text == null ? '[binary asset: ' + f.bytes.length + ' bytes]' : f.text
    })) });
    const scan = guard && typeof guard.scanSkillRecord === 'function'
      ? guard.scanSkillRecord(projected, { source: 'community' }) : { verdict: 'safe', findings: [], summary: 'safe' };
    const policy = guard && typeof guard.shouldAllow === 'function' ? guard.shouldAllow(scan, { allowAsk: true }) : { action: 'allow' };
    sweep(); const id = str(makeId());
    const stage = { id, createdAt: now(), expiresAt: now() + ttlMs, sourceDigest: pkg.digest, raw: main.toString('utf8'), pkg, document, scan, guardAction: str(policy.action || 'allow') };
    stages.set(id, stage); return previewOf(stage);
  }
  function generations(input) {
    const agentId = str(input && input.agentId) || 'agent';
    const current = skillStore && skillStore.view(agentId, str(input && input.id), { includeArchived: true, bump: false });
    if (!current) throw new Error('no such installed skill');
    const prior = packageStore && typeof packageStore.generations === 'function' ? packageStore.generations(current) : [];
    return { current: current.packageDigest || '', diverged: !!current.packageDiverged, generations: prior };
  }
  function rollback(input) {
    const agentId = str(input && input.agentId) || 'agent';
    const current = skillStore && skillStore.view(agentId, str(input && input.id), { includeArchived: true, bump: false });
    if (!current) throw new Error('no such installed skill');
    if (!packageStore || typeof packageStore.readGeneration !== 'function') throw new Error('offline generations are unavailable');
    if (typeof packageStore.snapshot === 'function') packageStore.snapshot(current);
    const pkg = packageStore.readGeneration(current, str(input && input.digest));
    const raw = packageFormat.fileBuffer(pkg, 'SKILL.md').toString('utf8');
    const d = parseDocument(raw, current.sourceUrl || ('package://rollback/' + pkg.digest));
    const result = skillStore.manage(Object.assign({}, d, {
      action: 'edit', target: current.id, agentId, name: current.name, createdBy: 'user', force: true,
      sourceDigest: pkg.digest, sourceFetchedAt: now(), packageDigest: pkg.digest, packageBytes: pkg.bytes,
      packageFiles: pkg.files, packageDiverged: false,
      files: pkg.files.filter(f => f.path !== 'SKILL.md').map(f => ({ path: f.path, encoding: 'base64', content: f.content }))
    }));
    if (!result || !result.ok) throw new Error((result && result.error) || 'could not roll back the skill');
    return { ok: true, action: 'rollback', digest: pkg.digest, skill: result.skill };
  }

  return { inspect, inspectEnvelope, install, check, exportPackage, publishHandoff, generations, rollback, normalizeSourceUrl, parseDocument, _stages: stages };
}

module.exports = { makeSkillExchange, normalizeSourceUrl, parseDocument, MAX_DOCUMENT_BYTES };
