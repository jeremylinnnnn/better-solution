#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path');
const L = require('./lib.cjs'), { C } = L;
function main() {
  const o = C.args(process.argv.slice(2)), cmd = o._[0];
  if (o.help || !cmd) { console.log('policy.cjs validate --cards DIR\npolicy.cjs recommend --cards DIR --context FILE [--experimental] [--limit 1] [--prompt]\npolicy.cjs promote --card FILE --report FILE'); return; }
  if (cmd === 'promote') {
    const file = path.resolve(C.required(o, 'card')), report_file = path.resolve(C.required(o, 'report')), p = C.read(file), report = C.read(report_file);
    C.assert(p.status === 'experimental', 'only experimental policies can be promoted');
    const fresh = require('./experiment.cjs').analyze(report.manifest_file);
    C.assert(fresh.verdict === 'supported' && fresh.manifest_sha256 === report.manifest_sha256 && fresh.policy_hashes[p.policy_id] === L.policyHash(p), 'report is stale or not supported by current evidence');
    p.status = 'active'; p.validation = { report_file, sha256: C.digest(fs.readFileSync(report_file)) }; p.last_validated = report.generated_at;
    L.validatePolicy(p); C.write(file, p); console.log('OK promoted ' + p.policy_id); return;
  }
  if (cmd === 'evidence') {
    const result = [];
    for (const file of C.walk(path.resolve(C.required(o, 'logs')), '.jsonl')) {
      const records = C.lines(file), session = records[0]; if (session?.type !== 'session') continue;
      let previous = 0;
      for (const run of records.filter(x => x.type === 'run')) {
        const end = run.last_step_id ?? Infinity;
        result.push({ log_file: file, run_id: run.run_id, task_id: run.task_id, source_group: run.source_group || session.source_group || null, declared_status: run.status, events: records.filter(x => x.type === 'step' && x.step_id > previous && x.step_id <= end && x.tool_call).map(x => ({ step_id: x.step_id, tool_call: x.tool_call, tool_result: x.tool_result, check_id: x.check_id || null })) });
        previous = end;
      }
    }
    console.log(JSON.stringify({ evidence: result, note: 'Observed events only. Alternative actions and causal explanations must be labeled hypotheses; outcome claims still require receipt verification.' }, null, 2)); return;
  }
  const policies = L.loadPolicies(path.resolve(C.required(o, 'cards')));
  if (cmd === 'validate') { console.log(JSON.stringify({ valid: true, policies: policies.map(p => ({ id: p.policy_id, hash: L.policyHash(p), status: p.status })) }, null, 2)); return; }
  C.assert(cmd === 'recommend', 'unknown command');
  const limit = C.number(o.limit, 'limit', 1, true); C.assert(limit > 0, 'limit must be positive');
  const result = L.recommend(policies, C.read(C.required(o, 'context')), C.bool(o.experimental, false), limit);
  process.stdout.write(o.prompt ? L.promptFor(result) || 'No matching validated policy.\n' : JSON.stringify(result, null, 2) + '\n');
}
if (require.main === module) { try { main(); } catch (e) { console.error('ERROR: ' + e.message); process.exitCode = 1; } }
