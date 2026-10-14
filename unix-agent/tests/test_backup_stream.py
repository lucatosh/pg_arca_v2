"""The backup copy loop: a sliding window over the thread pool instead of batches with a barrier."""
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

from pg_arca.engine.backup import _stream


class Stream(unittest.TestCase):
    def test_all_results_once_and_window_respected(self):
        inflight = [0]; peak = [0]; lock = threading.Lock()

        def fn(x):
            with lock:
                inflight[0] += 1; peak[0] = max(peak[0], inflight[0])
            time.sleep(0.002)
            with lock:
                inflight[0] -= 1
            return x * 2
        with ThreadPoolExecutor(max_workers=4) as pool:
            out = sorted(_stream(pool, range(200), fn, window=8))
        self.assertEqual(out, [x * 2 for x in range(200)])
        self.assertLessEqual(peak[0], 4)

    def test_no_barrier_slow_item_does_not_block_others(self):
        t0 = time.time()
        order = []

        def fn(x):
            time.sleep(0.5 if x == 0 else 0.01)
            return x
        with ThreadPoolExecutor(max_workers=4) as pool:
            for r in _stream(pool, range(40), fn, window=16):
                order.append((r, time.time() - t0))
        # the 39 quick items complete long before the slow one; a batched map would have held them all back
        quick = [t for r, t in order if r != 0]
        self.assertLess(max(quick), 0.45, "quick items were not held back by the slow one")
        self.assertEqual(sorted(r for r, _ in order), list(range(40)))

    def test_ticks_and_first_error_stops(self):
        ticks = [0]

        def fn(x):
            if x == 5:
                raise ValueError("boom")
            return x
        with ThreadPoolExecutor(max_workers=2) as pool:
            with self.assertRaises(ValueError):
                for _ in _stream(pool, range(50), fn, window=4, tick=lambda: ticks.__setitem__(0, ticks[0] + 1)):
                    pass
        self.assertGreater(ticks[0], 0)


if __name__ == "__main__":
    unittest.main()
