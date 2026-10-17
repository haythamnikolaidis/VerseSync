"""``python -m versesync`` is an alias for ``python -m versesync.sidecar``."""

import sys

from versesync.sidecar import main

sys.exit(main())
