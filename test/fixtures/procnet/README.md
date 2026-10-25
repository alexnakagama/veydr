# Captured `/proc/net` files

Captured on the development machine (Debian 13, kernel 6.12, x86_64, little-endian) for the port
parser unit tests (`test/unit/linux-ports.test.ts`), while a Node process listened on these
sockets:

| Port | Address | File |
|---|---|---|
| 47801 | `127.0.0.1` | `tcp.txt` (plus one connection to it, both ends) |
| 47802 | `::1` | `tcp6.txt` |
| 47803 | `::` (dual-stack) | `tcp6.txt` |
| 47804 | `0.0.0.0` | `tcp.txt` |
| 47805 | `::ffff:127.0.0.1` (IPv4-mapped) | `tcp6.txt` |

Port 631 on `127.0.0.1` and `::1` (uid 0) is the system's print service: a listener owned by
another user.

`tcp6.txt` is byte-for-byte. `tcp.txt` keeps the header, the rows above, and two rows of other
connections (one established, one `TIME_WAIT` with inode 0); everything else was removed, and in
those two rows the local address was replaced by `192.168.0.10` and the remote address by
`198.51.100.7` (RFC 5737 documentation range). Removed rows leave gaps in the `sl` column, which
the parser does not use.
