# better-solution

根据 work-log 等工作记录，对比不同大模型在处理相似问题时使用的策略、成本和经验，从而做出更好的决策。

一个 Agent Skill。它读取本地积累的工程记录，找出不同模型在同一类任务上用了什么策略、成本多少、结果如何，再按当前任务的特征推荐一条匹配的策略。需要验证时，它登记对照实验，在留出任务上比较 baseline 和 strategy。

一条策略由可观测的触发条件和具体动作组成。没有通过实验的策略保持 experimental 状态，不参与自动采用。

## 解决什么问题

Agent 会重复尝试同一个修法，重走已经否掉的方案，或者在没验证的情况下报告完成。

手上同时有 Claude、Codex、DeepSeek、GLM 的记录时，问题更具体：同一个任务，哪个模型的做法成本更低，一次做对的比例更高。

日志记录发生了什么，不回答哪种做法更好。这个 skill 把日志整理成可检验的策略，再用实验筛掉无效的。

## 跨模型对比

work-log 要求每个模型写自己的日志文件，不往其他模型的文件里追加。这个约束是跨模型比较的基础：

- 同一个 `task_family` 下，不同 `model` 的记录自然分组，可以直接比较工具调用次数、失败次数和验证轮数。
- 实验固定一个模型、一个客户端、一个任务族和一个策略，结论的适用范围明确。
- 结果允许 `inconclusive`。某个策略只在 A 模型上验证过，在 B 模型上就是未验证。

第一版不做跨模型自动扩散。策略在某个模型上通过验证后，应用范围仍限于该模型。

## 使用

### 一、按已有策略执行

查项目里的策略库，默认路径 `.better-solution/cards/`。用任务的可观测特征拼出 context JSON，最多返回一张匹配的 active 策略。

```bash
node scripts/policy.cjs recommend --cards /abs/cards \
  --context /abs/context.json --prompt
```

没有库或没有匹配项时，按任务本身的要求执行。context 记录动手之前能观察到的特征，不包含运行结果。

### 二、从证据提出候选

```bash
node scripts/policy.cjs evidence --logs /abs/worklogs
```

命令导出已记录的工具事件。据此提出一条可证伪的干预，并绑定真实的 `run_id` / `step_id`。解释部分标为推断，替代动作标为假设。

新卡片的初始状态是 `experimental`，不参与自动注入。

### 三、在留出任务上验证

```bash
node scripts/experiment.cjs register --plan /abs/plan.json --out /abs/new-experiment
node scripts/experiment.cjs next     --manifest /abs/new-experiment/manifest.json
node scripts/experiment.cjs run      --manifest /abs/new-experiment/manifest.json --run-id REGISTERED_ID
node scripts/experiment.cjs analyze  --manifest /abs/new-experiment/manifest.json
```

一个实验固定一个模型、一个客户端、一个任务族和一个策略。baseline 和 strategy 使用同一个评估器、同一份预算，在产生候选时未使用的任务上比较。

结论有三种：`supported`、`opposed`、`inconclusive`。小样本全部通过不构成正确性保证。报告包含效应量、区间、逐任务结果和未测指标，不设合成总分。

`policy.cjs promote` 会重新校验实验。合成演示、证据缺失或范围不符时，策略不会被激活。

## 依赖

- Node.js 20+
- [work-log](https://github.com/jeremylinnnnn/work-log) v4，提供证据库

不需要网络服务、向量库或微调。

## 安装

```bash
git clone https://github.com/jeremylinnnnn/better-solution.git \
  ~/.workbuddy-ai/skills/better-solution
```

Claude Code 的安装路径是 `~/.claude/skills/better-solution`。两边使用相同的 skill 格式，由 `SKILL.md` 和 YAML frontmatter 组成。

## 目录结构

```
SKILL.md                  入口与决策规则
references/policies.md    卡片格式与匹配条件
references/experiment.md  实验协议
scripts/policy.cjs        recommend / evidence / promote
scripts/experiment.cjs    register / next / run / analyze
scripts/lib.cjs           公共函数
agents/openai.yaml        Agent 元数据
```

## 许可

MIT，见 [LICENSE](LICENSE)。
