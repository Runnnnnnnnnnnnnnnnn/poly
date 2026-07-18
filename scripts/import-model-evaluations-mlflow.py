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
    parser.add_argument(
        "--short-term-artifact-dir",
        default=os.path.expanduser("~/.polymarket-watch/artifacts/short-term-backtests"),
    )
    parser.add_argument("--short-term-experiment", default="polymarket-hyperliquid-15m-backtests")
    parser.add_argument("--tracking-uri", default=os.environ.get("MLFLOW_TRACKING_URI", ""))
    parser.add_argument(
        "--mlflow-artifact-root",
        default=os.environ.get(
            "MLFLOW_ARTIFACT_ROOT",
            os.path.expanduser("~/.polymarket-watch/mlartifacts"),
        ),
    )
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
    experiment = ensure_experiment(
        args.experiment,
        Path(args.mlflow_artifact_root).expanduser().resolve() / "canonical",
    )

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

    short_term = import_short_term_runs(args)
    print(json.dumps({
        "canonical": {"imported": imported, "skipped": skipped, "artifactDir": str(artifact_dir)},
        "shortTerm": short_term,
    }))


def import_short_term_runs(args):
    artifact_dir = Path(args.short_term_artifact_dir).expanduser().resolve()
    experiment = ensure_experiment(
        args.short_term_experiment,
        Path(args.mlflow_artifact_root).expanduser().resolve() / "short-term",
    )
    client = MlflowClient()
    imported = 0
    skipped = 0
    for report_path in sorted(artifact_dir.glob("*/report.json")):
        report = json.loads(report_path.read_text(encoding="utf-8"))
        generated_at = report["generatedAt"]
        existing = client.search_runs(
            [experiment.experiment_id],
            filter_string=f'tags."polymarket.short_term_generated_at" = "{generated_at}"',
            max_results=1,
        )
        if existing:
            skipped += 1
            continue
        methodology = report["methodology"]
        reproducibility = report.get("reproducibility", {})
        params = {
            "market_duration": methodology["marketDuration"],
            "lookback_hours": methodology["period"]["lookbackHours"],
            "execution_mode": methodology["executionMode"],
            "historical_entry_policy": methodology.get("entry", "unavailable"),
            "position_pct": methodology["positionPct"],
            "maximum_concurrent_positions": methodology["maximumConcurrentPositions"],
            "strategy_trials": methodology["impliedRule"]["strategyTrials"],
            "run_id": reproducibility.get("runId"),
            "code_revision": reproducibility.get("codeRevision"),
            "script_sha256": reproducibility.get("scriptSha256"),
            "specification_sha256": reproducibility.get("specificationSha256"),
            "dataset_sha256": reproducibility.get("datasetSha256"),
            "decision_sha256": reproducibility.get("decisionSha256"),
            "observations_csv_sha256": reproducibility.get("observationsCsvSha256"),
            "decision_samples_csv_sha256": reproducibility.get("decisionSamplesCsvSha256"),
        }
        params = {key: value for key, value in params.items() if value is not None}
        metrics = {"complete_markets": float(report["coverage"]["completeMarkets"])}
        for candidate in ("baseline", "implied", "leadLag", "crossSectional"):
            result = report["holdout"][candidate]
            screening = report["screening"][candidate]
            stability = report["walkForward"]["stability"][candidate]
            prefix = candidate.replace("Sectional", "_sectional").replace("Lag", "_lag").lower()
            values = {
                "trades": result["trades"],
                "net_return_pct": result["netReturnPct"],
                "average_return_pct": result["averageReturnPct"],
                "confidence_lower_pct": result["meanConfidenceInterval95"][0] if result["meanConfidenceInterval95"] else None,
                "excess_return_pct": result["excessReturnPct"],
                "max_drawdown_pct": result["maxDrawdownPct"],
                "deflated_sharpe_probability": result["deflatedSharpeProbability"],
                "profitable_folds": stability["profitableFolds"],
                "passed_gates": screening["passedGates"],
            }
            metrics.update({f"{prefix}_{key}": float(value) for key, value in values.items() if value is not None})
        diagnosis = report.get("diagnosis", {})
        baseline_diagnosis = diagnosis.get("baseline", {})
        sensitivity = diagnosis.get("sensitivity", {})
        diagnostic_values = {
            "baseline_binary_outcome_accuracy": baseline_diagnosis.get("binaryOutcomeAccuracy"),
            "baseline_after_cost_win_rate": baseline_diagnosis.get("afterCostWinRate"),
            "baseline_estimated_before_cost_win_rate": baseline_diagnosis.get("estimatedBeforeCostWinRate"),
            "baseline_estimated_before_cost_average_return_pct": baseline_diagnosis.get("estimatedBeforeCostAverageReturnPct"),
            "assumed_round_trip_cost_pct": baseline_diagnosis.get("assumedRoundTripCostPct"),
            "sensitivity_tested_variants": sensitivity.get("testedVariants"),
            "sensitivity_calibration_positive_variants": sensitivity.get("calibrationPositiveVariants"),
            "sensitivity_holdout_positive_variants": sensitivity.get("holdoutPositiveVariants"),
        }
        metrics.update({key: float(value) for key, value in diagnostic_values.items() if value is not None})
        with mlflow.start_run(
            run_name=f"15m-{generated_at}",
            tags={
                "polymarket.short_term_generated_at": generated_at,
                "polymarket.short_term_run_id": reproducibility.get("runId", generated_at),
                "polymarket.dataset_sha256": reproducibility.get("datasetSha256", "unavailable"),
                "quality_status": report["screening"]["baseline"]["status"],
                "source": "polymarket-watch-15m",
            },
        ):
            mlflow.log_params(params)
            mlflow.log_metrics(metrics)
            mlflow.log_artifacts(str(report_path.parent), artifact_path="short-term-backtest-report")
        imported += 1
    return {"imported": imported, "skipped": skipped, "artifactDir": str(artifact_dir)}


def ensure_experiment(name, artifact_location):
    artifact_location.mkdir(parents=True, exist_ok=True)
    expected = artifact_location.as_uri().rstrip("/")
    client = MlflowClient()
    experiment = client.get_experiment_by_name(name)
    if experiment is None:
        experiment_id = client.create_experiment(name, artifact_location=expected)
        experiment = client.get_experiment(experiment_id)
    if experiment.artifact_location.rstrip("/") != expected:
        raise RuntimeError(
            f"MLflow experiment {name} uses unexpected artifact location: "
            f"{experiment.artifact_location}; expected {expected}"
        )
    mlflow.set_experiment(experiment_id=experiment.experiment_id)
    return experiment


if __name__ == "__main__":
    main()
