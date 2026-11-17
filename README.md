# better-solution

> Pick engineering strategies from recorded evidence, and validate them on held-out tasks.

An agent skill for reusing proven solutions instead of guessing. It reads a local evidence base of past engineering runs, recommends a strategy that actually matches the current task, and — when you want proof — registers a pre-declared experiment that compares baseline against strategy on held-out tasks.

The core rule: **a strategy is a set of observable trigger conditions plus concrete actions, not an imitation of a thinking style.** Nothing gets promoted to "active" without an experiment that could have failed.

## What problem this solves

Agents retry the same fix, re-walk the same dead ends, and report success without verification. Recording logs is not enough — you need a way to turn those logs into a small number of falsifiable strategies, and a way to reject the ones that don't work.

This skill covers that loop in three stages.

## The three stages

### 1. Use an existing strategy

Look up the project's strategy library (default `.better-solution/cards/`), build a context JSON from *observable* task features, and get at most one matching active strategy.

```bash
node scripts/policy.cjs recommend --cards /abs/cards \
  --context /abs/context.json --prompt
```

If there is no library, or nothing matches, the skill tells the agent to just do the task — **it does not invent cards or append generic advice.** Context must describe the task *before* you run it; results may not be used to backfill the starting features.

### 2. Propose a candidate from evidence

```bash
node scripts/policy.cjs evidence --logs /abs/worklogs
```

This exports recorded tool events only. A human or model then proposes one falsifiable intervention, bound to real `run_id` / `step_id`. Interpretations are labelled as inference; alternative actions are labelled as hypothesis. The skill explicitly forbids claiming the original model "considered" an unrecorded option.

New cards start as `experimental` and are never auto-injected.

### 3. Validate on held-out tasks

```bash
node scripts/experiment.cjs register --plan /abs/plan.json --out /abs/new-experiment
node scripts/experiment.cjs next     --manifest /abs/new-experiment/manifest.json
node scripts/experiment.cjs run      --manifest /abs/new-experiment/manifest.json --run-id REGISTERED_ID
node scripts/experiment.cjs analyze  --manifest /abs/new-experiment/manifest.json --out /abs/report.json
```

One experiment fixes one model, one client, one task family and one strategy. Baseline and strategy are compared with the same evaluator and the same budget, on tasks held out from the ones that produced the candidate.

Results may be `supported`, `opposed` or `inconclusive`. A small sample that passes everything is not treated as a correctness guarantee. Reports carry effect size, intervals, per-task results and untested metrics — deliberately **no composite score**.

Promotion (`policy.cjs promote`) re-validates the experiment; synthetic demos, missing evidence and out-of-scope results never activate a strategy.

## Requirements

- Node.js 20+
- [work-log](../work-log) v4 (the companion skill that produces the evidence base)

No network service, no vector database, no fine-tuning.

## Install

```bash
git clone https://github.com/jeremylinnnnn/better-solution.git \
  ~/.workbuddy-ai/skills/better-solution
```

For Claude Code, clone into `~/.claude/skills/better-solution` instead. The skill format (`SKILL.md` + YAML frontmatter) is the same in both.

## Layout

```
SKILL.md                  entry point and decision rules
references/policies.md    card format and matching conditions
references/experiment.md  experiment protocol
scripts/policy.cjs        recommend / evidence / promote
scripts/experiment.cjs    register / next / run / analyze
scripts/lib.cjs           shared helpers
agents/openai.yaml        agent metadata
```

## Design principles

- **Evidence before opinion.** No card without a real run behind it.
- **Falsifiable or it doesn't count.** A strategy must be able to fail.
- **Held-out, not replayed.** Validation uses tasks the candidate never saw.
- **Uncertainty is an acceptable answer.** `inconclusive` is a valid outcome.
- **User constraints win.** Permissions and explicit instructions always override a recommended strategy.

## License

MIT — see [LICENSE](LICENSE).
