import json
import hashlib
import os
import sys
import time

import eth_account
from hyperliquid.exchange import Exchange
from hyperliquid.info import Info
from hyperliquid.utils import constants
from hyperliquid.utils.types import Cloid


def output(payload):
    print(json.dumps(payload, separators=(",", ":")))


def main():
    request = json.load(sys.stdin)
    action = request.get("action")
    account_address = os.environ.get("HYPERLIQUID_ACCOUNT_ADDRESS", "").strip()
    if not account_address:
        raise ValueError("HYPERLIQUID_ACCOUNT_ADDRESS is not configured")

    info = Info(constants.TESTNET_API_URL, skip_ws=True)
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
        for client_order_id in request.get("clientOrderIds", [])[:100]:
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
            "recentFills": info.user_fills(account_address)[:100],
            "orderStatuses": order_statuses,
        })
        return

    secret_key = os.environ.get("HYPERLIQUID_API_WALLET_PRIVATE_KEY", "").strip()
    if not secret_key:
        raise ValueError("HYPERLIQUID_API_WALLET_PRIVATE_KEY is not configured")
    if account_value <= 0:
        raise ValueError("Hyperliquid testnet account has no equity")

    wallet = eth_account.Account.from_key(secret_key)
    exchange = Exchange(wallet, constants.TESTNET_API_URL, account_address=account_address)
    asset = str(request["asset"])
    size = float(request.get("size", 0))
    if size <= 0:
        raise ValueError("size must be positive")
    client_order_id = str(request["clientOrderId"])
    cloid = Cloid.from_str("0x" + hashlib.sha256(client_order_id.encode("utf-8")).hexdigest()[:32])

    exchange.update_leverage(1, asset, is_cross=False)
    exchange.schedule_cancel(int(time.time() * 1000) + 30_000)
    if action == "open":
        result = exchange.market_open(
            asset,
            bool(request["isBuy"]),
            size,
            px=float(request["referencePrice"]),
            slippage=float(request.get("slippage", 0.01)),
            cloid=cloid,
        )
    elif action == "close":
        result = exchange.market_close(
            asset,
            sz=size,
            px=float(request["referencePrice"]),
            slippage=float(request.get("slippage", 0.01)),
            cloid=cloid,
        )
    else:
        raise ValueError("unsupported action")
    output({"ok": result.get("status") == "ok", "environment": "testnet", "result": result})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        output({"ok": False, "environment": "testnet", "error": str(error)})
        sys.exit(1)
