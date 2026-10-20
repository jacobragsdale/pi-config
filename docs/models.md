# Copilot models and what they cost

Copilot bills pi's requests per token, in AI credits (1 credit = $0.01). This page explains the team defaults and compares what a task costs on each model.

## Team defaults

| Setting                    | Value                                  | Why                                                                                                          |
| -------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Model                      | `github-copilot/gpt-6.1-sol`           | Team choice for everyday work.                                                                               |
| Thinking                   | `high` for GPT-6.1 Sol                 | Set per model in `modelThinkingLevels`, so switching to a cheaper model doesn't carry high thinking with it. |
| Context window             | Capped at each model's price threshold | See below.                                                                                                   |
| `compaction.reserveTokens` | `32768`                                | Starts compaction early enough that one large tool result can't push a request over the threshold.           |

Switch models for one session with `/model`. Thinking tokens bill as output, so `high` costs more per task than the figures below on tasks where the model thinks a lot.

## Why the context windows are capped

Several models charge about double for a request whose input goes over a threshold: 272K tokens for GPT-6.x and GPT-5.6 Sol and Terra, 200K for GPT-5.6 Luna and Grok, and 100K for Claude Haiku 5.5. Pi's catalog gives these models windows of up to 1.05M tokens, so without a cap pi lets a long session grow past the threshold before it compacts, and every request after that pays the higher rate.

`agent/models.json` sets each tiered model's `contextWindow` to its threshold. Pi compacts at the window minus `reserveTokens`, about 239K for GPT-6.1 Sol, so requests stay at the standard rate. On an hour-long GPT-6.1 Sol task that is the difference between about $9.40 and $16.80.

Compaction summarizes older turns, and a summary can drop details of a long task's progress. If a long task loses track after a compaction, say what is left to do.

## Cost per task

Two task sizes, priced from GitHub's published rates:

- **Small task:** about 90K cached input tokens, 18K new input tokens and 4K output tokens. This is the measured profile of a typical small pi task.
- **Hour-long task:** the same mix at 100 times the size. On GPT-6.1 Sol this prices at $9.40, close to the ~$10 that such tasks cost in practice.

New input is billed at the cache-write rate on models that charge one, and at the input rate otherwise. "Above the threshold" prices the hour-long task as if every request ran at the long-context rate, which is what an uncapped window drifts toward.

| Model                | Small task | Hour-long task | Hour-long, above the threshold | Threshold |
| -------------------- | ---------: | -------------: | -----------------------------: | --------: |
| `gpt-6-luna`         |     $0.005 |          $0.52 |                          $0.93 |      272K |
| `claude-haiku-5.5`   |     $0.005 |          $0.52 |                          $2.58 |      100K |
| `mai-code-1.1-flash` |     $0.010 |          $1.02 |                              — |         — |
| `gpt-5.4-nano`       |     $0.010 |          $1.04 |                              — |         — |
| `gpt-5.6-luna`       |     $0.011 |          $1.11 |                          $1.98 |      200K |
| `gemini-3.8-flash`   |     $0.035 |          $3.52 |                              — |         — |
| `claude-haiku-4.5`   |     $0.051 |          $5.15 |                              — |         — |
| `gemini-4-argon`     |     $0.085 |          $8.50 |                              — |         — |
| `gpt-6.1-sol`        |     $0.094 |          $9.40 |                         $16.80 |      272K |
| `claude-sonnet-5.5`  |     $0.094 |          $9.40 |                              — |         — |
| `gpt-6-sol`          |      $0.10 |         $10.30 |                         $18.60 |      272K |
| `claude-sonnet-5`    |      $0.10 |         $10.30 |                              — |         — |
| `gpt-5.3-codex`      |      $0.10 |         $10.32 |                              — |         — |
| `grok-4.5`           |      $0.10 |         $10.50 |                         $21.00 |      200K |
| `grok-4.6`           |      $0.10 |         $10.50 |                         $21.00 |      200K |
| `grok-4.7`           |      $0.10 |         $10.50 |                         $21.00 |      200K |
| `gpt-5.6-terra`      |      $0.11 |         $11.10 |                         $19.80 |      272K |
| `kimi-k3`            |      $0.14 |         $14.10 |                              — |         — |
| `claude-sonnet-4`    |      $0.15 |         $15.45 |                              — |         — |
| `claude-sonnet-4.6`  |      $0.15 |         $15.45 |                              — |         — |
| `claude-opus-5.5`    |      $0.19 |         $18.80 |                              — |         — |
| `gpt-5.6-sol`        |      $0.21 |         $20.60 |                         $37.20 |      272K |
| `claude-opus-4.8`    |      $0.26 |         $25.75 |                              — |         — |
| `claude-opus-5`      |      $0.26 |         $25.75 |                              — |         — |
| `claude-fable-5.1`   |      $0.45 |         $44.75 |                              — |         — |
| `gpt-6-astra`        |      $0.52 |         $51.50 |                         $93.00 |      272K |
| `claude-fable-5`     |      $0.52 |         $51.50 |                              — |         — |

These are estimates: real tasks vary in their mix of input and output, and Copilot's bill is the final word.

## Keeping prices current

`data/copilot-prices.json` is a copy of [GitHub's pricing page](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing), with the date it was checked. Pi's catalog carries its own copy of the prices, which is what pi uses to show costs.

After a pi upgrade, or when GitHub changes prices, run:

```bash
npm run check-prices
```

It exits non-zero when pi's prices differ from `data/copilot-prices.json`, or when a tiered model has no context cap. To fix a wrong price in pi, add a `cost` override for the model in `agent/models.json`. To pick up a GitHub price change, update `data/copilot-prices.json` from the page, then regenerate the table above with `npm run price-table`.
