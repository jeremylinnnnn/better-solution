#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path');
const L = require('./lib.cjs'), { C } = L;

function resolveFiles(def, base) {
  C.assert(def && Array.isArray(def.argv) && def.argv.length && def.argv.every(x => typeof x === 'string'), 'adapter.argv required');
  C.assert(Array.isArray(def.files) && def.files.length, 'adapter.files must pin the adapter implementation');
  const files = def.files.map(f => { const file = fs.realpathSync(path.resolve(base, f)); return { file, sha256: C.digest(fs.readFileSync(file)) }; });
  return { argv: def.argv, files, sha256: C.hashObject({ argv: def.argv, files }) };
}
function verifyAdapter(adapter) {
  C.assert(adapter.files.every(f => C.digest(fs.readFileSync(f.file)) === f.sha256), 'adapter implementation changed after registration');
}
function discovery(policies) {
  const groups = new Set(), tasks = new Set(), refs = [];
  for (const p of policies) {
    C.assert(p.evidence.discovery_refs.length, 'experimental policy needs real discovery refs before registration');
    for (const ref of p.evidence.discovery_refs) {
      C.assert(path.isAbsolute(ref.log_file), 'discovery log_file must be absolute');
      const records = C.lines(ref.log_file), s = records[0], run = records.find(x => x.type === 'run' && x.run_id === ref.run_id);
      C.assert(s?.type === 'session' && run && run.task_id === s.task_id && run.model === s.model, 'discovery run not found or identity mismatch');
      const runIndex = records.indexOf(run), previous = records.slice(0, runIndex).filter(x => x.type === 'run').at(-1)?.last_step_id || 0;
      const end = Number.isInteger(run.last_step_id) ? run.last_step_id : Infinity;
      C.assert(ref.step_ids.every(id => id > previous && id <= end && records.slice(0, runIndex).some(x => x.type === 'step' && x.step_id === id)), 'discovery step not found in referenced run');
      const group = run.source_group || s.source_group || ref.source_group; C.assert(typeof group === 'string' && group, 'discovery log/ref needs source_group to check leakage');
      if (ref.source_group && (run.source_group || s.source_group)) C.assert(ref.source_group === group, 'discovery source_group annotation contradicts log');
      groups.add(group); tasks.add(run.task_id); refs.push({ file: ref.log_file, sha256: C.digest(fs.readFileSync(ref.log_file)), run_id: ref.run_id });
    }
  }
  return { source_groups: [...groups].sort(), task_ids: [...tasks].sort(), refs };
}
function register(plan_file, out) {
  plan_file = path.resolve(plan_file); const plan = C.read(plan_file), base = path.dirname(plan_file);
  C.assert(plan.schema_version === 1, 'plan schema_version must be 1');
  for (const key of ['experiment_id', 'model', 'model_version', 'client', 'client_version', 'env_hash', 'prompt_version']) C.assert(typeof plan[key] === 'string' && plan[key], 'missing plan.' + key);
  C.assert(/^[a-z0-9][a-z0-9-]{0,63}$/.test(plan.experiment_id), 'invalid experiment_id');
  C.assert(Number.isInteger(plan.seed) && plan.seed >= 0 && plan.seed <= 0xffffffff, 'seed must be uint32');
  C.assert(Number.isInteger(plan.repeats) && plan.repeats >= 1, 'invalid repeats');
  C.assert(Number.isInteger(plan.timeout_ms) && plan.timeout_ms > 0, 'timeout_ms required');
  C.assert(Array.isArray(plan.tool_inventory) && plan.tool_inventory.length && plan.tool_inventory.every(x => typeof x === 'string'), 'tool_inventory required');
  C.assert(Array.isArray(plan.policy_files) && plan.policy_files.length === 1, 'MVP tests exactly one policy');
  const policies = plan.policy_files.map(f => L.validatePolicy(C.read(path.resolve(base, f))));
  C.assert(policies.every(p => ['models', 'clients', 'model_versions', 'client_versions', 'task_families'].every(k => p.scope[k].length === 1)), 'narrow candidate scope to the single model/client/version/family being tested before registration');
  C.assert(policies.every(p => p.scope.model_versions.includes(plan.model_version) && p.scope.client_versions.includes(plan.client_version)), 'policy model/client version mismatch');
  const evidence = discovery(policies), adapter = resolveFiles(plan.adapter, base);
  const analysis = plan.analysis;
  C.assert(analysis && analysis.cost_metric === 'wall_time_s', 'MVP requires harness-measured wall_time_s; other units need a client adapter');
  for (const [key, min, max] of [['alpha', 0, 0.5], ['noninferiority_margin', 0, 1], ['cost_ratio_target', 0, 1]]) C.assert(typeof analysis[key] === 'number' && analysis[key] >= min && analysis[key] <= max && (key !== 'alpha' || analysis[key] > 0), 'invalid analysis.' + key);
  C.assert(Number.isInteger(analysis.min_tasks) && analysis.min_tasks >= 2, 'analysis.min_tasks must be >= 2');
  C.assert(Number.isInteger(analysis.bootstrap_samples) && analysis.bootstrap_samples >= 200 && analysis.bootstrap_samples <= 100000, 'bootstrap_samples must be 200..100000');
  C.assert(Array.isArray(plan.tasks) && plan.tasks.length >= 2, 'at least two holdout tasks required');
  const taskIds = new Set(), groups = new Set();
  const tasks = plan.tasks.map(t => {
    C.assert(typeof t.task_id === 'string' && t.task_id && !taskIds.has(t.task_id), 'missing or duplicate task_id'); taskIds.add(t.task_id);
    C.assert(typeof t.source_group === 'string' && t.source_group && !groups.has(t.source_group), 'holdout tasks must use distinct source_groups (one task per independent cluster in MVP)'); groups.add(t.source_group);
    C.assert(!evidence.task_ids.includes(t.task_id) && !evidence.source_groups.includes(t.source_group), 'discovery/holdout leakage');
    C.assert(typeof t.task_family === 'string' && t.task_family, 'task_family required');
    const artifact_dir = fs.realpathSync(path.resolve(base, t.artifact_dir)), evaluator_file = path.resolve(base, t.evaluator_file);
    C.assert(!C.inside(artifact_dir, out), 'experiment output must be outside task artifact');
    const ev = C.evaluatorSpec(evaluator_file);
    C.assert(!C.inside(artifact_dir, evaluator_file) && ev.files.every(f => !C.inside(artifact_dir, f.path)), 'evaluator must be outside task artifact');
    C.assert(adapter.files.every(f => !C.inside(artifact_dir, f.file)), 'adapter implementation must be outside task artifact');
    const context = { ...(t.context || {}), task_family: t.task_family, model: plan.model, client: plan.client, capabilities: [...new Set(plan.tool_inventory)].sort() };
    context.model_version = plan.model_version;
    context.client_version = plan.client_version;
    C.assert(context.phase === 'task_start', 'MVP harness injects only at task_start; later decision points need an adapter hook');
    const rec = L.recommend(policies, context, true, 1);
    return { task_id: t.task_id, source_group: t.source_group, task_family: t.task_family, artifact_dir, artifact_sha256: C.treeHash(artifact_dir), evaluator_file, evaluator_hash: ev.sha256, prompt: fs.readFileSync(path.resolve(base, t.prompt_file), 'utf8'), context, preregistered_match: rec.selected.length > 0 };
  });
  C.assert(tasks.some(t => t.preregistered_match), 'policy never matches the registered task contexts');
  C.assert(policies.every(p => p.scope.models.includes(plan.model) && p.scope.clients.includes(plan.client)), 'policy model/client scope mismatch');
  for (const t of tasks) C.assert(policies[0].scope.task_families.includes(t.task_family), 'holdout family outside policy scope');
  C.assert(new Set(tasks.map(t => t.task_family)).size === 1, 'MVP validates one task family at a time');
  const assignments = []; let index = 0;
  for (const t of tasks) for (let repeat = 0; repeat < plan.repeats; repeat++) for (const arm of ['baseline', 'strategy']) assignments.push({ run_id: plan.experiment_id + '-' + String(++index).padStart(5, '0'), task_id: t.task_id, repeat, arm });
  const manifest = { schema_version: 1, experiment_id: plan.experiment_id, registered_at: new Date().toISOString(), synthetic: plan.synthetic === true, model: plan.model, model_version: plan.model_version, client: plan.client, client_version: plan.client_version, env_hash: plan.env_hash, prompt_version: plan.prompt_version, seed: plan.seed, repeats: plan.repeats, timeout_ms: plan.timeout_ms, tool_inventory: [...new Set(plan.tool_inventory)].sort(), analysis, adapter, discovery: evidence, policies, policy_hashes: Object.fromEntries(policies.map(p => [p.policy_id, L.policyHash(p)])), tasks, assignments: L.shuffle(assignments, L.rng(plan.seed)) };
  fs.mkdirSync(out, { recursive: false });
  for (const sub of ['results', 'workspaces', 'evidence', 'prompts', 'locks', 'adapter-output']) fs.mkdirSync(path.join(out, sub));
  const file = path.join(out, 'manifest.json'); C.write(file, manifest, true);
  fs.writeFileSync(file + '.sha256', C.digest(fs.readFileSync(file)) + '\n', { flag: 'wx' });
  return { manifest_file: file, runs: assignments.length, tasks: tasks.length, preregistered_matches: tasks.filter(t => t.preregistered_match).length };
}
async function run(manifest_file, run_id) {
  const { m, hash, dir } = L.readManifest(manifest_file), a = m.assignments.find(x => x.run_id === run_id);
  C.assert(a, 'unregistered run_id');
  const t = m.tasks.find(x => x.task_id === a.task_id), file = path.join(dir, 'results', a.run_id + '.jsonl');
  const lock = path.join(dir, 'locks', a.run_id + '.lock');
  C.assert(!fs.existsSync(file), 'run already started; retries require a new preregistered experiment');
  fs.writeFileSync(lock, new Date().toISOString(), { flag: 'wx' });
  const started_at = new Date().toISOString(), start = performance.now();
  fs.writeFileSync(file, JSON.stringify({ type: 'session', schema_version: 2, run_id, task_id: t.task_id, source_group: t.source_group, task_family: t.task_family, model: m.model, task: t.prompt, started_at, arm: a.arm, repeat: a.repeat, manifest_sha256: hash }) + '\n', { flag: 'wx' });
  let adapter_result = null, verification = null, failure = null, rec = { decisions: [], selected: [] }, workspace = path.join(dir, 'workspaces', run_id);
  try {
    verifyAdapter(m.adapter);
    C.assert(C.treeHash(t.artifact_dir) === t.artifact_sha256, 'initial artifact changed since registration');
    C.assert(C.evaluatorSpec(t.evaluator_file).sha256 === t.evaluator_hash, 'evaluator changed since registration');
    for (const ref of m.discovery.refs) C.assert(C.digest(fs.readFileSync(ref.file)) === ref.sha256, 'discovery evidence changed since registration');
    fs.cpSync(t.artifact_dir, workspace, { recursive: true, errorOnExist: true, force: false, filter: src => !['.git', 'node_modules'].includes(path.basename(src)) });
    C.assert(C.treeHash(workspace) === t.artifact_sha256, 'workspace copy mismatch');
    if (a.arm === 'strategy') rec = L.recommend(m.policies, t.context, true, 1);
    const prompt_file = path.join(dir, 'prompts', run_id + '.txt'); fs.writeFileSync(prompt_file, t.prompt + L.promptFor(rec), { flag: 'wx' });
    C.write(path.join(dir, 'prompts', run_id + '.policy.json'), { ...rec, executed: null, note: 'injection is observable; adherence is not inferred from injection' }, true);
    const replacements = { '{workspace}': workspace, '{prompt_file}': prompt_file, '{run_id}': run_id };
    const argv = m.adapter.argv.map(s => Object.entries(replacements).reduce((v, [k, x]) => v.replaceAll(k, x), s));
    adapter_result = await C.execute(argv, { cwd: workspace, timeout_ms: m.timeout_ms, stdout_file: path.join(dir, 'adapter-output', run_id + '.stdout.txt'), stderr_file: path.join(dir, 'adapter-output', run_id + '.stderr.txt') });
    verification = await C.evaluate({ spec_file: t.evaluator_file, artifact_dir: workspace, evidence_dir: path.join(dir, 'evidence', run_id), run_id, task_id: t.task_id, expected_spec_hash: t.evaluator_hash });
  } catch (e) { failure = e.message; }
  const status = !failure && adapter_result?.exit_code === 0 && !adapter_result.timed_out && !adapter_result.spawn_error ? 'success' : 'failed';
  const r = { type: 'run', schema_version: 2, run_id, task_id: t.task_id, source_group: t.source_group, task_family: t.task_family, model: m.model, model_version: m.model_version, client: m.client, client_version: m.client_version, arm: a.arm, repeat: a.repeat, env_hash: m.env_hash, prompt_version: m.prompt_version, tool_inventory: m.tool_inventory, manifest_sha256: hash, status, started_at, ended_at: new Date().toISOString(), wall_time_s: (performance.now() - start) / 1000, metrics_source: 'harness', human_interventions: null, tool_calls: null, failed_tool_calls: null, tokens_in: null, tokens_out: null, adapter_result, failure, policy_injected: rec.selected.map(p => p.policy_id), policy_executed: null };
  C.append(file, r);
  if (verification) C.append(file, { type: 'outcome', schema_version: 2, run_id, task_id: t.task_id, evaluator: verification.receipt.evaluator.id, pass: verification.receipt.pass, evidence_ref: path.relative(path.dirname(file), verification.receipt_file), evidence_sha256: verification.receipt_sha256, evaluated_at: verification.receipt.evaluated_at });
  return { run_id, status, evaluator_pass: verification?.receipt.pass ?? null, failure, result_file: file };
}
function collect(manifest_file) {
  const { m, hash, dir } = L.readManifest(manifest_file), issues = [], rows = [];
  const assigned = new Set(m.assignments.map(a => a.run_id));
  for (const name of fs.readdirSync(path.join(dir, 'results'))) if (!name.endsWith('.jsonl') || !assigned.has(name.slice(0, -6))) issues.push('unregistered result file: ' + name);
  for (const a of m.assignments) {
    const t = m.tasks.find(t => t.task_id === a.task_id), file = path.join(dir, 'results', a.run_id + '.jsonl');
    let r = null, verified = false, pass = false, reason = null;
    if (!fs.existsSync(file)) reason = 'missing run';
    else try {
      const records = C.lines(file), sessions = records.filter(r => r.type === 'session'), runs = records.filter(r => r.type === 'run'), outcomes = records.filter(r => r.type === 'outcome');
      C.assert(sessions.length === 1 && runs.length === 1, 'unfinished run or duplicate records');
      r = runs[0];
      for (const item of [sessions[0], r]) C.assert(item.run_id === a.run_id && item.task_id === a.task_id && item.model === m.model && item.arm === a.arm && item.repeat === a.repeat && item.manifest_sha256 === hash, 'assignment/identity mismatch');
      C.assert(r.metrics_source === 'harness' && typeof r.wall_time_s === 'number' && Number.isFinite(r.wall_time_s) && r.wall_time_s >= 0, 'missing harness timing');
      C.assert(outcomes.length === 1, 'missing/duplicate outcome');
      const v = C.verifyOutcome(outcomes[0], r, path.dirname(file), { evaluator_hash: t.evaluator_hash, artifact_dir: path.join(dir, 'workspaces', a.run_id) });
      verified = v.verified; pass = verified && v.pass && r.status === 'success'; reason = v.reason;
    } catch (e) { reason = e.message; }
    if (reason) issues.push(a.run_id + ': ' + reason);
    rows.push({ ...a, source_group: t.source_group, task_family: t.task_family, verified, pass, cost: r && typeof r.wall_time_s === 'number' && Number.isFinite(r.wall_time_s) && r.wall_time_s >= 0 ? r.wall_time_s : null, status: r?.status || 'missing', policy_injected: r?.policy_injected || [], human_interventions: r?.human_interventions ?? null, reason });
  }
  return { m, hash, dir, rows, issues };
}
function armMetrics(rows) {
  const success = rows.filter(r => r.pass).length, complete = rows.every(r => r.cost !== null);
  const total = complete ? rows.reduce((s, r) => s + r.cost, 0) : null;
  return { assigned: rows.length, verified: rows.filter(r => r.verified).length, verified_success: success, pass_rate: success / rows.length, total_cost: total, mean_cost: complete ? total / rows.length : null, cost_per_verified_success: success && complete ? total / success : null, missing_cost: rows.filter(r => r.cost === null).length };
}
function quantile(values, q) { const a = [...values].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * a.length)))]; }
function analyze(manifest_file) {
  const { m, hash, rows, issues } = collect(manifest_file), config = m.analysis;
  const baseline = armMetrics(rows.filter(r => r.arm === 'baseline')), strategy = armMetrics(rows.filter(r => r.arm === 'strategy'));
  const per_task = m.tasks.map(t => { const rs = rows.filter(r => r.task_id === t.task_id); return { task_id: t.task_id, source_group: t.source_group, task_family: t.task_family, baseline: armMetrics(rs.filter(r => r.arm === 'baseline')), strategy: armMetrics(rs.filter(r => r.arm === 'strategy')) }; });
  const data_complete = issues.length === 0 && rows.every(r => r.verified && r.cost !== null);
  const random = L.rng(m.seed ^ 0xabcdef), deltas = [], ratios = [];
  const byTask = new Map(m.tasks.map(t => [t.task_id, rows.filter(r => r.task_id === t.task_id)]));
  for (let i = 0; i < config.bootstrap_samples; i++) {
    const draw = [];
    for (let j = 0; j < m.tasks.length; j++) {
      const task = m.tasks[Math.floor(random() * m.tasks.length)], rs = byTask.get(task.task_id);
      for (let k = 0; k < m.repeats; k++) { const repeat = Math.floor(random() * m.repeats); draw.push(...rs.filter(r => r.repeat === repeat)); }
    }
    const b = armMetrics(draw.filter(r => r.arm === 'baseline')), s = armMetrics(draw.filter(r => r.arm === 'strategy'));
    deltas.push(s.pass_rate - b.pass_rate);
    ratios.push(b.cost_per_verified_success !== null && b.cost_per_verified_success > 0 && s.cost_per_verified_success !== null ? s.cost_per_verified_success / b.cost_per_verified_success : Infinity);
  }
  const delta = strategy.pass_rate - baseline.pass_rate;
  const ratio = baseline.cost_per_verified_success !== null && baseline.cost_per_verified_success > 0 && strategy.cost_per_verified_success !== null ? strategy.cost_per_verified_success / baseline.cost_per_verified_success : null;
  const alpha = config.alpha, bootstrap_delta_ci = [quantile(deltas, alpha / 2), quantile(deltas, 1 - alpha / 2)], ratioLow = quantile(ratios, alpha / 2), ratioHigh = quantile(ratios, 1 - alpha / 2);
  // Hoeffding for independent task-cluster mean differences in [-1, 1]. Deliberately conservative;
  // unlike bootstrap, all-pass data do not produce a zero-width correctness guarantee.
  const safety_radius = Math.sqrt(2 * Math.log(2 / alpha) / m.tasks.length);
  const safety_lower = Math.max(-1, delta - safety_radius), safety_upper = Math.min(1, delta + safety_radius);
  const adequate = m.tasks.length >= config.min_tasks;
  const guards = { noninferiority: safety_lower >= -config.noninferiority_margin, cost_target: Number.isFinite(ratioHigh) && ratioHigh <= config.cost_ratio_target, sufficient_tasks: adequate, complete_data: data_complete, non_synthetic: !m.synthetic };
  let verdict = 'inconclusive';
  if (Object.values(guards).every(Boolean)) verdict = 'supported';
  else if (data_complete && adequate && (safety_upper < -config.noninferiority_margin || Number.isFinite(ratioLow) && ratioLow > 1)) verdict = 'opposed';
  const pilot_signal = data_complete && delta >= -config.noninferiority_margin && ratio !== null && ratio <= config.cost_ratio_target;
  // Only point-estimate dominance is reported; uncertainty remains in the separate intervals.
  const dominates = (a, b) => a.mean_cost !== null && b.mean_cost !== null && a.pass_rate >= b.pass_rate && a.mean_cost <= b.mean_cost && (a.pass_rate > b.pass_rate || a.mean_cost < b.mean_cost);
  const pareto = { axes: ['verified_pass_rate', 'mean_wall_time_s_per_assigned_run'], point_estimate_only: true, frontier: ['baseline', 'strategy'].filter(arm => !dominates(arm === 'baseline' ? strategy : baseline, arm === 'baseline' ? baseline : strategy)) };
  const variance = values => { const mean = values.reduce((a, b) => a + b, 0) / values.length; return values.length > 1 ? values.reduce((s, x) => s + (x - mean) ** 2, 0) / (values.length - 1) : null; };
  const task_variance = Object.fromEntries(['baseline', 'strategy'].map(arm => [arm, { pass_rate: variance(per_task.map(t => t[arm].pass_rate)), mean_cost: per_task.every(t => t[arm].mean_cost !== null) ? variance(per_task.map(t => t[arm].mean_cost)) : null }]));
  const report_metadata = { model_version: m.model_version, client_version: m.client_version, pareto, task_variance };
  return {
    schema_version: 1, generated_at: new Date().toISOString(), experiment_id: m.experiment_id,
    manifest_file: path.resolve(manifest_file), manifest_sha256: hash,
    model: m.model, client: m.client, ...report_metadata, synthetic: m.synthetic,
    task_families: [...new Set(m.tasks.map(t => t.task_family))], policy_hashes: m.policy_hashes,
    data_complete, verdict, pilot_signal, guards, cost_metric: 'wall_time_s',
    cost_definition: 'harness time from run start through workspace preparation, policy retrieval/injection, adapter execution and evaluation; all assigned runs remain in denominator',
    baseline, strategy,
    effect: {
      pass_rate_delta: delta, bootstrap_delta_ci,
      correctness_conservative_interval: [safety_lower, safety_upper], cost_per_success_ratio: ratio,
      bootstrap_cost_ratio_ci: [Number.isFinite(ratioLow) ? ratioLow : null, Number.isFinite(ratioHigh) ? ratioHigh : null],
      cost_ratio_upper_unbounded: !Number.isFinite(ratioHigh)
    },
    per_task, assignments: rows, issues,
    policy_injected_runs: rows.filter(r => r.policy_injected.length).length,
    adherence: 'not measured; injection does not establish execution',
    guardrails: {
      hidden_correctness_and_regression_checks: 'defined by the registered evaluator',
      human_interventions: 'unmeasured; no claim of non-increase', maintainability: 'unmeasured'
    },
    uncertainty: {
      alpha, bootstrap_samples: config.bootstrap_samples, independent_clusters: m.tasks.length,
      method: 'paired task-cluster bootstrap with within-task paired repeat resampling; correctness gate uses a conservative bounded-difference interval',
      limitations: [
        'bootstrap cost intervals are approximate; this is not a sequential test',
        'task population claims require independently sampled source groups; distinct labels alone do not ensure independence',
        'same-user integrity checks do not resist an agent with write access to the harness or evaluators',
        'no claim of cross-model or cross-client generalization',
        'fixed model/client adapter and declared environment; tool inventory and environment isolation still require operator verification'
      ]
    }
  };
}
function markdown(r) {
  const esc = x => String(x).replaceAll('|', '\\|').replaceAll('\n', ' ');
  return [
    '# Better-Solution 实验结果', '', `- 实验：${r.experiment_id}`,
    `- 结论：${r.verdict}${r.synthetic ? '（合成演示，不是策略收益证据）' : ''}`,
    `- 数据完整：${r.data_complete}`, `- 独立任务簇：${r.uncertainty.independent_clusters}`,
    `- 成本单位：${r.cost_metric}`, '',
    '| 实验臂 | 已分配 | 验证成功 | 通过率 | 平均秒数 | 秒/成功 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...['baseline', 'strategy'].map(k => `| ${k} | ${r[k].assigned} | ${r[k].verified_success} | ${(100 * r[k].pass_rate).toFixed(1)}% | ${r[k].mean_cost ?? '-'} | ${r[k].cost_per_verified_success ?? '-'} |`),
    '', 'Pareto 前沿（点估计）：' + r.pareto.frontier.join(' / ') + '；不代表差异已经得到统计支持。',
    '', '| 留出任务 | 基线成功/分配 | 策略成功/分配 |', '| --- | ---: | ---: |',
    ...r.per_task.map(t => `| ${esc(t.task_id)} | ${t.baseline.verified_success}/${t.baseline.assigned} | ${t.strategy.verified_success}/${t.strategy.assigned} |`),
    '', '```json', JSON.stringify({ effect: r.effect, task_variance: r.task_variance, guards: r.guards, issues: r.issues, guardrails: r.guardrails, uncertainty: r.uncertainty }, null, 2), '```', ''
  ].join('\n');
}
async function main() {
  const o = C.args(process.argv.slice(2)), cmd = o._[0];
  if (!cmd || o.help) { console.log('experiment.cjs register --plan FILE --out NEW_DIR\nexperiment.cjs next --manifest FILE\nexperiment.cjs run --manifest FILE --run-id ID\nexperiment.cjs analyze --manifest FILE [--out FILE] [--markdown]'); return; }
  let result;
  if (cmd === 'register') result = register(C.required(o, 'plan'), path.resolve(C.required(o, 'out')));
  else if (cmd === 'next') { const { m, dir } = L.readManifest(C.required(o, 'manifest')); result = { next: m.assignments.find(a => !fs.existsSync(path.join(dir, 'results', a.run_id + '.jsonl')) && !fs.existsSync(path.join(dir, 'locks', a.run_id + '.lock'))) || null, unfinished_or_missing_runs_remain_in_analysis: true }; }
  else if (cmd === 'run') result = await run(C.required(o, 'manifest'), C.required(o, 'run-id'));
  else if (cmd === 'analyze') result = analyze(C.required(o, 'manifest'));
  else throw new Error('unknown command');
  if (o.out) {
    if (o.markdown) { fs.writeFileSync(o.out, markdown(result), { flag: 'wx' }); }
    else C.write(path.resolve(o.out), result, true);
    console.log('OUT=' + path.resolve(o.out));
  } else process.stdout.write(o.markdown ? markdown(result) : JSON.stringify(result, null, 2) + '\n');
}
if (require.main === module) main().catch(e => { console.error('ERROR: ' + e.message); process.exitCode = 1; });
module.exports = { register, run, collect, analyze, markdown, armMetrics };
