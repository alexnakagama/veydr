# Captured `/proc` files

Captured on the development machine (Debian 13, kernel 6.12, x86_64) for the `/proc` parser unit
tests (`test/unit/linux-procfs.test.ts`). Only the directory of the executable in
`cmdline-parentheses.bin` was replaced (`/opt/tools`); everything else is byte-for-byte.

| File | Source |
|---|---|
| `stat-parentheses.txt` | `/proc/<pid>/stat` of a copy of `sleep` named `a b) (c` (command name with spaces and parentheses) |
| `cmdline-parentheses.bin` | `/proc/<pid>/cmdline` of the same process (NUL-separated) |
| `stat-kthreadd.txt` | `/proc/2/stat` (kernel thread: PPID, group and session 0) |
| `cmdline-kernel-thread.bin` | `/proc/2/cmdline` (empty for kernel threads) |
| `stat-zombie.txt` | `/proc/<pid>/stat` of a zombie (state `Z`) |
| `stat-cat.txt` | `/proc/self/stat` of `cat` |
| `boot_id.txt` | `/proc/sys/kernel/random/boot_id` |
