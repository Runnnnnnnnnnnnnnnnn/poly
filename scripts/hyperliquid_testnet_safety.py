import time


def schedule_dead_man_switch(exchange, deadline_ms, now_ms=None):
    deadline_ms = int(deadline_ms)
    current_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    if deadline_ms < current_ms + 5_000 or deadline_ms > current_ms + 300_000:
        raise ValueError("dead-man switch deadline must be 5 to 300 seconds in the future")
    result = exchange.schedule_cancel(deadline_ms)
    if result.get("status") != "ok":
        raise RuntimeError("Hyperliquid dead-man switch scheduling failed")
    return deadline_ms


def clear_dead_man_switch_if_flat(info, exchange, account_address, sleep=time.sleep):
    for attempt in range(3):
        if not info.open_orders(account_address):
            result = exchange.schedule_cancel(None)
            return result.get("status") == "ok"
        if attempt < 2:
            sleep(0.5)
    return False
