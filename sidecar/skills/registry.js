'use strict';

const FORMAT = 'starnet-skill-registry/v1';
function str(v) { return v == null ? '' : String(v); }

function semverParts(value) {
  const m = str(value).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}
function compareSemver(a, b) {
  const av = semverParts(a), bv = semverParts(b);
  if (!av || !bv) return null;
  for (const key of ['major', 'minor', 'patch']) if (av[key] !== bv[key]) return av[key] > bv[key] ? 1 : -1;
  if (!av.pre.length && !bv.pre.length) return 0;
  if (!av.pre.length) return 1;
  if (!bv.pre.length) return -1;
  const n = Math.max(av.pre.length, bv.pre.length);
  for (let i = 0; i < n; i++) {
    if (av.pre[i] == null) return -1;
    if (bv.pre[i] == null) return 1;
    const an = /^\d+$/.test(av.pre[i]), bn = /^\d+$/.test(bv.pre[i]);
    if (an && bn) {
      const ai = Number(av.pre[i]), bi = Number(bv.pre[i]);
      if (ai !== bi) return ai > bi ? 1 : -1;
    } else if (an !== bn) return an ? -1 : 1;
    else if (av.pre[i] !== bv.pre[i]) return av.pre[i] > bv.pre[i] ? 1 : -1;
  }
  return 0;
}
function compareInstalled(entries, installed) {
  const byName = new Map();
  for (const skill of (installed || [])) {
    const name = str(skill && skill.name).trim().toLowerCase();
    if (name && !byName.has(name)) byName.set(name, skill);
  }
  return (entries || []).map(entry => {
    const current = byName.get(str(entry && entry.name).trim().toLowerCase()) || null;
    const remoteDigest = str(entry && entry.digest).trim().toLowerCase();
    if (!current) return Object.assign({}, entry, { status: 'not-installed', installedId: '', installedVersion: '', installedDigest: '' });
    const installedDigest = str(current.packageDigest || current.sourceDigest).trim().toLowerCase();
    const installedVersion = str(current.sourceVersion).trim();
    let status = 'changed';
    if (current.packageDiverged) status = 'changed';
    else if (remoteDigest && installedDigest && remoteDigest === installedDigest) status = 'current';
    else {
      const cmp = compareSemver(str(entry && entry.version), installedVersion);
      if (cmp > 0) status = 'update';
      else if (cmp < 0) status = 'older';
      else if (cmp === 0) status = 'changed';
      else if (!remoteDigest || !installedDigest) status = 'unknown';
    }
    return Object.assign({}, entry, {
      status, installedId: str(current.id), installedVersion, installedDigest,
      pinned: !!current.pinned, packageDiverged: !!current.packageDiverged, installedState: str(current.state || 'active')
    });
  });
}
function makeSkillRegistry(deps) {
  const fetchDocument = deps && deps.fetchDocument;
  const now = deps && typeof deps.now === 'function' ? deps.now : () => 0;
  const cacheMs = deps && deps.cacheMs > 0 ? deps.cacheMs : 5 * 60 * 1000;
  const cache = new Map();
  async function search(input) {
    if (typeof fetchDocument !== 'function') throw new Error('registry fetching is unavailable');
    const rawUrl = str(input && input.url).trim();
    let url; try { url = new URL(rawUrl); } catch (_) { throw new Error('enter a public HTTPS registry URL'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('skill registries must use public HTTPS');
    let got; let cached = false;
    const prior = cache.get(url.href);
    if (prior && prior.expiresAt > now()) { got = prior.got; cached = true; }
    else { got = await fetchDocument(url.href); cache.set(url.href, { got, expiresAt: now() + cacheMs }); }
    let index; try { index = JSON.parse(got.text); } catch (_) { throw new Error('registry returned invalid JSON'); }
    if (!index || index.format !== FORMAT || !Array.isArray(index.skills)) throw new Error('unsupported skill registry format');
    const q = str(input && input.query).trim().toLowerCase();
    const entries = index.skills.slice(0, 500).map(row => {
      let sourceUrl = '';
      try { sourceUrl = new URL(str(row && (row.sourceUrl || row.url)), got.url || url.href).href; } catch (_) {}
      return {
        name: str(row && row.name).slice(0, 80), description: str(row && row.description).slice(0, 280),
        sourceUrl, version: str(row && row.version).slice(0, 80), author: str(row && row.author).slice(0, 160),
        license: str(row && row.license).slice(0, 80), digest: str(row && row.digest).toLowerCase(), trust: 'community'
      };
    }).filter(row => row.name && /^https:\/\//.test(row.sourceUrl) && (!q || (row.name + ' ' + row.description + ' ' + row.author).toLowerCase().includes(q)));
    return { registryUrl: got.url || url.href, name: str(index.name || 'Skill registry').slice(0, 120), entries, cached, availability: 'reachable' };
  }
  async function discover(input) {
    let site; try { site = new URL(str(input && input.site)); } catch (_) { throw new Error('enter a public HTTPS site URL'); }
    if (site.protocol !== 'https:' || site.username || site.password) throw new Error('well-known discovery requires public HTTPS');
    const query = input && input.query;
    const rootUrl = new URL('/.well-known/starnet-skills.json', site.origin).href;
    try { return await search({ url: rootUrl, query }); }
    catch (rootError) {
      if (!/HTTP\s+404\b/i.test(str(rootError && rootError.message))) throw rootError;
      const base = site.pathname.endsWith('/') ? site : new URL('./', site);
      const scopedUrl = new URL('.well-known/starnet-skills.json', base).href;
      if (scopedUrl === rootUrl) throw rootError;
      return search({ url: scopedUrl, query });
    }
  }
  return { search, discover, _cache: cache };
}
module.exports = { FORMAT, makeSkillRegistry, semverParts, compareSemver, compareInstalled };
