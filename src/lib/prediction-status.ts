import type { PredictionAvailability } from "./domain";
import type { FundPrediction, PredictionEvaluation } from "./prediction-contract";
import { isMainlandTradingDay } from "./trading-calendar";

export function predictionAvailability(
  date: string,
  prediction: FundPrediction | null,
  failure?: string
): PredictionAvailability {
  if (prediction) {
    return {
      status: "available",
      date,
      reason: `${date} 上午预测已生成。`
    };
  }
  if (!isMainlandTradingDay(date)) {
    return {
      status: "non-trading",
      date,
      reason: `${date} 为休市/非交易日，未生成上午预测。`
    };
  }
  if (failure) {
    return {
      status: "source-error",
      date,
      reason: `${date} 上午真实数据源失败，未生成预测：${failure}`
    };
  }
  return {
    status: "not-run",
    date,
    reason: `${date} 上午预测尚未成功运行。`
  };
}

export function evaluationDisplayState(
  prediction: FundPrediction | null,
  evaluation: PredictionEvaluation | null
): { status: "unavailable" | PredictionEvaluation["status"]; reason: string } {
  if (!prediction) {
    return {
      status: "unavailable",
      reason: "暂无预测可评估。"
    };
  }
  if (!evaluation) {
    return {
      status: "pending",
      reason: `预测已生成，等待目标交易日 ${prediction.targetTradeDate} 的实际净值。`
    };
  }
  return {
    status: evaluation.status,
    reason:
      evaluation.reason ??
      "实际基金 NAV 日涨跌，与持仓标的行情和模型预测严格区分。"
  };
}
