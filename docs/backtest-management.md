# Backtest management

## Source of truth

`ModelEvaluationRun` is the canonical backtest record. The older `BacktestRun` table is a simple
Polymarket probability baseline and must not be used to decide whether the combined strategy has an
edge.

Every canonical run records:

- run ID, model version, code revision, dataset hash, and normalized config hash
- 6/12/24/48 hour predeclared results
- chronological holdout and four expanding walk-forward folds with a holding-period embargo
- spread, slippage, taker fee, and funding costs
- same-period long, short, Polymarket-direction, and randomized benchmarks
- confidence interval and Deflated Sharpe probability adjusted for candidate selection

The worker runs this evaluation every six hours. A completed run writes immutable artifacts under:

```text
~/.polymarket-watch/artifacts/model-evaluations/<run-id>/
  report.json
  metrics.csv
  README.md
```

`latest.json` and `history.csv` are also refreshed in the parent directory. Existing database runs can
be exported again with:

```sh
npm run backtest:export
```

The live API exposes the same data as read-only downloads:

```text
GET /api/model-evaluations?format=csv
GET /api/model-evaluations/<run-id>
GET /api/model-evaluations/<run-id>?format=csv
```

## Recommended tool split

- Polymarket Watch: executive status, latest result, forward collection, and operational health.
- MLflow: experiment search, parameter/metric comparison, run artifacts, and model research history.
- SQLite now; PostgreSQL later: operational state and normalized execution records.
- Parquet plus DuckDB later: immutable raw order-book and trade research datasets at larger scale.
- DVC only when dataset snapshots become too large or numerous for the current hash plus artifact model.

Do not tune on the final test period. New parameters must be declared before the next forward window,
selected only on development folds, and evaluated on a new untouched period. A positive dashboard tile
is not evidence of an edge until the trade-count, benchmark, uncertainty, drawdown, and selection-bias
gates all pass.

## Optional local MLflow UI

MLflow is deliberately optional; the dashboard and artifacts continue to work without it.

```sh
python3 -m venv ~/.polymarket-watch/mlflow-venv
~/.polymarket-watch/mlflow-venv/bin/pip install -r requirements-mlflow.txt
export MLFLOW_TRACKING_URI="sqlite:///$HOME/.polymarket-watch/mlflow.db"
~/.polymarket-watch/mlflow-venv/bin/python scripts/import-model-evaluations-mlflow.py
~/.polymarket-watch/mlflow-venv/bin/mlflow server --host 127.0.0.1 --port 8080 --backend-store-uri "$MLFLOW_TRACKING_URI"
```

Use a protected remote MLflow Tracking Server instead of exposing this local port directly when the run
comparison UI must be shared with a remote manager.
