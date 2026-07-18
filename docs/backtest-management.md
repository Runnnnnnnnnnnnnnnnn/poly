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
Because historical Hyperliquid data is aggregated into one-minute candles, a signal is never filled at
the open of the candle that already contains the Polymarket observation. The simulator enters at the
next complete candle boundary, which keeps the historical fill strictly after the decision timestamp.
Every run records the entry-lag distribution and fails if even one entry is not strictly causal.
Its immutable artifacts are stored under:

```text
~/.polymarket-watch/artifacts/short-term-backtests/<generated-at>/
  report.json
  metrics.csv
  observations.csv
```

Each report contains the run ID, deployed code revision, script SHA-256, model specification SHA-256,
input dataset SHA-256, model-decision SHA-256, and the SHA-256 of `observations.csv`. The input hash is
calculated only from market IDs, timestamps, official outcomes, Polymarket observations, and
Hyperliquid boundary OHLC values; changing a model rule therefore changes the specification and
decision hashes without pretending that the source dataset changed. `observations.csv` is the market-level audit table used to calculate the summary;
it records the official result, Polymarket probability, Hyperliquid trend, selection decision, side,
and after-cost return for every candidate. `latest.json`, `latest-observations.csv`, and a 24-run
`history.json` are maintained in the parent directory for quick inspection. The report also records a
complete replay environment, including `SHORT_TERM_HISTORY_END_AT`, so the same historical window can
be fetched and recalculated instead of silently moving to the latest window.

The dashboard reads the latest report and up to 24 historical summaries. Aggregated Polymarket price
history and Hyperliquid candles are suitable for screening only; authorization still requires the
prospective five-second order-book and official-settlement audit.

The latest 15-minute result can also be downloaded from the live backend:

```text
GET /api/short-term-backtests/latest
GET /api/short-term-backtests/latest?format=metrics
GET /api/short-term-backtests/latest?format=observations
GET /api/short-term-backtests/latest?format=samples
```

The report includes a fixed nine-variant sensitivity check and loss slices by asset, side, probability,
trend strength, and Japan time session. These are diagnostic outputs only and are never used to promote
a model. A changed rule starts a new forward cohort instead of rewriting the current 50-event test.

The live API exposes the same data as read-only downloads:

```text
GET /api/model-evaluations?format=csv
GET /api/model-evaluations/<run-id>
GET /api/model-evaluations/<run-id>?format=csv
```

## Recommended tool split

- Polymarket Watch: executive status, latest result, forward collection, and operational health.
- MLflow: experiment search, parameter/metric comparison, run artifacts, and model research history.
  Keep this as the researcher workspace; the executive dashboard should not expose its complexity.
- SQLite now; PostgreSQL later: operational state and normalized execution records.
- CSV artifacts now; Parquet plus DuckDB when the five-second dataset becomes large enough that SQLite
  extracts are slow. DuckDB can query partitioned Parquet directly without loading it into the app DB.
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

The importer loads the canonical 6/12/24/48-hour runs, the historical 15-minute strategy runs, and
the synchronized 5-second executable-book replays into separate MLflow experiments. MLflow is used for parameter comparison and artifact browsing; the
dashboard remains the executive status view. This matches MLflow's official
[experiment tracking model](https://mlflow.org/docs/latest/ml/tracking/) of runs, parameters, metrics,
code versions, and artifacts.

On macOS, after installing the pinned dependency into the dedicated Python 3.10+ environment, the
local-only tracking server can be kept running and refreshed every 30 minutes with:

```sh
npm run mlflow:service:install
```

The service binds only to `127.0.0.1:8080`, imports new immutable artifacts without duplicating prior
runs, restarts through launchd, and writes health/import state to
`~/.polymarket-watch/mlflow-status.json`. Remove it with `npm run mlflow:service:uninstall`.

Use a protected remote MLflow Tracking Server instead of exposing this local port directly when the run
comparison UI must be shared with a remote manager.

For larger tick datasets, keep the dashboard on compact JSON summaries and write raw immutable ticks
to date/asset-partitioned Parquet. Query those files with DuckDB for research, and register only hashes,
parameters, metrics, and artifact paths in MLflow. This keeps the executive screen fast while preserving
reproducible row-level analysis. The 5-second replay already writes immutable JSON and trade CSV artifacts;
Parquet becomes worthwhile when repeated CSV scans or the SQLite runtime database become the bottleneck.
