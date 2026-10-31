// The attaching helper of the graceful-stop checks (design D3, D5), compiled during the probe by the
// csc.exe of .NET Framework 4.8 (C# 5), since W1's graceful stop would need a compiled helper, never
// PowerShell, and never committed as a binary:
//
//   ctrl-helper.exe <pid> <event> <log-file>
//
// It sends one console control event (0 CTRL_C_EVENT, 1 CTRL_BREAK_EVENT) to every process on the
// console of <pid>. It first ignores Ctrl+C with SetConsoleCtrlHandler(NULL, TRUE), which does not
// cover Ctrl+Break, and registers a handler that swallows every event and appends its type to
// <log-file>, which outlives this process, as does the line `armed`, written before it attaches.
// The handler is registered again once attached. A handler that fails counts as FALSE, and the
// default handler would then end this process, so nothing in it may throw. The helper then waits, so
// an event that ends it does so before it reports. It prints one JSON line:
// { "Attached": bool, "AttachError": n, "Sent": bool, "SendError": n, "EventsHandled": n }.
// Exit codes: 0 reported; 1 a failure, described on stderr. A process ended by the event exits with
// 0xC000013A and prints nothing.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

static class CtrlHelper
{
    const int SettleMs = 1000;

    delegate bool ConsoleHandler(uint ctrlType);

    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(ConsoleHandler handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);

    /** Held here so the garbage collector leaves it alone while Windows can still call it. */
    static ConsoleHandler swallow;
    static int eventsHandled;

    static int Main(string[] args)
    {
        uint processId, ctrlEvent;
        if (args.Length != 3 || !uint.TryParse(args[0], out processId) || !uint.TryParse(args[1], out ctrlEvent))
        {
            Console.Error.WriteLine("usage: ctrl-helper.exe <pid> <event> <log-file>");
            return 1;
        }
        string logFile = args[2];
        swallow = delegate(uint ctrlType)
        {
            Interlocked.Increment(ref eventsHandled);
            try { File.AppendAllText(logFile, ctrlType + "\n"); }
            catch (Exception) { }
            return true;
        };
        if (!SetConsoleCtrlHandler(null, true) || !SetConsoleCtrlHandler(swallow, true))
        {
            Console.Error.WriteLine("ctrl-helper: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
            return 1;
        }

        File.AppendAllText(logFile, "armed\n");

        // Started attached, it has a hidden console of its own, which AttachConsole would refuse to replace.
        FreeConsole();
        bool attached = AttachConsole(processId);
        int attachError = attached ? 0 : Marshal.GetLastWin32Error();
        bool sent = false;
        int sendError = 0;
        if (attached)
        {
            SetConsoleCtrlHandler(swallow, true);
            sent = GenerateConsoleCtrlEvent(ctrlEvent, 0);
            if (!sent) sendError = Marshal.GetLastWin32Error();
            Thread.Sleep(SettleMs);
            FreeConsole();
        }
        Console.WriteLine("{{\"Attached\":{0},\"AttachError\":{1},\"Sent\":{2},\"SendError\":{3},\"EventsHandled\":{4}}}", attached ? "true" : "false", attachError, sent ? "true" : "false", sendError, Thread.VolatileRead(ref eventsHandled));
        return 0;
    }
}
