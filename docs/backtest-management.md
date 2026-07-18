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

The currently deployed 15-minute strategy is evaluated separately every six hours over the latest
72 hours because it uses a different market type and execution horizon. It applies the production
allocation rules (5% per position, at most three concurrent positions), treats skipped windows as a
zero return, and compares the strategy with a simultaneously simulated Polymarket-direction control.
Correlated assets that close in the same 15-minute interval are combined into one statistical sample.
Its immutable artifacts are stored under:

```text
~/.polymarket-watch/artifacts/short-term-backtests/<generated-at>/
  report.json
  metrics.csv
  observations.csv
```

Each report contains the run ID, deployed code revision, script SHA-256, model specification SHA-256,
dataset SHA-256, and the SHA-256 of `observations.csv`. `observations.csv` is the market-level audit table used to calculate the summary;
it records the official result, Polymarket probability, Hyperliquid trend, selection decision, side,
and after-cost return for every candidate. `latest.json`, `latest-observations.csv`, and a 24-run
`history.json` are maintained in the parent directory for quick inspection. The report also records a
complete replay environment, including `SHORT_TERM_HISTORY_END_AT`, so the same historical window can
be fetched and recalculated instead of silently moving to the latest window.

The dashboard reads the latest report and up to 24 historical summaries. Aggregated Polymarket price
history and Hyperliquid candles are suitable for screening only; authorization still requires the
prospective five-second order-book and official-settlement audit.

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

The validation structure follows an expanding time-series split rather than shuffled cross-validation;
see the official [TimeSeriesSplit documentation](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html).
Hyperliquid fee assumptions use the base perpetual rates in the official
[fee schedule](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees). Polymarket is read as a
signal in this strategy, so no Polymarket execution fee is charged; a future strategy that trades on
Polymarket must query each market's dynamic fee parameters described in the official
[Polymarket fee documentation](https://docs.polymarket.com/trading/fees).

## Optional local MLflow UI

MLflow is deliberately optional; the dashboard and artifacts continue to work without it.

```sh
python3 -m venv ~/.polymarket-watch/mlflow-venv
~/.polymarket-watch/mlflow-venv/bin/pip install -r requirements-mlflow.txt
export MLFLOW_TRACKING_URI="sqlite:///$HOME/.polymarket-watch/mlflow.db"
~/.polymarket-watch/mlflow-venv/bin/python scripts/import-model-evaluations-mlflow.py
~/.polymarket-watch/mlflow-venv/bin/mlflow server --host 127.0.0.1 --port 8080 --backend-store-uri "$MLFLOW_TRACKING_URI"
```

The importer loads both the canonical 6/12/24/48-hour runs and the 15-minute strategy runs into
separate MLflow experiments. MLflow is used for parameter comparison and artifact browsing; the
dashboard remains the executive status view. This matches MLflow's official
[experiment tracking model](https://mlflow.org/docs/latest/ml/tracking/) of runs, parameters, metrics,
code versions, and artifacts.

Use a protected remote MLflow Tracking Server instead of exposing this local port directly when the run
comparison UI must be shared with a remote manager.
