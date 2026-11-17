# 预登记与留出实验

第一版固定一个模型、客户端、任务族和策略。每个任务有唯一 task_id 与 source_group；同问题变体留在发现集，不能改名进入留出集。当前要求留出集中每个 source_group 只放一个任务，避免把相关变体当成独立样本。

推荐预算：4 个发现任务各 3 次（12 次），手写 1 张候选卡，12 个独立留出任务 × 两臂 × 3 次（72 次），合计 84 次。这个预算用于 pilot，不保证足以通过非劣门槛；不能仅因证据不足就增加字段或宣布整个方向无效。

## 计划 JSON

下面展示完整字段形状。路径按 plan.json 所在目录解释，运行 adapter 的程序、模型费用和预算必须事先得到授权；登记本身不会执行 adapter。

```json
{
  "schema_version": 1,
  "experiment_id": "dependency-pilot-v1",
  "synthetic": false,
  "model": "actual-model-id",
  "model_version": "pinned-version",
  "client": "actual-client-id",
  "client_version": "pinned-version",
  "env_hash": "sha256:actual-environment-snapshot",
  "prompt_version": "task-prompt-v1",
  "seed": 1701,
  "repeats": 3,
  "timeout_ms": 600000,
  "tool_inventory": ["read_files", "execute_commands"],
  "adapter": {
    "argv": ["node", "/absolute/client-adapter.cjs", "{workspace}", "{prompt_file}"],
    "files": ["/absolute/client-adapter.cjs"]
  },
  "policy_files": ["cards/candidate.json"],
  "tasks": [
    {
      "task_id": "heldout-001",
      "source_group": "independent-repository-issue-001",
      "task_family": "dependency-conflict",
      "artifact_dir": "fixtures/task-001",
      "evaluator_file": "evaluators/task-001.json",
      "prompt_file": "prompts/task-001.txt",
      "context": {
        "phase": "task_start",
        "signals": {"error_class": "dependency-resolution"},
        "constraints": {"read_only": false}
      }
    }
  ],
  "analysis": {
    "cost_metric": "wall_time_s",
    "alpha": 0.05,
    "noninferiority_margin": 0.05,
    "cost_ratio_target": 0.8,
    "min_tasks": 12,
    "bootstrap_samples": 5000
  }
}
```

tasks 上面仅展开一个条目；登记要求至少两个独立任务。可运行的合成示例由源码项目的 `npm run demo` 生成，它不调用模型、不验证策略收益。

adapter 是用户配置的 CLI 包装程序，需启动全新模型会话，在 `{workspace}` 内工作，读取 `{prompt_file}`，最终退出。argv 是数组，不经过 shell，支持 `{workspace}` / `{prompt_file}` / `{run_id}`。files 列出包装程序及其本地代码依赖。实际客户端启动方式由包装程序处理；第一版没有假称四个客户端具有相同的会话、token 或工具接口。

登记会保存任务提示、卡片、参数、初始目录摘要、评估器摘要和随机排列的全部运行编号。初始产物、发现证据、adapter 和评估器变化后，既有实验拒绝继续执行。运行顺序由 seed 确定，但 seed 不承诺模型可复现。

## 运行

```bash
node scripts/experiment.cjs register --plan /absolute/plan.json --out /absolute/new-experiment
node scripts/experiment.cjs next --manifest /absolute/new-experiment/manifest.json
node scripts/experiment.cjs run --manifest /absolute/new-experiment/manifest.json --run-id REGISTERED_ID
node scripts/experiment.cjs analyze --manifest /absolute/new-experiment/manifest.json --out /absolute/report.json
node scripts/experiment.cjs analyze --manifest /absolute/new-experiment/manifest.json --markdown --out /absolute/report.md
```

使用 next 给出的编号，按登记顺序逐次运行。run 原子占用编号，不允许静默重试；崩溃/丢失的运行留在分母。保留旧实验，需要重试时另行预登记新实验。CLI 单次 run 只运行一个编号，避免无意执行完整收费矩阵。

每次从初始目录复制新工作目录，不复制 `.git` / `node_modules`，拒绝产物符号链接。依赖由固定环境提供，不在两臂之间共享可变项目目录。评估器、代码与证据必须在工作目录外，验证器不能改产物。运行主程序有 timeout，失败、超时和评估失败均不计成功。

**隔离由运行环境保证。** 新目录不等于新客户端记忆；adapter 必须禁用跨运行记忆、恢复会话与结果复用，明确缓存、权限、网络和依赖版本。执行器不提供 OS 沙箱，也无法阻止同一用户权限下的模型读取其他目录。需要对抗性评估时使用容器/独立账号，并由外部评估进程持有验证器与证据。

第一版只在 task_start 根据已经知道的信号注入；过程中决策点可由普通技能手动再次 recommend，实验内动态注入需要后续 adapter hook。不能把最后才出现的错误写成开始时的已知特征。

## 指标与判定

- 主结果：通过独立评估且正常完成的运行数 / 全部预登记运行数。缺失、无效证据仍在分母。
- 成本：执行器从运行开始到准备目录、检索注入、adapter 和评估结束的墙钟秒数。每次成功成本＝所有已分配运行的已知总成本 / 验证成功数；缺成本则不估计，零成功不报告为 0。
- 证据完整性：重新核对 manifest、运行编号、模型、实验臂、评估器摘要、产物目录和原始结果；缺失或重复记录阻止 supported。
- 报告按任务配对结果和两维 Pareto 关系，保留通过率与成本，不合成分数。第一版不测 token、原生工具调用、人工介入或可维护性；这些字段未知时明确写未测，不能宣称相应护栏改善。

估计 Δp＝策略通过率−基线通过率，R＝策略成本/成功÷基线成本/成功。按任务簇重采样，并在任务内按重复编号配对重采样，报告近似 bootstrap 区间。重复次数不是独立任务数。成本比样本零成功时其区间上界可能无界，报告 null 加 upper_unbounded，不丢弃这些样本。

正确性晋升门槛另用保守界：对 n 个独立任务簇的均值差 D∈[-1,1]，半宽 `sqrt(2 * log(2/alpha) / n)`。这避免两臂全通过时 bootstrap 给出虚假的零宽保证，但会使小 pilot 很难晋升；若非劣容忍为 0，有限小样本通常无法证明相等。

supported 要求：数据完整、不是 synthetic、任务数达到预登记下限、正确性保守下界 ≥ −margin，且成本比 bootstrap 上界 ≤ target。它是在固定协议与独立任务采样假设下的支持，不是分布无关的永久保证；成本区间仍是近似方法。opposed 表示在足量完整数据下，正确性上界低于容忍或成本比下界 >1；其他情况为 inconclusive。pilot_signal 只表示点估计达到目标，不能用来激活卡片。

第一版按整体单任务族结论操作，不自动推断每个子问题、其他模型或客户端同样有效。人工介入未被测量，不能把 supported 解读为已经验证了所有产品维度。

停止规则：固定预算后做一次主要分析；评估基础设施失效或严重回归时可停止，保留已有与缺失运行。提前查看、修改策略、调门槛或选择有利任务会破坏确认性解释；此时将结果标为探索性，另换留出集。工具不对称可以比较完整系统，但不能据此声称纯模型或纯策略因果差异。
