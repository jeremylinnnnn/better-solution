---
name: better-solution
description: 从既有工程轨迹检索有证据的策略，或为候选策略登记并运行留出任务对照实验。用于明确要求复用历史解法、减少返工或验证策略收益的任务；没有证据库时不臆造通用规则。
metadata:
  short-description: 用历史证据选择可执行策略，并在留出任务上验证正确性与成本
---

# Better Solution

目标是经过验证的更好结果：先满足正确性和任务约束，再比较成功率与成本。策略是可观测触发条件和具体动作，不是对思维风格的模仿。依赖配套 work-log v4 和 Node.js 20+；不需要网络服务、向量库或微调。

脚本路径相对于本 SKILL.md 所在目录。按当前任务选择下面一种方式，不要加载与任务无关的协议细节。

## 在任务中使用已有策略

先从当前项目约定位置查找策略库，默认 `.better-solution/cards/`。没有库或没有匹配的有效策略时按任务自身要求继续，不新建经验卡、不追加通用说教。普通非平凡工程任务按 work-log 记录证据。

把已经可观测的任务特征写成 context JSON，包括 `task_family`、实际 `model` / `client` 与各自版本、`capabilities`、当前 `phase` 和必要信号。版本未知就跳过，不能编造。不要用运行之后的结果补填开始时的特征。

```bash
node scripts/policy.cjs recommend --cards /absolute/cards \
  --context /absolute/context.json --prompt
```

默认仅使用 active 策略，最多一张。信号未知、工具能力缺失、阶段不符、命中例外时跳过。匹配条件、卡片格式见 [references/policies.md](references/policies.md)。用户约束与已有权限始终优先。选中或注入不代表执行；在日志中用可观测动作引用记录是否采用、为何偏离，不推断隐藏备选方案。

## 从证据提出候选策略

```bash
node scripts/policy.cjs evidence --logs /absolute/worklogs
```

该命令仅导出已记录工具事件。人工或模型据此提出一条可证伪的干预，并绑定真实 run_id / step_id；解释标为推断，替代动作标为假设。不要声称原模型考虑过没有记录的方案。

卡片先设 experimental；在正式实验之外，不自动注入这些卡。确需探索时显式使用 `--experimental` 并说明尚未验证。没有真实发现证据的草稿不能登记实验。

## 验证候选策略

先读 [references/experiment.md](references/experiment.md)。第一版一次固定一个模型、客户端、任务族和策略；用独立留出任务、同一评估器、同一预算比较 baseline / strategy。

```bash
node scripts/experiment.cjs register --plan /absolute/plan.json --out /absolute/new-experiment
node scripts/experiment.cjs next --manifest /absolute/new-experiment/manifest.json
node scripts/experiment.cjs run --manifest /absolute/new-experiment/manifest.json --run-id REGISTERED_ID
node scripts/experiment.cjs analyze --manifest /absolute/new-experiment/manifest.json --out /absolute/report.json
```

执行 adapter 会调用计划中明确配置的程序，可能产生模型费用；只运行用户已授权的模型、工具和预算。不能用合成演示冒充真实模型实验。不要边看留出结果边改卡；改卡或重试需要新版本与新预登记实验。

结果允许 supported / opposed / inconclusive。没有证明收益时保留不确定性，不把“小样本全部通过”当成正确性保证。报告效应、区间、逐任务结果和未测指标，不合成总分。

达到冻结协议的门槛后，可用 `policy.cjs promote --card FILE --report FILE` 更新状态。该命令重新校验当前实验；synthetic 演示、证据缺失和范围不符不会激活策略。修改卡片行为会使旧验证失效。需要停用时把 status 改为 deprecated；第一版不自动淘汰或跨模型扩散。
