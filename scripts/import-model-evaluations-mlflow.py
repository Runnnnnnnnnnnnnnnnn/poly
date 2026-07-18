#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path

import mlflow
from mlflow import MlflowClient


def parse_args():
    parser = argparse.ArgumentParser(description="Import Polymarket backtest reports into MLflow")
    parser.add_argument(
        "--artifact-dir",
        default=os.path.expanduser("~/.polymarket-watch/artifacts/model-evaluations"),
    )
    parser.add_argument("--experiment", default="polymarket-hyperliquid-backtests")
    parser.add_argument("--tracking-uri", default=os.environ.get("MLFLOW_TRACKING_URI", ""))
    return parser.parse_args()


def metric_values(summary):
    result = summary["result"]
    dataset = summary["dataset"]
    validation = summary["validation"]
    candidates = {
        "test_events": dataset["testEvents"],
        "test_markets": dataset["testMarkets"],
        "trades": result["trades"],
        "net_return_pct": result["netReturnPct"],
        "benchmark_return_pct": result["benchmarkReturnPct"],
        "excess_return_pct": result["excessReturnPct"],
        "win_rate": result["winRate"],
        "max_drawdown_pct": result["maxDrawdownPct"],
        "deflated_sharpe_probability": result["deflatedSharpeProbability"],
        "walk_forward_folds": validation["walkForwardFolds"],
        "profitable_validation_folds": validation["profitableValidationFolds"],
        "passed_gates": validation["passedGates"],
        "total_gates": validation["totalGates"],
        "test_execution_coverage": dataset["testExecutionFeatureCoverage"],
        "test_synchronized_coverage": dataset["testSynchronizedExecutionCoverage"],
    }
    return {key: float(value) for key, value in candidates.items() if value is not None}


def main():
    args = parse_args()
    artifact_dir = Path(args.artifact_dir).expanduser().resolve()
    if args.tracking_uri:
        mlflow.set_tracking_uri(args.tracking_uri)
    mlflow.set_experiment(args.experiment)
    experiment = mlflow.get_experiment_by_name(args.experiment)
    if experiment is None:
        raise RuntimeError("MLflow experiment could not be created")

    client = MlflowClient()
    imported = 0
    skipped = 0
    for report_path in sorted(artifact_dir.glob("*/report.json")):
        report = json.loads(report_path.read_text(encoding="utf-8"))
        summary = report["summary"]
        source_run_id = summary["id"]
        existing = client.search_runs(
            [experiment.experiment_id],
            filter_string=f'tags."polymarket.run_id" = "{source_run_id}"',
            max_results=1,
        )
        if existing:
            skipped += 1
            continue

        params = {
            "model_version": summary["modelVersion"],
            "code_revision": summary.get("codeRevision") or "unknown",
            "dataset_hash": summary.get("datasetHash") or "unavailable",
            "config_hash": summary["configHash"],
            "primary_horizon_hours": summary.get("primaryHorizonHours") or "unavailable",
            "selected_strategy": summary.get("selectedStrategy") or "unavailable",
            "result_source": summary["result"]["source"],
        }
        tags = {
            "polymarket.run_id": source_run_id,
            "quality_status": summary["qualityStatus"],
            "source": "polymarket-watch",
        }
        with mlflow.start_run(run_name=source_run_id, tags=tags):
            mlflow.log_params(params)
            mlflow.log_metrics(metric_values(summary))
            mlflow.log_artifacts(str(report_path.parent), artifact_path="backtest-report")
        imported += 1

    print(json.dumps({"imported": imported, "skipped": skipped, "artifactDir": str(artifact_dir)}))


if __name__ == "__main__":
    main()
