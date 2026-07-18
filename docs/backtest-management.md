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
- [DVC](https://dvc.org/doc) only when dataset snapshots become too large or numerous for the current hash
  plus artifact model.
- [W&B](https://docs.wandb.ai/models/track) is a reasonable hosted alternative when remote researchers need a shared experiment UI, but it is
  not the current system of record because local MLflow avoids sending trading data to another SaaS.
- [Feast](https://docs.feast.dev/getting-started/concepts/point-in-time-joins) is not needed while decisions are calculated directly from synchronized tick tables. Introduce a
  feature store only when multiple training and serving pipelines need the same point-in-time-correct features.

Do not tune on the final test period. New parameters must be declared before the next forward window,
selected only on development folds, and evaluated on a new untouched period. A positive dashboard tile
is not evidence of an edge until the independent-event count, benchmark, uncertainty, drawdown, and selection-bias
gates all pass.

Direction accuracy alone is not a promotion metric. A forecast can be correct often and still lose after
entry price, spread, taker fees, slippage, and funding. Retain Brier score or another proper scoring rule as
a probability-quality diagnostic and compare it with the market probability on the same untouched windows.
Promotion remains based on executable after-cost return, synchronized baselines, confidence intervals, and
forward-only evidence.

The 48-hour synchronized-data gate measures the uninterrupted streak after the most recent capture gap
longer than five minutes. Earlier records remain available for research, but they do not count toward
operational continuity after a gap.

The 15-minute settlement audit selects the first Chainlink report timestamped at or after each market
boundary. A value immediately before the boundary is never substituted, even when it is equally close in
wall-clock time. This keeps settlement causal and prevents near-flat markets from being assigned the wrong
direction.

The public dashboard endpoint uses stale-while-revalidate caching: the most recent complete snapshot is
returned immediately while a refresh runs in the background. Its original `generatedAt` remains unchanged,
so stale data stays detectable. On macOS, `com.polymarket-watch.watchdog` checks the runtime and dashboard
timestamp every minute. It restarts the runtime only after three consecutive failures and then applies a
ten-minute cooldown; a single host CPU spike does not trigger a restart. Watchdog state is stored at
`~/.polymarket-watch/runtime-watchdog.json`.

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

The importer loads the canonical 6/12/24/48-hour runs, the historical 15-minute strategy runs, the
synchronized 5-second executable-book replays, and every changed production forward-audit result into
separate MLflow experiments. MLflow is used for parameter comparison and artifact browsing; the dashboard
remains the executive status view. This matches MLflow's official
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
reproducible row-level analysis. The 5-second replay already writes immutable JSON, candidate-trade CSV,
and complete-opportunity CSV artifacts;
Parquet becomes worthwhile when repeated CSV scans or the SQLite runtime database become the bottleneck.

The synchronized 5-second replay compares every candidate with the same execution timestamps and the
same 5% capital budget against six fixed baselines: Polymarket-only, Hyperliquid-only, always long,
always short, the median of 200 seeded-random direction trials, and a zero-return cash baseline. Candidate selection uses calibration
excess return rather than raw profit. On those same official outcomes and selected trades, it also scores
the candidate probability and the contemporaneous Polymarket probability with Brier score and log loss.

The prospective exact-execution audit also includes cash as a zero-return baseline. Its benchmark
universe is the union of frozen-model and control opportunities: a skipped model opportunity contributes
zero model return, while control, fixed-direction, and random baselines continue to trade. Strategy sample
progress still counts only independently settled model positions, so an inactive model cannot satisfy the
50-window promotion gate.
The dashboard reports Brier skill as `(market error - model error) / market error`; positive is better.
Its 95% interval is calculated from per-window averages so simultaneous assets cannot inflate confidence.
A market-direction candidate correctly reports zero probability improvement because it copies the market
probability; direction accuracy is not presented as independent model skill. A replay can only become
exploratory-promising when its Brier-improvement 95% lower bound is above zero and its holdout
return and excess return are positive, the 95% lower bound of excess return is positive, the deflated
Sharpe probability is at least 95%, and at least three of four walk-forward folds beat the best simple
baseline. Even then, it must start a new frozen forward cohort and cannot modify the active 50-window run.
Each walk-forward fold expands the calibration window, reselects one of the twelve fixed candidates using
only earlier windows, and evaluates that selection on the next non-overlapping block. The earlier
per-candidate four-block output remains a stability diagnostic and is not used for the promotion gate.
The rolling chronological 40% diagnostic must also contain at least five independent long windows and
five independent short windows. Its split boundary moves as new observations arrive, so it is not an
untouched promotion holdout. A profitable result from only one market direction remains `insufficient`,
because it has not demonstrated robustness across rising and falling regimes. Passing this diagnostic
still requires a new frozen 50-window forward cohort before promotion.

Each entry offset has its own complete set of replayable 15-minute windows. A candidate that emits no
signal in one of those windows receives a zero return for that window; the window does not disappear from
the confidence interval or walk-forward denominator. All fixed baselines continue trading on the complete
opportunity set for that entry offset, so a no-trade candidate cannot obtain a zero-return benchmark. The Polymarket-only baseline independently follows
the contemporaneous Polymarket probability direction, while the Hyperliquid-only baseline independently
follows the pre-entry Hyperliquid trend. Neither baseline reuses the candidate model's chosen direction.
This prevents sparse candidates or a mislabeled same-direction control from making calibration excess
return look better than it is.

The exploratory candidate set also contains a fixed logarithmic probability pool. It combines the
contemporaneous Polymarket probability and the executable-time digital fair probability at a predeclared
50:50 log-odds weight, then trades only when the pooled probability exceeds the executable CLOB ask plus
the taker fee by at least three percentage points. The weight and edge threshold are not fitted on the
diagnostic holdout. Adding the three entry offsets increases the declared selection-bias trial count from
nine to twelve. This candidate remains diagnostic and cannot modify the active frozen forward cohort.

The production five-second execution audit applies the same directional minimum to the frozen forward
cohort: at least five independent long windows and five independent short windows are required in addition
to 50 total independent windows. Multiple assets with the same direction and 15-minute close count once;
a close window containing both directions contributes once to each side. Before 50 total windows the gate
is pending. At 50 or more, missing either direction fails promotion and real-money execution remains off.

Settlement promotion is scoped to the markets actually opened by the frozen forward cohort. The global
Chainlink boundary audit remains an operational alert and keeps historical gaps visible, but gaps from
before the active cohort cannot permanently fail a later model. Cohort settlement still requires at least
50 complete markets, 95% boundary coverage, zero disagreement with official Polymarket outcomes, and a
maximum Chainlink boundary timing error of 60 seconds. Missing rows are never backfilled or discarded.

Every changed production-audit result is stored immutably under
`~/.polymarket-watch/artifacts/forward-execution-audits/<run-id>/`. The run ID combines the frozen cohort,
independent-window count, and result fingerprint, so a later result cannot overwrite an earlier one and an
unchanged five-minute check does not create a duplicate. `latest.json`, `latest-metrics.csv`, and
`history.json` provide quick access. The live API exposes the latest report, metrics, and history at:

```text
GET /api/forward-execution-audits/latest
GET /api/forward-execution-audits/latest?format=metrics
GET /api/forward-execution-audits/latest?format=history
```

The frozen 6/12/24/48-hour forward experiments also gate on 50 distinct event-and-horizon outcomes, not
raw position count. Their best baseline is selected from Polymarket-only, always long, always short, and
the median of 200 deterministic random-direction trials. Multiple assets recorded for one event contribute
to that event's return together and cannot inflate the sample-progress counter.
