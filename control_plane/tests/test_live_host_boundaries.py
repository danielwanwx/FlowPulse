"""Host-side proof that privileged control ports are not published by Compose."""

import os
import socket
import unittest


@unittest.skipUnless(os.environ.get("FLOWPULSE_LIVE_HOST_BOUNDARY") == "1", "requires the local Compose stack")
class LiveHostBoundaryTests(unittest.TestCase):
    def test_authz_and_temporal_are_not_host_reachable(self):
        for port in (8091, 7233):
            with self.assertRaises(OSError, msg="privileged port {} is host-exposed".format(port)):
                socket.create_connection(("127.0.0.1", port), timeout=0.5)


if __name__ == "__main__":
    unittest.main()
