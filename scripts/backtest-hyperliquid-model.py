#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
import os
import tempfile
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import psycopg
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


ASSETS = ("BTC", "ETH", "SOL", "XRP")
HORIZONS = (15, 60, 300, 900)
TAKER_FEE_PER_SIDE = 0.00045


def parse_args():
    parser = argparse.ArgumentParser(description="Causal Hyperliquid microstructure model backtest")
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--now")
    return parser.parse_args()


def main():
    args = parse_args()
    now = parse_time(args.now) if args.now else datetime.now(timezone.utc)
    database_url = args.database_url.split("?schema=", 1)[0]
    with psycopg.connect(database_url, autocommit=True) as connection:
        connection.execute("SET TIME ZONE 'UTC'")
        ticks = load_ticks(connection)
        l2 = load_l2(connection)
        trades = load_trades(connection)
        wallet_signals = load_wallet_signals(connection)

    l2_summary = summarize_l2(l2, now)
    horizon_reports = []
    for horizon in HORIZONS:
        dataset = build_dataset(ticks, l2, trades, wallet_signals, horizon)
        horizon_reports.append(evaluate_horizon(dataset, horizon, l2_summary))

    selected = max(
        horizon_reports,
        key=lambda report: (
            report["edgeConfirmed"],
            report["holdout"]["independentWindows"],
            report["holdout"]["excessReturnPct"],
        ),
    )
    edge_confirmed = any(report["edgeConfirmed"] for report in horizon_reports)
    status = "promising" if edge_confirmed else (
        "collecting" if not l2_summary["ready"] else "rejected"
    )
    report = {
        "schemaVersion": 1,
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "modelVersion": "hyperliquid-microstructure-v1",
        "status": status,
        "edgeConfirmed": edge_confirmed,
        "verdict": "優位性あり" if edge_confirmed else "優位性未確認",
        "reason": (
            "全ての前向き合格条件を満たしました"
            if edge_confirmed
            else "L2板と約定の前向き履歴を72時間以上収集中です"
            if not l2_summary["ready"]
            else "ホールドアウトで市場基準と統計基準を満たしていません"
        ),
        "data": {
            "l1Rows": sum(len(rows) for rows in ticks.values()),
            "l2Rows": sum(len(rows) for rows in l2.values()),
            "tradeRows": sum(len(rows) for rows in trades.values()),
            "walletSignals": len(wallet_signals),
            "l2Coverage": l2_summary["coverage"],
            "l2DurationHours": l2_summary["durationHours"],
            "mode": "L2_AND_TRADES" if l2_summary["ready"] else "L1_BASELINE",
        },
        "selectedHorizonSeconds": selected["horizonSeconds"],
        "selected": selected,
        "horizons": horizon_reports,
        "nautilusValidation": {
            "status": "not_run_no_qualified_candidate" if not edge_confirmed else "required",
            "reason": "合格候補だけを独立約定エンジンで再検証します",
        },
        "methodology": {
            "split": "chronological 60% train / 20% validation / 20% untouched holdout",
            "purge": "labels crossing a split boundary are removed",
            "independence": "samples are spaced by the forecast horizon",
            "selection": "model and threshold selected on validation only",
            "costs": "executable bid/ask plus 0.045% taker fee per side and funding",
            "models": ["regularized-logistic", "hist-gradient-boosting"],
        },
    }
    atomic_json(Path(args.output).expanduser().resolve(), report)
    print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))


def load_ticks(connection):
    rows = connection.execute(
        'SELECT "asset", "capturedAt", "hyperliquidBestBid", "hyperliquidBestAsk", '
        '"hyperliquidBidSize", "hyperliquidAskSize", "hyperliquidFundingRate" '
        'FROM "RealtimeAssetTick" WHERE "asset" = ANY(%s) ORDER BY "asset", "capturedAt"',
        (list(ASSETS),),
    ).fetchall()
    grouped = defaultdict(list)
    for asset, captured_at, bid, ask, bid_size, ask_size, funding in rows:
        grouped[asset].append({
            "time": utc(captured_at),
            "bid": float(bid),
            "ask": float(ask),
            "bidSize": float(bid_size or 0),
            "askSize": float(ask_size or 0),
            "funding": float(funding or 0),
        })
    return grouped


def load_l2(connection):
    rows = connection.execute(
        'SELECT "asset", "capturedAt", "imbalance5", "imbalance10", "microprice", '
        '"bidDepth5", "askDepth5", "bidDepth10", "askDepth10" '
        'FROM "HyperliquidL2Snapshot" WHERE "asset" = ANY(%s) ORDER BY "asset", "capturedAt"',
        (list(ASSETS),),
    ).fetchall()
    grouped = defaultdict(list)
    for row in rows:
        grouped[row[0]].append({
            "time": utc(row[1]),
            "imbalance5": float(row[2]),
            "imbalance10": float(row[3]),
            "microprice": float(row[4]),
            "bidDepth5": float(row[5]),
            "askDepth5": float(row[6]),
            "bidDepth10": float(row[7]),
            "askDepth10": float(row[8]),
        })
    return grouped


def load_trades(connection):
    rows = connection.execute(
        'SELECT "asset", "tradedAt", "side", "notional" FROM "HyperliquidTradeTick" '
        'WHERE "asset" = ANY(%s) ORDER BY "asset", "tradedAt"',
        (list(ASSETS),),
    ).fetchall()
    grouped = defaultdict(list)
    for asset, traded_at, side, notional in rows:
        grouped[asset].append({
            "time": utc(traded_at),
            "signedNotional": float(notional) * (1 if side == "BUY" else -1),
            "notional": float(notional),
        })
    return grouped


def load_wallet_signals(connection):
    rows = connection.execute(
        'SELECT "observedAt", "direction", "consensusScore" FROM "WalletSignal" '
        'WHERE "category" = \'CRYPTO\' ORDER BY "observedAt"'
    ).fetchall()
    return [
        {
            "time": utc(observed_at),
            "value": float(score) / 100 * (1 if direction == "YES" else -1),
        }
        for observed_at, direction, score in rows
    ]


def build_dataset(ticks, l2, trades, wallet_signals, horizon_seconds):
    samples = []
    for asset_index, asset in enumerate(ASSETS):
        rows = ticks.get(asset, [])
        if len(rows) < 50:
            continue
        times = np.array([row["time"].timestamp() for row in rows])
        mids = np.array([(row["bid"] + row["ask"]) / 2 for row in rows])
        log_mids = np.log(mids)
        l2_rows = l2.get(asset, [])
        trade_rows = trades.get(asset, [])
        l2_cursor = 0
        latest_l2 = None
        trade_cursor = 0
        trade_window = deque()
        wallet_cursor = 0
        latest_wallet = None
        stride = max(1, round(horizon_seconds / 5))
        for index in range(12, len(rows) - 1, stride):
            row = rows[index]
            current_time = row["time"]
            target_time = current_time.timestamp() + horizon_seconds
            target_index = int(np.searchsorted(times, target_time, side="left"))
            if target_index >= len(rows) or times[target_index] - target_time > 15:
                continue
            while l2_cursor < len(l2_rows) and l2_rows[l2_cursor]["time"] <= current_time:
                latest_l2 = l2_rows[l2_cursor]
                l2_cursor += 1
            while trade_cursor < len(trade_rows) and trade_rows[trade_cursor]["time"] <= current_time:
                trade_window.append(trade_rows[trade_cursor])
                trade_cursor += 1
            while trade_window and current_time - trade_window[0]["time"] > timedelta(seconds=30):
                trade_window.popleft()
            while wallet_cursor < len(wallet_signals) and wallet_signals[wallet_cursor]["time"] <= current_time:
                latest_wallet = wallet_signals[wallet_cursor]
                wallet_cursor += 1
            wallet_value = (
                latest_wallet["value"]
                if latest_wallet and current_time - latest_wallet["time"] <= timedelta(minutes=5)
                else 0
            )
            bid_size = row["bidSize"]
            ask_size = row["askSize"]
            size_total = bid_size + ask_size
            imbalance1 = (bid_size - ask_size) / size_total if size_total > 0 else 0
            microprice = (
                (row["ask"] * bid_size + row["bid"] * ask_size) / size_total
                if size_total > 0
                else mids[index]
            )
            signed_trade = sum(item["signedNotional"] for item in trade_window)
            trade_total = sum(item["notional"] for item in trade_window)
            trade_imbalance = signed_trade / trade_total if trade_total > 0 else 0
            fresh_l2 = latest_l2 if latest_l2 and current_time - latest_l2["time"] <= timedelta(seconds=10) else None
            asset_one_hot = [1.0 if position == asset_index else 0.0 for position in range(len(ASSETS))]
            features = [
                (row["ask"] - row["bid"]) / mids[index] * 10_000,
                imbalance1,
                (microprice - mids[index]) / mids[index] * 10_000,
                log_mids[index] - log_mids[index - 1],
                log_mids[index] - log_mids[index - 6],
                log_mids[index] - log_mids[index - 12],
                float(np.std(np.diff(log_mids[index - 12:index + 1]))),
                row["funding"],
                fresh_l2["imbalance5"] if fresh_l2 else 0,
                fresh_l2["imbalance10"] if fresh_l2 else 0,
                ((fresh_l2["microprice"] - mids[index]) / mids[index] * 10_000) if fresh_l2 else 0,
                trade_imbalance,
                wallet_value,
                1.0 if fresh_l2 else 0.0,
                *asset_one_hot,
            ]
            future = rows[target_index]
            long_return = future["bid"] / row["ask"] - 1 - 2 * TAKER_FEE_PER_SIDE - row["funding"] * horizon_seconds / 3600
            short_return = row["bid"] / future["ask"] - 1 - 2 * TAKER_FEE_PER_SIDE + row["funding"] * horizon_seconds / 3600
            samples.append({
                "asset": asset,
                "time": current_time,
                "targetTime": future["time"],
                "features": features,
                "target": 1 if future["bid"] > row["ask"] else 0,
                "longReturn": long_return,
                "shortReturn": short_return,
                "hasL2": fresh_l2 is not None,
            })
    return sorted(samples, key=lambda sample: (sample["time"], sample["asset"]))


def evaluate_horizon(samples, horizon_seconds, l2_summary):
    empty = empty_horizon(horizon_seconds)
    if len(samples) < 300:
        return empty
    times = np.array([sample["time"].timestamp() for sample in samples])
    train_boundary = float(np.quantile(times, 0.60))
    validation_boundary = float(np.quantile(times, 0.80))
    train = [sample for sample in samples if sample["targetTime"].timestamp() < train_boundary]
    validation = [
        sample for sample in samples
        if sample["time"].timestamp() >= train_boundary
        and sample["targetTime"].timestamp() < validation_boundary
    ]
    holdout = [sample for sample in samples if sample["time"].timestamp() >= validation_boundary]
    if min(len(train), len(validation), len(holdout)) < 50:
        return empty

    candidates = []
    for model_name, model in model_candidates():
        x_train = np.asarray([sample["features"] for sample in train], dtype=float)
        y_train = np.asarray([sample["target"] for sample in train], dtype=int)
        if len(np.unique(y_train)) < 2:
            continue
        model.fit(x_train, y_train)
        validation_probability = model.predict_proba(np.asarray([sample["features"] for sample in validation]))[:, 1]
        for threshold in (0.55, 0.60, 0.65):
            metrics = trading_metrics(validation, validation_probability, threshold)
            candidates.append({
                "model": model_name,
                "modelObject": model,
                "threshold": threshold,
                "validation": metrics,
            })
    if not candidates:
        return empty
    selected = max(
        candidates,
        key=lambda candidate: (
            candidate["validation"]["independentWindows"] >= 50,
            candidate["validation"]["excessReturnPct"],
            candidate["validation"]["netReturnPct"],
        ),
    )
    holdout_probability = selected["modelObject"].predict_proba(
        np.asarray([sample["features"] for sample in holdout])
    )[:, 1]
    holdout_metrics = trading_metrics(holdout, holdout_probability, selected["threshold"])
    gates = [
        gate("windows", "独立窓200件", holdout_metrics["independentWindows"] >= 200, holdout_metrics["independentWindows"], 200),
        gate("both-sides", "ロング・ショート各20件", min(holdout_metrics["longTrades"], holdout_metrics["shortTrades"]) >= 20, min(holdout_metrics["longTrades"], holdout_metrics["shortTrades"]), 20),
        gate("profit", "手数料後プラス", holdout_metrics["netReturnPct"] > 0, holdout_metrics["netReturnPct"], 0),
        gate("benchmark", "最良基準を上回る", holdout_metrics["excessReturnPct"] > 0, holdout_metrics["excessReturnPct"], 0),
        gate("significance", "超過収益95%下限がプラス", (holdout_metrics["excessConfidenceInterval95"] or [-1])[0] > 0, (holdout_metrics["excessConfidenceInterval95"] or [None])[0], 0),
        gate("selection-bias", "選択バイアス補正95%以上", (holdout_metrics["deflatedSharpeProbability"] or 0) >= 0.95, holdout_metrics["deflatedSharpeProbability"], 0.95),
        gate("drawdown", "最大下落5%以内", holdout_metrics["maxDrawdownPct"] <= 0.05, holdout_metrics["maxDrawdownPct"], 0.05),
        gate("l2-history", "L2板72時間・80%網羅", l2_summary["ready"], l2_summary["coverage"], 0.8),
    ]
    edge_confirmed = all(item["passed"] for item in gates)
    return {
        "horizonSeconds": horizon_seconds,
        "status": "promising" if edge_confirmed else "collecting" if not l2_summary["ready"] else "rejected",
        "edgeConfirmed": edge_confirmed,
        "selectedModel": selected["model"],
        "selectedThreshold": selected["threshold"],
        "dataset": {
            "samples": len(samples),
            "train": len(train),
            "validation": len(validation),
            "holdout": len(holdout),
            "firstAt": samples[0]["time"].isoformat(),
            "lastAt": samples[-1]["targetTime"].isoformat(),
            "sha256": dataset_hash(samples),
        },
        "validation": selected["validation"],
        "holdout": holdout_metrics,
        "gates": gates,
    }


def model_candidates():
    return [
        ("logistic-c0.1", make_pipeline(StandardScaler(), LogisticRegression(C=0.1, max_iter=500, random_state=42))),
        ("logistic-c1", make_pipeline(StandardScaler(), LogisticRegression(C=1.0, max_iter=500, random_state=42))),
        ("hist-gradient-depth3", HistGradientBoostingClassifier(max_depth=3, learning_rate=0.05, max_iter=150, random_state=42)),
        ("hist-gradient-depth6", HistGradientBoostingClassifier(max_depth=6, learning_rate=0.05, max_iter=150, random_state=42)),
    ]


def trading_metrics(samples, probabilities, threshold):
    window_returns = []
    long_returns = []
    short_returns = []
    correct = 0
    trades = 0
    for sample, probability in zip(samples, probabilities):
        if probability >= threshold:
            value = sample["longReturn"]
            long_returns.append(value)
            trades += 1
            correct += int(sample["target"] == 1)
        elif probability <= 1 - threshold:
            value = sample["shortReturn"]
            short_returns.append(value)
            trades += 1
            correct += int(sample["target"] == 0)
        else:
            value = 0
        window_returns.append(value)
    always_long = [sample["longReturn"] for sample in samples]
    always_short = [sample["shortReturn"] for sample in samples]
    benchmark_candidates = {
        "cash": [0.0] * len(samples),
        "always_long": always_long,
        "always_short": always_short,
    }
    benchmark_name, benchmark_returns = max(benchmark_candidates.items(), key=lambda item: mean(item[1]))
    excess = [value - benchmark for value, benchmark in zip(window_returns, benchmark_returns)]
    return {
        "independentWindows": len(samples),
        "trades": trades,
        "longTrades": len(long_returns),
        "shortTrades": len(short_returns),
        "winRate": correct / trades if trades else None,
        "netReturnPct": mean(window_returns),
        "benchmarkLabel": benchmark_name,
        "benchmarkReturnPct": mean(benchmark_returns),
        "excessReturnPct": mean(excess),
        "excessConfidenceInterval95": bootstrap_ci(excess),
        "deflatedSharpeProbability": deflated_sharpe(excess, 12),
        "maxDrawdownPct": maximum_drawdown(window_returns),
    }


def summarize_l2(l2, now):
    rows = [row for values in l2.values() for row in values]
    if not rows:
        return {"coverage": 0, "durationHours": 0, "ready": False}
    first = min(row["time"] for row in rows)
    latest = max(row["time"] for row in rows)
    duration_hours = max(0, (latest - first).total_seconds() / 3600)
    expected = max(1, duration_hours * 3600 / 5 * len(ASSETS))
    coverage = min(1, len(rows) / expected)
    return {"coverage": coverage, "durationHours": duration_hours, "ready": coverage >= 0.8 and duration_hours >= 72}


def empty_horizon(horizon):
    return {
        "horizonSeconds": horizon,
        "status": "collecting",
        "edgeConfirmed": False,
        "selectedModel": None,
        "selectedThreshold": None,
        "dataset": {"samples": 0, "train": 0, "validation": 0, "holdout": 0, "firstAt": None, "lastAt": None, "sha256": None},
        "validation": empty_metrics(),
        "holdout": empty_metrics(),
        "gates": [gate("windows", "独立窓200件", False, 0, 200), gate("l2-history", "L2板72時間・80%網羅", False, 0, 0.8)],
    }


def empty_metrics():
    return {
        "independentWindows": 0,
        "trades": 0,
        "longTrades": 0,
        "shortTrades": 0,
        "winRate": None,
        "netReturnPct": 0,
        "benchmarkLabel": "cash",
        "benchmarkReturnPct": 0,
        "excessReturnPct": 0,
        "excessConfidenceInterval95": None,
        "deflatedSharpeProbability": None,
        "maxDrawdownPct": 0,
    }


def bootstrap_ci(values, trials=1000):
    if len(values) < 20:
        return None
    generator = np.random.default_rng(42)
    array = np.asarray(values, dtype=float)
    means = [float(np.mean(generator.choice(array, size=len(array), replace=True))) for _ in range(trials)]
    return [float(np.quantile(means, 0.025)), float(np.quantile(means, 0.975))]


def deflated_sharpe(values, trials):
    if len(values) < 20:
        return None
    array = np.asarray(values, dtype=float)
    deviation = float(np.std(array, ddof=1))
    if deviation <= 0:
        return 1.0 if float(np.mean(array)) > 0 else 0.0
    statistic = float(np.mean(array)) / (deviation / math.sqrt(len(array)))
    adjusted = statistic - math.sqrt(2 * math.log(max(1, trials)))
    return normal_cdf(adjusted)


def maximum_drawdown(returns):
    equity = 1.0
    peak = 1.0
    drawdown = 0.0
    for value in returns:
        equity *= max(0.01, 1 + value)
        peak = max(peak, equity)
        drawdown = max(drawdown, (peak - equity) / peak)
    return drawdown


def dataset_hash(samples):
    digest = hashlib.sha256()
    for sample in samples:
        digest.update(f"{sample['asset']}|{sample['time'].isoformat()}|{sample['targetTime'].isoformat()}|{sample['target']}\n".encode())
    return digest.hexdigest()


def gate(identifier, label, passed, value, threshold):
    return {"id": identifier, "label": label, "passed": bool(passed), "value": value, "threshold": threshold}


def mean(values):
    return float(np.mean(values)) if values else 0.0


def normal_cdf(value):
    return 0.5 * (1 + math.erf(value / math.sqrt(2)))


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def utc(value):
    return value.replace(tzinfo=value.tzinfo or timezone.utc).astimezone(timezone.utc)


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    main()
