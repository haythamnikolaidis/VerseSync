"""Runs the real sidecar with every job held in the running state for a fixed time.

The contract suite asserts that /result and /transcript answer 409 until a job is done, that
DELETE cancels a running job, and that SSE reports progress. The fixture backend finishes a job
in about 20 ms, so on a slow or jittery runner the next request arrives after the job is done
and those assertions fail. The mock holds each job for ``--duration`` seconds for the same
reason. Here the hold is the only change: this module wraps the pipeline call the job worker
makes, then starts the sidecar through its normal ``main()``.
"""

from __future__ import annotations

import os
import sys
import time
from typing import Any

from versesync import jobs
from versesync.sidecar import main

HOLD_S = float(os.environ["VERSESYNC_CONTRACT_JOB_HOLD_S"])

_run_pipeline = jobs.run_pipeline


def _held_run_pipeline(*args: Any, **kwargs: Any) -> Any:
    time.sleep(HOLD_S)
    return _run_pipeline(*args, **kwargs)


jobs.run_pipeline = _held_run_pipeline

if __name__ == "__main__":
    sys.exit(main())
