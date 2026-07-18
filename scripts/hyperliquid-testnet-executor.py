import json
import hashlib
import os
import sys
from importlib.metadata import version
from pathlib import Path

import eth_account
from hyperliquid.exchange import Exchange
from hyperliquid.info import Info
from hyperliquid.utils import constants
from hyperliquid.utils.types import Cloid

from hyperliquid_testnet_safety import clear_dead_man_switch_if_flat, schedule_dead_man_switch


def output(payload):
    print(json.dumps(payload, separators=(",", ":")))


def load_api_wallet_private_key():
    direct_key = os.environ.get("HYPERLIQUID_API_WALLET_PRIVATE_KEY", "").strip()
    if direct_key:
        return direct_key
    configured_path = os.environ.get("HYPERLIQUID_API_WALLET_KEY_FILE", "").strip()
    if not configured_path:
        default_path = Path.home() / ".polymarket-watch" / "secrets" / "hyperliquid-testnet-api-wallet.key"
        configured_path = str(default_path) if default_path.exists() else ""
    if not configured_path:
        return ""
    key_path = Path(configured_path).expanduser().resolve()
    mode = key_path.stat().st_mode & 0o777
    if mode & 0o077:
        raise ValueError(f"Hyperliquid API wallet key file permissions must be 600, found {mode:o}")
    return key_path.read_text(encoding="utf-8").strip()


def main():
    request = json.load(sys.stdin)
    action = request.get("action")
    info = Info(constants.TESTNET_API_URL, skip_ws=True)
    if action == "diagnostics":
        universe = [item.get("name") for item in info.meta().get("universe", []) if item.get("name")]
        output({
            "ok": True,
            "environment": "testnet",
            "sdkVersion": version("hyperliquid-python-sdk"),
            "apiUrl": constants.TESTNET_API_URL,
            "availableAssets": universe,
        })
        return

    account_address = os.environ.get("HYPERLIQUID_ACCOUNT_ADDRESS", "").strip()
    if not account_address:
        raise ValueError("HYPERLIQUID_ACCOUNT_ADDRESS is not configured")

    user_state = info.user_state(account_address)
    account_value = float(user_state.get("marginSummary", {}).get("accountValue", 0))
    if action == "readiness":
        output({"ok": True, "environment": "testnet", "accountValue": account_value})
        return
    if action == "reconcile":
        positions = []
        for item in user_state.get("assetPositions", []):
            position = item.get("position", {})
            size = float(position.get("szi", 0))
            if size == 0:
                continue
            positions.append({
                "coin": position.get("coin"),
                "size": size,
                "entryPrice": float(position.get("entryPx") or 0),
                "positionValue": float(position.get("positionValue") or 0),
                "unrealizedPnl": float(position.get("unrealizedPnl") or 0),
                "liquidationPrice": float(position.get("liquidationPx") or 0),
            })
        order_statuses = []
        for client_order_id in request.get("clientOrderIds", [])[:25]:
            client_order_id = str(client_order_id)
            cloid = Cloid.from_str("0x" + hashlib.sha256(client_order_id.encode("utf-8")).hexdigest()[:32])
            try:
                status = info.query_order_by_cloid(account_address, cloid)
            except Exception as error:
                status = {"status": "query_error", "error": str(error)}
            order_statuses.append({"clientOrderId": client_order_id, "exchangeCloid": cloid.to_raw(), "result": status})
        output({
            "ok": True,
            "environment": "testnet",
            "accountValue": account_value,
            "positions": positions,
            "openOrders": info.open_orders(account_address)[:100],
            "recentFills": info.user_fills(account_address)[:2000],
            "orderStatuses": order_statuses,
        })
        return

    secret_key = load_api_wallet_private_key()
    if not secret_key:
        raise ValueError("HYPERLIQUID_API_WALLET_PRIVATE_KEY is not configured")

    wallet = eth_account.Account.from_key(secret_key)
    exchange = Exchange(wallet, constants.TESTNET_API_URL, account_address=account_address)
    available_assets = {item.get("name") for item in info.meta().get("universe", [])}
    if action == "cancel_all":
        results = []
        for order in info.open_orders(account_address):
            asset = str(order.get("coin", ""))
            oid = order.get("oid")
            try:
                result = exchange.cancel(asset, int(oid))
            except Exception as error:
                result = {"status": "error", "error": str(error)}
            results.append({"asset": asset, "oid": oid, "result": result})
        output({
            "ok": True,
            "environment": "testnet",
            "cancelResults": results,
            "deadManCleared": clear_dead_man_switch_if_flat(info, exchange, account_address),
        })
        return

    if action == "flatten":
        requested_assets = set(request.get("assets", []))
        client_order_prefix = str(request["clientOrderPrefix"])
        slippage = float(request.get("slippage", 0.01))
        results = []
        for item in user_state.get("assetPositions", []):
            position = item.get("position", {})
            asset = str(position.get("coin", ""))
            size = float(position.get("szi", 0))
            if size == 0 or (requested_assets and asset not in requested_assets):
                continue
            client_order_id = f"{client_order_prefix}:{asset}"
            cloid = Cloid.from_str("0x" + hashlib.sha256(client_order_id.encode("utf-8")).hexdigest()[:32])
            try:
                if asset not in available_assets:
                    raise ValueError(f"{asset} is not available in the configured Hyperliquid testnet universe")
                is_buy = size < 0
                limit_price = exchange._slippage_price(asset, is_buy, slippage, None)
                result = exchange.order(
                    asset,
                    is_buy,
                    abs(size),
                    limit_price,
                    order_type={"limit": {"tif": "Ioc"}},
                    reduce_only=True,
                    cloid=cloid,
                )
            except Exception as error:
                result = {"status": "error", "error": str(error)}
            results.append({
                "asset": asset,
                "size": size,
                "clientOrderId": client_order_id,
                "result": result,
            })
        output({"ok": True, "environment": "testnet", "flattenResults": results})
        return

    asset = str(request["asset"])
    if asset not in available_assets:
        raise ValueError(f"{asset} is not available on Hyperliquid testnet")
    client_order_id = str(request["clientOrderId"])
    cloid = Cloid.from_str("0x" + hashlib.sha256(client_order_id.encode("utf-8")).hexdigest()[:32])

    if action == "cancel":
        result = exchange.cancel_by_cloid(asset, cloid)
        ok = result.get("status") == "ok"
        output({
            "ok": ok,
            "environment": "testnet",
            "result": result,
            "deadManCleared": ok and clear_dead_man_switch_if_flat(info, exchange, account_address),
        })
        return

    if account_value <= 0:
        raise ValueError("Hyperliquid testnet account has no equity")
    size = float(request.get("size", 0))
    if size <= 0:
        raise ValueError("size must be positive")

    exchange.update_leverage(1, asset, is_cross=False)
    if action == "rest":
        dead_man_scheduled_at = schedule_dead_man_switch(exchange, request["deadManDeadlineMs"])
        is_buy = bool(request["isBuy"])
        limit_price = exchange._slippage_price(
            asset,
            not is_buy,
            float(request.get("restingDistance", 0.03)),
            float(request["referencePrice"]),
        )
        result = exchange.order(
            asset,
            is_buy,
            size,
            limit_price,
            order_type={"limit": {"tif": "Alo"}},
            reduce_only=False,
            cloid=cloid,
        )
    elif action == "open":
        result = exchange.market_open(
            asset,
            bool(request["isBuy"]),
            size,
            px=float(request["referencePrice"]),
            slippage=float(request.get("slippage", 0.01)),
            cloid=cloid,
        )
    elif action == "close":
        is_buy = bool(request["isBuy"])
        limit_price = exchange._slippage_price(
            asset,
            is_buy,
            float(request.get("slippage", 0.01)),
            float(request["referencePrice"]),
        )
        result = exchange.order(
            asset,
            is_buy,
            size,
            limit_price,
            order_type={"limit": {"tif": "Ioc"}},
            reduce_only=True,
            cloid=cloid,
        )
    else:
        raise ValueError("unsupported action")
    response = {"ok": result.get("status") == "ok", "environment": "testnet", "result": result}
    if action == "rest":
        response["deadManScheduledAt"] = dead_man_scheduled_at
    output(response)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        output({"ok": False, "environment": "testnet", "error": str(error)})
        sys.exit(1)
