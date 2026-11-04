// The Windows process-tree helper (add-windows-process-supervision design D5). One C# 5 file for the
// csc.exe of .NET Framework 4.8, built by scripts/build-windows-helper.mjs and never committed as a
// binary. Subcommands:
//
//   veydr-helper.exe version    prints the control protocol version on one line
//
// Exit codes: 0 success; 2 a usage error, described on stderr. Later groups add `run`, `inspect` and
// `terminate`; W3 adds `ports`.
using System;

static class VeydrHelper
{
    // Version 1 of the JSON-line control protocol (design D2). The TypeScript client refuses a helper
    // whose number differs from its own, so change both together.
    const int ProtocolVersion = 1;

    const int ExitOk = 0, ExitUsage = 2;

    static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "version")
        {
            Console.Out.WriteLine(ProtocolVersion.ToString(System.Globalization.CultureInfo.InvariantCulture));
            return ExitOk;
        }

        Console.Error.WriteLine("usage: veydr-helper version");
        return ExitUsage;
    }
}
