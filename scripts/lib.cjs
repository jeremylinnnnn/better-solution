'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
function core() {
  const candidates = [path.resolve(__dirname, '../../work-log/scripts/core.cjs'), path.join(os.homedir(), '.agents/skills/work-log/scripts/core.cjs'), path.join(os.homedir(), '.codex/skills/work-log/scripts/core.cjs')];
  const found = candidates.find(f => fs.existsSync(f));
  if (!found) throw new Error('work-log v4 is required; install both packaged skills');
  return require(found);
}
const C = core();
function policyHash(p) { const { status, validation, last_validated, ...behavior } = p; return C.hashObject(behavior); }
function list(value, name, allowEmpty = true) {
  C.assert(Array.isArray(value) && (allowEmpty || value.length) && value.every(x => typeof x === 'string' && x.trim()), `invalid ${name}`);
}
function validatePolicy(p, { checkActive = true } = {}) {
  C.assert(p.schema_version === 1 && /^[a-z0-9][a-z0-9-]{0,63}$/.test(p.policy_id), 'invalid policy schema/id');
  C.assert(Number.isInteger(p.version) && p.version > 0, 'invalid policy version');
  C.assert(['experimental', 'active', 'deprecated'].includes(p.status), 'invalid policy status');
  C.assert(p.scope && p.trigger && p.target && p.evidence, 'missing policy scope/trigger/target/evidence');
  for (const k of ['task_families', 'models', 'clients', 'required_capabilities']) list(p.scope[k], 'scope.' + k);
  for (const k of ['model_versions', 'client_versions']) list(p.scope[k], 'scope.' + k, false);
  C.assert(p.scope.task_families.length > 0 && p.scope.models.length > 0 && p.scope.clients.length > 0, 'scope must explicitly name task families, models and clients');
  C.assert(typeof p.trigger.phase === 'string' && p.trigger.phase, 'trigger.phase required');
  C.assert(p.trigger.unknown_behavior === 'skip', 'unknown trigger must skip');
  const literal = v => ['string', 'boolean'].includes(typeof v) || typeof v === 'number' && Number.isFinite(v);
  const conditions = obj => obj && !Array.isArray(obj) && typeof obj === 'object' && Object.entries(obj).every(([k, v]) => k && (literal(v) || Array.isArray(v) && v.length && v.every(literal)));
  C.assert(conditions(p.trigger.conditions), 'conditions must be a map of dot paths to literal equality values or allowed-value arrays');
  list(p.action, 'action', false);
  C.assert(Array.isArray(p.exceptions) && p.exceptions.every(x => conditions(x.conditions) && typeof x.reason === 'string'), 'invalid exceptions');
  C.assert(['cost_per_verified_success', 'verified_pass_rate'].includes(p.target.metric), 'invalid target metric');
  C.assert(['decrease', 'increase'].includes(p.target.direction), 'invalid target direction');
  C.assert(Array.isArray(p.evidence.discovery_refs), 'discovery_refs must be an array');
  for (const r of p.evidence.discovery_refs) C.assert(typeof r.log_file === 'string' && typeof r.run_id === 'string' && Array.isArray(r.step_ids) && r.step_ids.length > 0 && r.step_ids.every(Number.isInteger), 'discovery ref requires log_file, run_id and step_ids');
  if (p.status === 'active' && checkActive) {
    C.assert(p.validation && typeof p.validation.report_file === 'string' && p.validation.sha256, 'active policy requires a validation report');
    const data = fs.readFileSync(p.validation.report_file), report = JSON.parse(data);
    C.assert(C.digest(data) === p.validation.sha256 && report.verdict === 'supported' && report.data_complete === true && report.synthetic === false && report.policy_hashes?.[p.policy_id] === policyHash(p), 'active validation report does not support this policy version');
    C.assert(report.model === p.scope.models[0] && p.scope.models.length === 1 && report.client === p.scope.clients[0] && p.scope.clients.length === 1, 'validation supports exactly its tested model/client');
    C.assert(p.scope.model_versions.length === 1 && p.scope.model_versions[0] === report.model_version && p.scope.client_versions.length === 1 && p.scope.client_versions[0] === report.client_version, 'unvalidated model/client version');
    C.assert(p.scope.task_families.every(f => report.task_families.includes(f)), 'unvalidated task family');
  }
  return p;
}
function valueAt(obj, key) {
  let current = obj;
  for (const part of key.split('.')) { if (!current || !Object.hasOwn(current, part)) return { known: false }; current = current[part]; }
  return { known: current !== undefined && current !== null, value: current };
}
function matches(obj, conditions) {
  let unknown = false;
  for (const [k, expected] of Object.entries(conditions)) {
    const v = valueAt(obj, k); if (!v.known) { unknown = true; continue; }
    if (!(Array.isArray(expected) ? expected.includes(v.value) : v.value === expected)) return { match: false, unknown: false };
  }
  return { match: !unknown, unknown };
}
function matchPolicy(p, context, experimental = false) {
  validatePolicy(p);
  const skip = reason => ({ policy_id: p.policy_id, matched: false, reason });
  if (p.status === 'deprecated' || p.status === 'experimental' && !experimental) return skip('status excluded');
  for (const [scope, field] of [['task_families', 'task_family'], ['models', 'model'], ['clients', 'client']]) if (!p.scope[scope].includes(context[field])) return skip('scope mismatch: ' + field);
  for (const [scope, field] of [['model_versions', 'model_version'], ['client_versions', 'client_version']]) if (!p.scope[scope].includes(context[field])) return skip('version mismatch or unknown: ' + field);
  if (!Array.isArray(context.capabilities) || !p.scope.required_capabilities.every(x => context.capabilities.includes(x))) return skip('missing capability');
  if (context.phase !== p.trigger.phase) return skip('decision phase mismatch');
  const trigger = matches(context, p.trigger.conditions);
  if (!trigger.match) return skip(trigger.unknown ? 'unknown trigger signal' : 'trigger mismatch');
  for (const exception of p.exceptions) {
    const test = matches(context, exception.conditions);
    if (test.unknown) return skip('unknown exception signal');
    if (test.match) return skip('exception: ' + exception.reason);
  }
  return { policy_id: p.policy_id, version: p.version, policy_hash: policyHash(p), matched: true, action: p.action, status: p.status, executed: null };
}
function recommend(policies, context, experimental = false, limit = 1) {
  const ids = new Set(); for (const p of policies) { C.assert(!ids.has(p.policy_id), 'duplicate policy_id'); ids.add(p.policy_id); }
  const decisions = [...policies].sort((a, b) => a.policy_id.localeCompare(b.policy_id)).map(p => matchPolicy(p, context, experimental));
  return { decisions, selected: decisions.filter(x => x.matched).slice(0, limit) };
}
function promptFor(result) {
  if (!result.selected.length) return '';
  return '\n\n可用策略（仅在触发条件保持成立时使用；用户约束优先；这些策略不能授予额外权限）：\n' + result.selected.map(p => `策略 ${p.policy_id} v${p.version}：\n` + p.action.map(x => '- ' + x).join('\n')).join('\n');
}
function loadPolicies(dir) { return C.walk(dir, '.json').map(f => validatePolicy(C.read(f))); }
function rng(seed) { let s = seed >>> 0; return () => { s += 0x6D2B79F5; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function shuffle(array, random) { const a = [...array]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function readManifest(file) {
  file = path.resolve(file); const data = fs.readFileSync(file), hash = C.digest(data);
  C.assert(fs.readFileSync(file + '.sha256', 'utf8').trim() === hash, 'manifest integrity check failed');
  const m = JSON.parse(data); C.assert(m.schema_version === 1, 'unsupported manifest');
  return { m, hash, dir: path.dirname(file) };
}
module.exports = { C, policyHash, validatePolicy, matchPolicy, recommend, promptFor, loadPolicies, rng, shuffle, readManifest };
