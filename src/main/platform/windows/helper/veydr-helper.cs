// The Windows process-tree helper (add-windows-process-supervision design D5). One C# 5 file for the
// csc.exe of .NET Framework 4.8, built by scripts/build-windows-helper.mjs and never committed as a
// binary. Subcommands:
//
//   veydr-helper.exe version                      prints the control protocol version on one line
//   veydr-helper.exe run <pipe>                   runs a command in a Job Object of its own (design D1),
//                                                 controlled over the named pipe <pipe> (design D2)
//   veydr-helper.exe inspect                      reports which identities on stdin are live (design D4)
//   veydr-helper.exe terminate <graceMs>          ends the identities on stdin that still match (design D4)
//   veydr-helper.exe console                      internal: the UTF-8 console a `run` command gets
//                                                 (add-windows-environment-and-commands design D5)
//
// `run` reads a one-time token as one line on stdin, connects to <pipe>, which must be served by the
// process that started the helper, and proves itself with the token. Only then does it read the run
// request, the second line on stdin: `{"application":"<program>","commandLine":"<command line>"}`
// (add-windows-environment-and-commands design D1). Veydr builds the complete command line; the
// helper checks it and passes both to CreateProcess unchanged, with the helper's own working
// directory and environment, in a new Job Object, and reports over the pipe in the JSON lines of
// protocol version 2 (src/main/platform/windows/protocol.ts). Its stdout and stderr belong to the
// command: the helper never writes to them after it has connected, and a refused request is
// reported as an `error` line on the pipe.
//
// Exit codes: 0 the command ran and its job is empty; 1 a failure, reported as an `error` line (or on
// stderr before the pipe is connected), after which nothing of the command is left running; 2 a
// usage error, described on stderr. A `stop` first sends Ctrl+Break to the command's hidden console,
// then ends the job if it has not emptied (design D3). If the control channel closes before the
// command has ended, Veydr is gone: the helper ends the job and exits with 1 (design D1).
//
// `inspect` and `terminate` read one line on stdin, a JSON array of identities
// (`[{"pid":P,"created":"<FILETIME>"},...]`, exactly as protocol.ts encodes it), and print one JSON
// line on stdout (see SurvivorCommands). They exit with 0, 1 (a failure, described on stderr), or 2.
// W3 adds `ports`.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

static class VeydrHelper
{
    // Version 2 of the JSON-line control protocol (design D2; add-windows-environment-and-commands
    // design D1). The TypeScript client refuses a helper whose number differs from its own, so change
    // both together.
    public const int ProtocolVersion = 2;

    public const int ExitOk = 0, ExitFailure = 1, ExitUsage = 2;

    const string Usage = "usage: veydr-helper version | veydr-helper run <pipe> | veydr-helper inspect | veydr-helper terminate <graceMs>";

    static int Main()
    {
        string[] args;
        try
        {
            args = Native.CommandLineArguments();
        }
        catch (Win32Exception error)
        {
            Console.Error.WriteLine("veydr-helper: cannot read the command line: " + error.Message);
            return ExitFailure;
        }

        if (args.Length == 1 && args[0] == "version")
        {
            Console.Out.WriteLine(ProtocolVersion.ToString(CultureInfo.InvariantCulture));
            return ExitOk;
        }
        if (args.Length == 2 && args[0] == "run") return new RunCommand(args[1]).Execute();
        // Internal: started by `run` only (ConsoleHost).
        if (args.Length == 1 && args[0] == "console") return ConsoleHost.Run();
        if (args.Length == 1 && args[0] == "inspect") return SurvivorCommands.Inspect();
        int graceMs;
        if (args.Length == 2 && args[0] == "terminate" && SurvivorCommands.TryParseGrace(args[1], out graceMs)) return SurvivorCommands.Terminate(graceMs);

        Console.Error.WriteLine(Usage);
        return ExitUsage;
    }
}

/** A failure the helper reports and ends on; `Message` is meant for the user. */
sealed class HelperException : Exception
{
    public HelperException(string message) : base(message) { }

    /** The last Win32 error of `what`, e.g. "could not create the job: Access is denied (error 5)". */
    public static HelperException LastError(string what)
    {
        int code = Marshal.GetLastWin32Error();
        return new HelperException(what + ": " + Native.Describe(code));
    }
}

/** A live process of the job, as the protocol reports it. */
sealed class Member
{
    public readonly uint Pid;
    public readonly ulong Created;
    public readonly string Image;

    public Member(uint pid, ulong created, string image)
    {
        Pid = pid;
        Created = created;
        Image = image;
    }
}

/**
 * `veydr-helper run`: one command in one Job Object (design D1), controlled over one authenticated
 * named-pipe connection (design D2). Threads: the main thread starts the command, reports its exit,
 * and waits for the job to empty; a reader thread answers `list` and starts a stop; a port thread
 * reports job changes from the job's completion port; a stop runs on a thread of its own, so `list`
 * is answered while it lasts. Every line is written under `gate`, so lines never interleave, and
 * a `members` list is read and written under it too, so no older list follows a newer one.
 */
sealed class RunCommand
{
    /** Exit code of processes ended by `TerminateJobObject`, as `taskkill /F` uses. */
    public const uint KilledExitCode = 1;
    /** How long the forced stop waits for the job to empty (design D3; Linux's KILL_WAIT_MS). */
    public const int KillWaitMs = 1000;
    /** How long the helper waits to connect to its control pipe. */
    const int ConnectTimeoutMs = 10000;
    /** Longest accepted token line, and the token's form (64 hex digits from the client). */
    const int MaxTokenBytes = 256;
    static readonly Regex TokenPattern = new Regex("^[0-9a-f]{32,128}$", RegexOptions.CultureInvariant);
    const string PipePrefix = @"\\.\pipe\";
    static readonly Regex PipeNamePattern = new Regex("^[A-Za-z0-9._-]{1,200}$", RegexOptions.CultureInvariant);
    /** Longest accepted control line; Veydr sends only `list` and `stop`. */
    const int MaxControlLineBytes = 4096;
    static readonly Regex ListPattern = new Regex("^\\{\"type\":\"list\"\\}$", RegexOptions.CultureInvariant);
    static readonly Regex StopPattern = new Regex("^\\{\"type\":\"stop\",\"graceMs\":(0|[1-9][0-9]{0,9})\\}$", RegexOptions.CultureInvariant);
    /**
     * A `members` line beyond this many characters is sent without image paths (protocol: 1 MiB).
     * Without them a member takes about 50 characters, so only a job of some 20,000 live processes
     * would still exceed the limit; Veydr then treats the helper as failed, which ends the job.
     */
    const int MaxMembersLineChars = 900 * 1024;
    /** How long an abort waits for its `error` line to be written. */
    const int AbortReportMs = 1000;

    readonly string pipePath;
    readonly object gate = new object();
    NamedPipeClientStream channel;
    /** The channel can no longer be written: Veydr is gone, or the helper is ending. */
    bool channelClosed;
    IntPtr job = IntPtr.Zero, port = IntPtr.Zero, leader = IntPtr.Zero;
    bool exitedReported, stopRequested, terminated;
    /** 1 once the helper is ending, normally or through an abort (see BeginEnding). */
    int ending;
    Thread stopThread;
    string lastEventMembers;
    readonly ManualResetEvent jobEmpty = new ManualResetEvent(false);

    public RunCommand(string pipePath)
    {
        this.pipePath = pipePath;
    }

    public int Execute()
    {
        Stream stdin;
        string token;
        try
        {
            stdin = Console.OpenStandardInput();
            token = ReadToken(stdin);
            Connect();
        }
        catch (Exception error)
        {
            // Nothing was started, and the pipe cannot carry the reason.
            Console.Error.WriteLine("veydr-helper: " + error.Message);
            return VeydrHelper.ExitFailure;
        }

        try
        {
            Send("{\"type\":\"ready\",\"version\":" + VeydrHelper.ProtocolVersion.ToString(CultureInfo.InvariantCulture) +
                ",\"token\":" + Json.Quote(token) + ",\"pid\":" + Native.GetCurrentProcessId().ToString(CultureInfo.InvariantCulture) + "}");
            // Read only now, so that every refusal is an `error` line on the pipe (design D1).
            RunRequest request = RunRequest.Read(stdin);
            uint leaderPid;
            ulong created;
            string consoleError;
            StartCommand(request, out leaderPid, out created, out consoleError);
            Send("{\"type\":\"started\",\"pid\":" + Json.Number(leaderPid) + ",\"created\":\"" + Json.Number(created) + "\"" +
                ",\"utf8Console\":" + (consoleError == null ? "true" : "false") +
                ",\"ansiCodePage\":" + Json.Number(Native.GetACP()) +
                (consoleError == null ? "" : ",\"consoleError\":" + Json.Quote(Truncate(consoleError, 4000))) + "}");

            StartThread(ReadControl, "control");
            StartThread(WatchJob, "job");

            if (Native.WaitForSingleObject(leader, Native.Infinite) != Native.WaitObject0) throw HelperException.LastError("could not wait for the command");
            ReportExited();
            // The helper stays until nothing of the command is left (design D1). Completion-port
            // notifications are not guaranteed, so the count is also read periodically.
            while (ActiveProcesses() != 0) jobEmpty.WaitOne(250);
        }
        catch (Exception error)
        {
            Abort(error is HelperException ? error.Message : "unexpected failure: " + error.Message);
            // Abort returns only while another thread's abort is under way; that one reports and exits.
            Thread.Sleep(Timeout.Infinite);
            return VeydrHelper.ExitFailure;
        }

        if (!BeginEnding())
        {
            // An abort is under way on another thread, and it exits the process.
            Thread.Sleep(Timeout.Infinite);
        }
        Thread pendingStop;
        lock (gate) pendingStop = stopThread;
        // A stop that began before the job emptied still reports its result.
        if (pendingStop != null) pendingStop.Join();
        lock (gate)
        {
            channelClosed = true;
            channel.Dispose();
        }
        return VeydrHelper.ExitOk;
    }

    /** Marks the helper as ending; `false` if it already was. Lock-free, so an abort never waits on a writer. */
    bool BeginEnding()
    {
        return Interlocked.CompareExchange(ref ending, 1, 0) == 0;
    }

    bool IsEnding()
    {
        return Thread.VolatileRead(ref ending) != 0;
    }

    static void StartThread(ThreadStart body, string name)
    {
        Thread thread = new Thread(body);
        thread.IsBackground = true;
        thread.Name = name;
        thread.Start();
    }

    /**
     * The helper cannot go on: it ends the job, and with it every process of the command (design
     * D1), reports why if it still can, and exits with 1. Only the first call acts; once the helper
     * is ending normally, later failures change nothing. The job is ended before anything that could
     * block, and the report gets at most AbortReportMs.
     */
    void Abort(string message)
    {
        if (!BeginEnding()) return;
        if (job != IntPtr.Zero) Native.TerminateJobObject(job, KilledExitCode);
        else if (leader != IntPtr.Zero) Native.TerminateProcess(leader, KilledExitCode);
        Thread report = new Thread(delegate()
        {
            Write("{\"type\":\"error\",\"message\":" + Json.Quote(Truncate(message, 4000)) + "}");
        });
        report.IsBackground = true;
        report.Start();
        report.Join(AbortReportMs);
        Environment.Exit(VeydrHelper.ExitFailure);
    }

    public static string Truncate(string text, int length)
    {
        return text.Length <= length ? text : text.Substring(0, length);
    }

    // ---- Control channel ------------------------------------------------------------------------

    /**
     * The token Veydr wrote as the first line on stdin (design D2): it never appears on a command
     * line. Read a byte at a time, so nothing of the run request after it is consumed.
     */
    static string ReadToken(Stream stdin)
    {
        byte[] bytes = new byte[MaxTokenBytes];
        int length = 0;
        while (true)
        {
            int next = stdin.ReadByte();
            if (next == -1 || next == '\n') break;
            if (length == bytes.Length) throw new HelperException("the token line on stdin is too long");
            bytes[length++] = (byte)next;
        }
        if (length > 0 && bytes[length - 1] == '\r') length--;
        string token = Encoding.ASCII.GetString(bytes, 0, length);
        if (!TokenPattern.IsMatch(token)) throw new HelperException("no valid token on stdin");
        return token;
    }

    /**
     * Connects to the control pipe, which must be served by the process that started the helper:
     * the pipe name is on the command line, where any process of the same user can read it, so
     * another process could otherwise offer an instance of its own. The connection is anonymous, so
     * the server cannot act with the helper's identity.
     */
    void Connect()
    {
        if (!pipePath.StartsWith(PipePrefix, StringComparison.OrdinalIgnoreCase)) throw new HelperException("the control pipe must be a local named pipe: " + pipePath);
        string name = pipePath.Substring(PipePrefix.Length);
        if (!PipeNamePattern.IsMatch(name)) throw new HelperException("the control pipe name is not valid: " + pipePath);

        channel = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Anonymous);
        try
        {
            channel.Connect(ConnectTimeoutMs);
        }
        catch (TimeoutException)
        {
            throw new HelperException("could not connect to the control pipe within " + ConnectTimeoutMs + " ms");
        }
        catch (IOException error)
        {
            throw new HelperException("could not connect to the control pipe: " + error.Message);
        }

        uint server;
        if (!Native.GetNamedPipeServerProcessId(channel.SafePipeHandle, out server)) throw HelperException.LastError("could not identify the control pipe's server");
        uint parent = Native.ParentProcessId();
        if (server != parent)
        {
            throw new HelperException("the control pipe is served by process " + server + ", not by the helper's parent " + parent);
        }
    }

    /** Writes one line unless the channel is closed; `false` if it could not be written. */
    bool Write(string json)
    {
        lock (gate)
        {
            if (channelClosed) return false;
            byte[] bytes = Encoding.ASCII.GetBytes(json + "\n");
            try
            {
                channel.Write(bytes, 0, bytes.Length);
                channel.Flush();
                return true;
            }
            catch (Exception error)
            {
                if (!(error is IOException || error is ObjectDisposedException || error is InvalidOperationException)) throw;
                channelClosed = true;
                return false;
            }
        }
    }

    /** Writes one line; a channel that fails means Veydr is gone, and the command must not outlive it. */
    void Send(string json)
    {
        if (Write(json) || IsEnding()) return;
        throw new HelperException("the control channel closed");
    }

    /** Reads Veydr's lines: `list` is answered at once, in order, and `stop` starts the stop (design D2). */
    void ReadControl()
    {
        try
        {
            byte[] buffer = new byte[4096];
            MemoryStream line = new MemoryStream();
            while (true)
            {
                int read;
                try
                {
                    read = channel.Read(buffer, 0, buffer.Length);
                }
                catch (Exception)
                {
                    // A broken or closed pipe; disposed by the helper itself once it is ending.
                    read = 0;
                }
                if (read == 0)
                {
                    if (IsEnding()) return;
                    throw new HelperException("the control channel closed before the command ended");
                }
                for (int i = 0; i < read; i++)
                {
                    if (buffer[i] != '\n')
                    {
                        if (line.Length >= MaxControlLineBytes) throw new HelperException("a control line is too long");
                        line.WriteByte(buffer[i]);
                        continue;
                    }
                    string text = Encoding.ASCII.GetString(line.GetBuffer(), 0, (int)line.Length);
                    line.SetLength(0);
                    if (text.EndsWith("\r", StringComparison.Ordinal)) text = text.Substring(0, text.Length - 1);
                    HandleControl(text);
                }
            }
        }
        catch (Exception error)
        {
            Abort(error is HelperException ? error.Message : "unexpected failure: " + error.Message);
        }
    }

    void HandleControl(string text)
    {
        if (ListPattern.IsMatch(text))
        {
            SendMembers(true);
            return;
        }
        Match stop = StopPattern.Match(text);
        if (!stop.Success) throw new HelperException("unknown control line: " + Truncate(text, 200));
        long graceMs = long.Parse(stop.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture);
        if (graceMs > int.MaxValue) throw new HelperException("graceMs is out of range: " + graceMs);
        lock (gate)
        {
            // Veydr sends `stop` at most once per run; a stop after the helper began to end finds
            // nothing left to stop.
            if (stopRequested || IsEnding()) return;
            stopRequested = true;
            int grace = (int)graceMs;
            stopThread = new Thread(delegate() { RunStop(grace); });
            stopThread.IsBackground = true;
            stopThread.Name = "stop";
            stopThread.Start();
        }
    }

    // ---- Job and command ------------------------------------------------------------------------

    /**
     * Starts the command suspended, assigns it to a new job with KILL_ON_JOB_CLOSE and no breakaway,
     * and only then resumes it, so every process it starts is in the job from its first instruction
     * on (design D1). The command inherits exactly the helper's stdout and stderr and a NUL stdin
     * (design D2).
     *
     * Its console is hidden and holds only the command's processes. It is set to UTF-8 before the
     * command runs (add-windows-environment-and-commands design D5, fallback b): a console host
     * (`veydr-helper console`, see ConsoleHost) creates a new console and sets its output code page
     * to 65001; the helper attaches to that console only while it creates the suspended command,
     * which inherits it, and detaches before the command runs; the host then exits. A suspended
     * process created with a console of its own cannot be attached to (W2 CI: error 6), since its
     * console exists only once it runs. Should any step fail, the command gets a new console of its
     * own, as in W1, and `consoleError` says why; it is null when the console is UTF-8.
     */
    void StartCommand(RunRequest request, out uint leaderPid, out ulong created, out string consoleError)
    {
        // The command's output handles, read before the console is freed: freeing it would close them
        // if they were console handles. Veydr always gives pipes; a console is refused rather than
        // passed on closed.
        IntPtr stdout = Native.GetStdHandle(Native.STD_OUTPUT_HANDLE);
        IntPtr stderr = Native.GetStdHandle(Native.STD_ERROR_HANDLE);
        if (stdout == IntPtr.Zero || stdout == Native.InvalidHandle || stderr == IntPtr.Zero || stderr == Native.InvalidHandle)
            throw new HelperException("the helper has no stdout or stderr to give the command");
        if (Native.GetFileType(stdout) == Native.FILE_TYPE_CHAR || Native.GetFileType(stderr) == Native.FILE_TYPE_CHAR)
            throw new HelperException("the helper's stdout and stderr must be pipes or files, not a console or another character device");

        // The helper's own console (Veydr's, or a hidden one of its own): AttachConsole refuses a
        // second one, and the helper writes nothing to a console, so it never needs it back. Freeing
        // it may reset the control handling, which is registered again (W1 group 4's rule).
        bool ctrlIgnored = CtrlEvents.Ignore();
        Native.FreeConsole();
        ctrlIgnored = CtrlEvents.Ignore() && ctrlIgnored;

        job = Native.CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw HelperException.LastError("could not create the job");
        Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        // Neither BREAKAWAY_OK nor SILENT_BREAKAWAY_OK: no process of the command can leave the job.
        limits.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!Native.SetInformationJobObject(job, Native.JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
            throw HelperException.LastError("could not configure the job");

        port = Native.CreateIoCompletionPort(Native.InvalidHandle, IntPtr.Zero, UIntPtr.Zero, 1);
        if (port == IntPtr.Zero) throw HelperException.LastError("could not create the job's completion port");
        Native.JOBOBJECT_ASSOCIATE_COMPLETION_PORT association = new Native.JOBOBJECT_ASSOCIATE_COMPLETION_PORT();
        association.CompletionKey = job;
        association.CompletionPort = port;
        if (!Native.SetInformationJobObject(job, Native.JobObjectAssociateCompletionPortInformation, ref association, Marshal.SizeOf(typeof(Native.JOBOBJECT_ASSOCIATE_COMPLETION_PORT))))
            throw HelperException.LastError("could not watch the job");

        // Only inheritable handles may be listed; nothing else is inherited.
        if (!Native.SetHandleInformation(stdout, Native.HANDLE_FLAG_INHERIT, Native.HANDLE_FLAG_INHERIT) ||
            !Native.SetHandleInformation(stderr, Native.HANDLE_FLAG_INHERIT, Native.HANDLE_FLAG_INHERIT))
            throw HelperException.LastError("could not pass the output handles on");

        Native.SECURITY_ATTRIBUTES inheritable = new Native.SECURITY_ATTRIBUTES();
        inheritable.nLength = Marshal.SizeOf(typeof(Native.SECURITY_ATTRIBUTES));
        inheritable.bInheritHandle = true;
        IntPtr nul = Native.CreateFile("NUL", Native.GENERIC_READ, Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE, ref inheritable, Native.OPEN_EXISTING, 0, IntPtr.Zero);
        if (nul == Native.InvalidHandle) throw HelperException.LastError("could not open NUL for the command's stdin");

        ConsoleHost host = null;
        bool attached = false;
        Native.PROCESS_INFORMATION process;
        try
        {
            if (!ctrlIgnored)
            {
                consoleError = "could not ignore console control events, so no console is attached to";
            }
            else
            {
                host = ConsoleHost.Start(out consoleError);
                if (host != null) attached = AttachTo(host, out consoleError);
            }

            // Attached: the command inherits the host's UTF-8 console. Otherwise it gets one of its own.
            // The working directory and environment are the helper's own, which Veydr set (design D2).
            uint flags = Native.CREATE_SUSPENDED | Native.CREATE_NEW_PROCESS_GROUP | Native.CREATE_UNICODE_ENVIRONMENT | (attached ? 0 : Native.CREATE_NEW_CONSOLE);
            // Both exactly as Veydr built them (design D1); RunRequest has checked them.
            process = Spawn(request.Application, request.CommandLine, flags, nul, stdout, stderr);
        }
        finally
        {
            // The helper is a member of the command's console only while the command is suspended.
            if (attached)
            {
                Native.FreeConsole();
                CtrlEvents.Ignore();
            }
            Native.CloseHandle(nul);
            // The host waits until the command is on its console, then exits.
            if (host != null) host.Release();
        }

        leader = process.hProcess;
        try
        {
            if (!Native.AssignProcessToJobObject(job, process.hProcess)) throw HelperException.LastError("could not put the command in its job");
            if (Native.ResumeThread(process.hThread) == uint.MaxValue) throw HelperException.LastError("could not resume the command");
        }
        catch
        {
            // Still suspended, or in the job: either way nothing of it may keep running.
            Native.TerminateProcess(process.hProcess, KilledExitCode);
            throw;
        }
        finally
        {
            Native.CloseHandle(process.hThread);
        }
        long creation, exit, kernel, user;
        if (!Native.GetProcessTimes(process.hProcess, out creation, out exit, out kernel, out user)) throw HelperException.LastError("could not read the command's creation time");
        leaderPid = process.dwProcessId;
        created = (ulong)creation;
    }

    /**
     * Attaches the helper to the host's console, with its own control handling registered again
     * (attaching resets it); `false` with the reason otherwise, the helper then on no console.
     * Called before any other thread of the helper starts, so no stop can attach meanwhile.
     */
    static bool AttachTo(ConsoleHost host, out string error)
    {
        if (!Native.AttachConsole(host.Pid))
        {
            error = "could not attach to the console host's console: " + Native.Describe(Marshal.GetLastWin32Error());
            CtrlEvents.Ignore();
            return false;
        }
        if (!CtrlEvents.Ignore())
        {
            error = "could not ignore console control events: " + Native.Describe(Marshal.GetLastWin32Error());
            Native.FreeConsole();
            CtrlEvents.Ignore();
            return false;
        }
        error = null;
        return true;
    }

    /**
     * CreateProcess with the helper's working directory and environment, stdio set to the given
     * handles, and only those inherited, hidden. Throws a HelperException; one for CreateProcess
     * itself carries just the system's reason (e.g. "The system cannot find the file specified").
     */
    public static Native.PROCESS_INFORMATION Spawn(string application, string commandLine, uint flags, IntPtr stdin, IntPtr stdout, IntPtr stderr)
    {
        List<IntPtr> list = new List<IntPtr>();
        foreach (IntPtr handle in new IntPtr[] { stdin, stdout, stderr })
        {
            if (!list.Contains(handle)) list.Add(handle);
        }
        IntPtr handles = IntPtr.Zero, attributes = IntPtr.Zero;
        bool attributesReady = false;
        try
        {
            handles = Marshal.AllocHGlobal(IntPtr.Size * list.Count);
            Marshal.Copy(list.ToArray(), 0, handles, list.Count);

            IntPtr size = IntPtr.Zero;
            Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            if (size == IntPtr.Zero) throw HelperException.LastError("could not size the process attributes");
            attributes = Marshal.AllocHGlobal(size);
            if (!Native.InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw HelperException.LastError("could not create the process attributes");
            attributesReady = true;
            if (!Native.UpdateProcThreadAttribute(attributes, 0, (IntPtr)Native.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, (IntPtr)(IntPtr.Size * list.Count), IntPtr.Zero, IntPtr.Zero))
                throw HelperException.LastError("could not limit the inherited handles");

            Native.STARTUPINFOEX startup = new Native.STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(Native.STARTUPINFOEX));
            startup.StartupInfo.dwFlags = Native.STARTF_USESTDHANDLES | Native.STARTF_USESHOWWINDOW;
            startup.StartupInfo.wShowWindow = Native.SW_HIDE;
            startup.StartupInfo.hStdInput = stdin;
            startup.StartupInfo.hStdOutput = stdout;
            startup.StartupInfo.hStdError = stderr;
            startup.lpAttributeList = attributes;

            Native.PROCESS_INFORMATION process;
            if (!Native.CreateProcess(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, flags | Native.EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, null, ref startup, out process))
                throw new HelperException(Native.Describe(Marshal.GetLastWin32Error()));
            return process;
        }
        finally
        {
            if (attributesReady) Native.DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
        }
    }

    uint ActiveProcesses()
    {
        Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
        if (!Native.QueryInformationJobObject(job, Native.JobObjectBasicAccountingInformation, out info, Marshal.SizeOf(typeof(Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero))
            throw HelperException.LastError("could not count the job's processes");
        return info.ActiveProcesses;
    }

    /** PIDs in the job, nested jobs included. */
    uint[] JobPids()
    {
        int capacity = 64;
        for (int attempt = 0; attempt < 16; attempt++)
        {
            int size = 8 + capacity * IntPtr.Size;
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                if (Native.QueryInformationJobObject(job, Native.JobObjectBasicProcessIdList, buffer, size, IntPtr.Zero))
                {
                    int count = Marshal.ReadInt32(buffer, 4);
                    uint[] pids = new uint[count];
                    for (int i = 0; i < count; i++) pids[i] = (uint)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64();
                    return pids;
                }
                int code = Marshal.GetLastWin32Error();
                if (code != Native.ERROR_MORE_DATA) throw new HelperException("could not list the job's processes: " + Native.Describe(code));
                int assigned = Marshal.ReadInt32(buffer, 0);
                capacity = Math.Max(capacity * 2, assigned + 64);
                if (capacity > 1 << 20) throw new HelperException("the job holds too many processes to list");
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        throw new HelperException("could not list the job's processes: the job kept growing");
    }

    /**
     * The live processes of the job, oldest first. Each PID is opened and checked to be in this job,
     * so a PID reused after the list was read is never reported.
     */
    List<Member> Members()
    {
        List<Member> members = new List<Member>();
        foreach (uint pid in JobPids())
        {
            IntPtr process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION | Native.SYNCHRONIZE, false, pid);
            if (process == IntPtr.Zero) continue;
            try
            {
                bool inJob;
                if (!Native.IsProcessInJob(process, job, out inJob) || !inJob) continue;
                if (Native.WaitForSingleObject(process, 0) != Native.WaitTimeout) continue;
                long creation, exit, kernel, user;
                if (!Native.GetProcessTimes(process, out creation, out exit, out kernel, out user) || creation <= 0) continue;
                members.Add(new Member(pid, (ulong)creation, Native.ImagePath(process)));
            }
            finally
            {
                Native.CloseHandle(process);
            }
        }
        members.Sort(delegate(Member a, Member b)
        {
            int byAge = a.Created.CompareTo(b.Created);
            return byAge != 0 ? byAge : a.Pid.CompareTo(b.Pid);
        });
        return members;
    }

    static string MembersJson(List<Member> members, bool withImages)
    {
        StringBuilder json = new StringBuilder("[");
        for (int i = 0; i < members.Count; i++)
        {
            Member m = members[i];
            if (i > 0) json.Append(',');
            json.Append("{\"pid\":").Append(Json.Number(m.Pid)).Append(",\"created\":\"").Append(Json.Number(m.Created))
                .Append("\",\"image\":").Append(Json.Quote(withImages ? m.Image : ""));
            json.Append('}');
        }
        return json.Append(']').ToString();
    }

    public static string MembersJson(List<Member> members)
    {
        string full = MembersJson(members, true);
        return full.Length <= MaxMembersLineChars ? full : MembersJson(members, false);
    }

    /** Reads the members and sends them as one `members` line; `answer` for a `list` (design D2). */
    void SendMembers(bool answer)
    {
        lock (gate)
        {
            string list = MembersJson(Members());
            if (!answer)
            {
                // The same set again tells Veydr nothing.
                if (list == lastEventMembers) return;
                lastEventMembers = list;
            }
            Send("{\"type\":\"members\",\"answer\":" + (answer ? "true" : "false") + ",\"members\":" + list + "}");
        }
    }

    /** Reports job changes from the completion port (design D2). */
    void WatchJob()
    {
        try
        {
            while (true)
            {
                uint message;
                UIntPtr key;
                IntPtr overlapped;
                if (!Native.GetQueuedCompletionStatus(port, out message, out key, out overlapped, Native.Infinite))
                    throw HelperException.LastError("could not read the job's completion port");
                switch (message)
                {
                    case Native.JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO:
                        jobEmpty.Set();
                        break;
                    case Native.JOB_OBJECT_MSG_NEW_PROCESS:
                    case Native.JOB_OBJECT_MSG_EXIT_PROCESS:
                    case Native.JOB_OBJECT_MSG_ABNORMAL_EXIT_PROCESS:
                        SendMembers(false);
                        break;
                }
            }
        }
        catch (Exception error)
        {
            Abort(error is HelperException ? error.Message : "unexpected failure: " + error.Message);
        }
    }

    /** Sends `exited` once the leader has ended, exactly once. */
    void ReportExited()
    {
        lock (gate)
        {
            if (exitedReported || Native.WaitForSingleObject(leader, 0) != Native.WaitObject0) return;
            uint code;
            if (!Native.GetExitCodeProcess(leader, out code)) throw HelperException.LastError("could not read the command's exit code");
            exitedReported = true;
            Send("{\"type\":\"exited\",\"code\":" + Json.Number(code) + ",\"forced\":" + (terminated ? "true" : "false") + "}");
        }
    }

    void RunStop(int graceMs)
    {
        try
        {
            Stop(graceMs);
        }
        catch (Exception error)
        {
            Abort(error is HelperException ? error.Message : "unexpected failure: " + error.Message);
        }
    }

    /**
     * The stop (design D3): Ctrl+Break to the command's console, then up to `graceMs` for the job to
     * empty; if it has not, `TerminateJobObject` and up to 1 s more. When no event could be sent, the
     * forced step follows at once, without waiting `graceMs`. A `stopped` report then names the
     * members still alive; `graceful` is "yes" only when the job emptied before any forced step. A
     * job that is already empty needed no stop.
     */
    void Stop(int graceMs)
    {
        string graceful = "yes";
        bool forced = false;
        // graceMs counts from the request, so the time spent sending the event is part of it.
        Stopwatch sinceRequest = Stopwatch.StartNew();
        if (ActiveProcesses() != 0 && !(SendCtrlBreak() && WaitForEmptyJob((int)Math.Max(0, graceMs - sinceRequest.ElapsedMilliseconds))))
        {
            lock (gate) terminated = true;
            graceful = "no";
            forced = true;
            // Should this fail, what is left is reported as surviving, and the job still ends it
            // once the helper exits (KILL_ON_JOB_CLOSE).
            Native.TerminateJobObject(job, KilledExitCode);
            WaitForEmptyJob(KillWaitMs);
        }
        // Once the job is empty the leader has ended, but its handle may be signalled a moment later.
        if (ActiveProcesses() == 0) Native.WaitForSingleObject(leader, KillWaitMs);

        lock (gate)
        {
            List<Member> survivors = Members();
            bool leaderAlive = Native.WaitForSingleObject(leader, 0) != Native.WaitObject0;
            if (leaderAlive)
            {
                uint leaderPid = Native.GetProcessId(leader);
                bool listed = false;
                foreach (Member m in survivors) listed |= m.Pid == leaderPid;
                // `exited` precedes a complete stop, so a leader still alive is always a survivor.
                if (!listed)
                {
                    long creation, exit, kernel, user;
                    if (!Native.GetProcessTimes(leader, out creation, out exit, out kernel, out user)) throw HelperException.LastError("could not read the command's creation time");
                    survivors.Insert(0, new Member(leaderPid, (ulong)creation, Native.ImagePath(leader)));
                }
            }
            else
            {
                ReportExited();
            }
            Send("{\"type\":\"stopped\",\"graceful\":\"" + graceful + "\",\"forced\":" + (forced ? "true" : "false") + ",\"survivors\":" + MembersJson(survivors) + "}");
        }
    }

    /** Waits up to `timeoutMs` for the job to empty; `true` if it did. */
    bool WaitForEmptyJob(int timeoutMs)
    {
        Stopwatch elapsed = Stopwatch.StartNew();
        while (ActiveProcesses() != 0)
        {
            long left = timeoutMs - elapsed.ElapsedMilliseconds;
            if (left <= 0) return false;
            // ACTIVE_PROCESS_ZERO wakes the wait early; the count is read again either way, since
            // completion-port notifications are not guaranteed. jobEmpty is never reset: should it
            // be set while the job is not empty, the short sleep keeps this from spinning.
            if (jobEmpty.WaitOne((int)Math.Min(left, 50))) Thread.Sleep((int)Math.Min(left, 10));
        }
        return true;
    }

    /**
     * Sends Ctrl+Break to the command's hidden console (design D3): the console of the leader, or,
     * once the leader has ended, of the oldest live member that has one. The event reaches every
     * process on that console, so it is sent only to a console that holds nothing but this job's
     * processes; Veydr and other commands have consoles of their own and are never reached. `false`
     * when no such console could be attached to, or the event could not be sent: then no process
     * of the command can receive it, and waiting `graceMs` would gain nothing.
     *
     * Only the stop thread changes the helper's console once the command runs (StartCommand does
     * before, while no other thread exists), and a run has at most one stop.
     */
    bool SendCtrlBreak()
    {
        if (!CtrlEvents.Ignore()) return false;
        // The helper's own console (Veydr's, or a hidden one of its own): AttachConsole refuses a
        // second one. The helper writes nothing to a console, so it never needs it back.
        Native.FreeConsole();
        CtrlEvents.Ignore();

        // At most MaxConsoleAttempts entries, so a list is enough (and needs only mscorlib).
        List<IntPtr> triedConsoles = new List<IntPtr>();
        int attempts = 0;
        foreach (Member member in Members())
        {
            if (attempts++ == CtrlEvents.MaxConsoleAttempts) break;
            // Fails for a process without a console, such as one that called FreeConsole or a
            // console host, and for one that has exited since it was listed.
            if (!Native.AttachConsole(member.Pid))
            {
                CtrlEvents.Ignore();
                continue;
            }
            try
            {
                // Attaching gives the helper the console's default control handling again, which
                // would end it on the event it is about to send (W0's probe registers again too).
                if (!CtrlEvents.Ignore()) return false;
                IntPtr window = Native.GetConsoleWindow();
                // A console seen before was already found unfit; a console without a window
                // cannot be told apart from another, so it is always checked.
                if (window != IntPtr.Zero)
                {
                    if (triedConsoles.Contains(window)) continue;
                    triedConsoles.Add(window);
                }
                if (!ConsoleHoldsOnlyJobMembers()) continue;
                if (CtrlEvents.SendBreak()) return true;
            }
            finally
            {
                Native.FreeConsole();
                // Detaching may reset the control handling too, and an event may still be on its way.
                CtrlEvents.Ignore();
            }
        }
        return false;
    }

    /**
     * Whether every process on the console the helper is attached to, apart from the helper, is in
     * this job, and there is at least one. A process that cannot be opened counts as foreign.
     */
    bool ConsoleHoldsOnlyJobMembers()
    {
        uint self = Native.GetCurrentProcessId();
        uint[] list = CtrlEvents.ConsoleProcesses();
        if (list == null) return false;
        bool anyMember = false;
        foreach (uint pid in list)
        {
            if (pid == self) continue;
            if (!IsJobMember(pid)) return false;
            anyMember = true;
        }
        return anyMember;
    }

    bool IsJobMember(uint pid)
    {
        IntPtr process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero) return false;
        try
        {
            bool inJob;
            return Native.IsProcessInJob(process, job, out inJob) && inJob;
        }
        finally
        {
            Native.CloseHandle(process);
        }
    }
}

/**
 * The run request (add-windows-environment-and-commands design D1): what `run` starts, read from
 * stdin after the token and only once the helper has sent `ready`. It is exactly one line,
 * `{"application":"<program>","commandLine":"<command line>"}`, the form protocol.ts's
 * `encodeRunRequest` writes, followed by the end of stdin. C# 5 has no JSON parser without further
 * references, so it is parsed here by hand, strictly: the two string fields in that order, no
 * whitespace, the JSON string escapes, and nothing else. Every refusal names an offset or a limit,
 * never the text, which may hold a secret.
 */
sealed class RunRequest
{
    /** Longest accepted request line in bytes, `\n` excluded (protocol.ts: MAX_RUN_REQUEST_BYTES). */
    public const int MaxBytes = 1024 * 1024;
    /** CreateProcess limits the command line to 32,767 characters, its terminating NUL included. */
    public const int MaxCommandLineChars = 32766;

    public readonly string Application, CommandLine;

    RunRequest(string application, string commandLine)
    {
        Application = application;
        CommandLine = commandLine;
    }

    /** Reads, parses and checks the request; a HelperException says why it is refused. */
    public static RunRequest Read(Stream stdin)
    {
        string text;
        try
        {
            // Strict: an invalid byte sequence, an encoded surrogate included, throws.
            text = new UTF8Encoding(false, true).GetString(ReadLine(stdin));
        }
        catch (ArgumentException)
        {
            throw new HelperException("the run request on stdin is not valid UTF-8");
        }
        RunRequest request = Parse(text);
        request.Check();
        return request;
    }

    /** The rest of stdin, which must be one line ended by `\n` and nothing after it, without the `\n`. */
    static byte[] ReadLine(Stream stdin)
    {
        MemoryStream input = new MemoryStream();
        byte[] buffer = new byte[65536];
        while (true)
        {
            int read = stdin.Read(buffer, 0, buffer.Length);
            if (read == 0) break;
            // Room for the line and its `\n`.
            if (input.Length + read > MaxBytes + 1) throw new HelperException("the run request on stdin exceeds " + MaxBytes + " bytes");
            input.Write(buffer, 0, read);
        }
        byte[] bytes = input.ToArray();
        int length = bytes.Length;
        if (length == 0 || bytes[length - 1] != '\n') throw new HelperException("stdin does not hold a complete run request line");
        // encodeRunRequest ends the line with `\n` alone; a `\r` before it is text after the object.
        length--;
        if (Array.IndexOf(bytes, (byte)'\n', 0, length) >= 0) throw new HelperException("stdin holds more than one line after the token");
        if (length > MaxBytes) throw new HelperException("the run request on stdin exceeds " + MaxBytes + " bytes");
        byte[] line = new byte[length];
        Array.Copy(bytes, line, length);
        return line;
    }

    public static RunRequest Parse(string text)
    {
        int at = 0;
        string application = null, commandLine = null;
        Expect(text, ref at, '{');
        while (true)
        {
            int keyAt = at;
            string key = ParseString(text, ref at);
            Expect(text, ref at, ':');
            if (at >= text.Length || text[at] != '"') throw new HelperException("the run request's value at offset " + at + " is not a string");
            string value = ParseString(text, ref at);
            if (key == "application")
            {
                if (application != null) throw new HelperException("the run request repeats the key \"application\" at offset " + keyAt);
                if (commandLine != null) throw new HelperException("the run request has \"application\" after \"commandLine\"");
                application = value;
            }
            else if (key == "commandLine")
            {
                if (commandLine != null) throw new HelperException("the run request repeats the key \"commandLine\" at offset " + keyAt);
                if (application == null) throw new HelperException("the run request has \"commandLine\" before \"application\"");
                commandLine = value;
            }
            else
            {
                throw new HelperException("the run request has an unknown key at offset " + keyAt);
            }
            if (at < text.Length && text[at] == ',')
            {
                at++;
                continue;
            }
            Expect(text, ref at, '}');
            break;
        }
        if (at != text.Length) throw new HelperException("the run request has text after its end, at offset " + at);
        if (application == null || commandLine == null) throw new HelperException("the run request needs both \"application\" and \"commandLine\"");
        return new RunRequest(application, commandLine);
    }

    static void Expect(string text, ref int at, char expected)
    {
        if (at >= text.Length || text[at] != expected) throw new HelperException("the run request is malformed at offset " + at + ": expected '" + expected + "'");
        at++;
    }

    /** A JSON string starting at `at`, which is moved past its closing quote. */
    static string ParseString(string text, ref int at)
    {
        int start = at;
        Expect(text, ref at, '"');
        StringBuilder value = new StringBuilder();
        while (true)
        {
            if (at >= text.Length) throw new HelperException("the run request has an unterminated string at offset " + start);
            char c = text[at++];
            if (c == '"') break;
            if (c < 0x20) throw new HelperException("the run request has an unescaped control character at offset " + (at - 1));
            if (c != '\\')
            {
                value.Append(c);
                continue;
            }
            if (at >= text.Length) throw new HelperException("the run request has an unterminated string at offset " + start);
            char escape = text[at++];
            switch (escape)
            {
                case '"': value.Append('"'); break;
                case '\\': value.Append('\\'); break;
                case '/': value.Append('/'); break;
                case 'b': value.Append('\b'); break;
                case 'f': value.Append('\f'); break;
                case 'n': value.Append('\n'); break;
                case 'r': value.Append('\r'); break;
                case 't': value.Append('\t'); break;
                case 'u':
                    int code = 0;
                    for (int i = 0; i < 4; i++, at++)
                    {
                        int digit = at < text.Length ? HexDigit(text[at]) : -1;
                        if (digit < 0) throw new HelperException("the run request has a malformed \\u escape at offset " + (at - 2 - i));
                        code = code * 16 + digit;
                    }
                    value.Append((char)code);
                    break;
                default:
                    throw new HelperException("the run request has an unknown escape at offset " + (at - 2));
            }
        }
        string result = value.ToString();
        // A \uXXXX escape can name half of a pair; the command line must be valid UTF-16.
        for (int i = 0; i < result.Length; i++)
        {
            if (char.IsHighSurrogate(result[i]) && i + 1 < result.Length && char.IsLowSurrogate(result[i + 1])) i++;
            else if (char.IsSurrogate(result[i])) throw new HelperException("the run request has an unpaired surrogate in the string at offset " + start);
        }
        return result;
    }

    static int HexDigit(char c)
    {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    }

    /**
     * The helper's own checks (design D1), whatever Veydr checked: NUL, a program that is not given
     * by its full drive or UNC path (or is a device path, or names a data stream), a batch-file
     * program, and an empty or too long command line. CreateProcess would otherwise run a batch file
     * through cmd.exe implicitly, with its own unsafe quoting; a batch file runs only as part of a
     * cmd.exe command line, whose program is cmd.exe.
     */
    void Check()
    {
        if (Application.IndexOf('\0') >= 0) throw new HelperException("the program path contains a NUL character");
        if (CommandLine.IndexOf('\0') >= 0) throw new HelperException("the command line contains a NUL character");
        if (!IsFullyQualified(Application)) throw new HelperException("the program must be given by its full path: " + RunCommand.Truncate(Application, 300));
        if (IsDevicePath(Application)) throw new HelperException("the program must be an ordinary drive or UNC path: " + RunCommand.Truncate(Application, 300));
        if (Application.IndexOfAny(new char[] { '"', '\r', '\n' }) >= 0) throw new HelperException("the program path contains a double quote or a line break: " + RunCommand.Truncate(Application, 300));
        // `C:\tool.bat\.` is `C:\tool.bat` once normalized, but its last segment is no batch file name.
        if (HasDotSegment(Application)) throw new HelperException("the program path has an empty, '.' or '..' segment, or one of only dots and spaces: " + RunCommand.Truncate(Application, 300));
        if (Application.IndexOf(':', 2) >= 0) throw new HelperException("the program path contains ':' after the drive: " + RunCommand.Truncate(Application, 300));
        if (IsBatchFile(Application)) throw new HelperException("the program is a batch file, which runs only as part of a cmd.exe command line: " + RunCommand.Truncate(Application, 300));
        if (CommandLine.Length == 0) throw new HelperException("the command line is empty");
        // argv[0] is what the program reads as its own path; it must be the program started.
        string program = "\"" + Application + "\"";
        if (!(CommandLine == program || CommandLine.StartsWith(program + " ", StringComparison.Ordinal)))
            throw new HelperException("the command line does not start with the quoted program");
        if (CommandLine.Length > MaxCommandLineChars)
            throw new HelperException("the command line has " + CommandLine.Length + " characters, more than the " + MaxCommandLineChars + " Windows accepts");
    }

    /** `C:\...` or a UNC path: nothing depends on a current drive or directory. */
    static bool IsFullyQualified(string path)
    {
        bool asciiLetter = path.Length > 0 && ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z'));
        if (path.Length >= 3 && asciiLetter && path[1] == ':' && IsSeparator(path[2])) return true;
        return path.Length >= 3 && IsSeparator(path[0]) && IsSeparator(path[1]) && !IsSeparator(path[2]);
    }

    /**
     * Whether a full path has a segment Windows removes or resolves when it normalizes the path: an
     * empty one, `.`, `..`, or one of only dots and spaces (command-line.ts: hasDotSegment). The
     * drive or the UNC prefix is not a segment.
     */
    static bool HasDotSegment(string path)
    {
        int start = path.Length >= 3 && path[1] == ':' ? 3 : 2;
        string[] segments = path.Substring(start).Split('\\', '/');
        foreach (string segment in segments)
        {
            if (segment.Trim('.', ' ').Length == 0) return true;
        }
        return false;
    }

    /** `\\.\...` or `\\?\...`, in either slash. */
    static bool IsDevicePath(string path)
    {
        return path.Length >= 4 && IsSeparator(path[0]) && IsSeparator(path[1]) && (path[2] == '.' || path[2] == '?') && IsSeparator(path[3]);
    }

    static bool IsSeparator(char c)
    {
        return c == '\\' || c == '/';
    }

    /** A `.bat` or `.cmd` file name, in any case, once trailing dots and spaces are removed (command-line.ts: isBatchFile). */
    public static bool IsBatchFile(string path)
    {
        int separator = Math.Max(path.LastIndexOf('\\'), path.LastIndexOf('/'));
        string name = path.Substring(separator + 1).TrimEnd(' ', '.');
        return name.EndsWith(".bat", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase);
    }
}

/**
 * The console a command runs on (add-windows-environment-and-commands design D5, fallback b):
 * `veydr-helper console`, started by `run` in a new hidden console of its own and outside the
 * command's job. It sets that console's output code page to UTF-8 (65001), which works because the
 * console exists once the host runs, and answers `ok` (or the reason it could not) as one ASCII
 * line on its stdout, a pipe to `run`. It then waits for its stdin, a pipe from `run`, to close:
 * `run` closes it once it has created the command on this console. The host stays until the
 * command is on the console, so the console cannot end before the command connects, at most
 * AttachWaitMs, and exits. It never runs anything itself, and it is never a member of the job.
 */
sealed class ConsoleHost
{
    /** How long `run` waits for the host's answer before it gives the command a console of its own. */
    const int AnswerTimeoutMs = 10000;
    /** How long the host waits, once released, for the command to appear on its console. */
    const int AttachWaitMs = 2000;
    const uint Utf8CodePage = 65001;
    const int MaxAnswerBytes = 512;

    readonly IntPtr process;
    IntPtr input;
    public readonly uint Pid;

    ConsoleHost(IntPtr process, IntPtr input, uint pid)
    {
        this.process = process;
        this.input = input;
        Pid = pid;
    }

    /** Starts the host and waits for its answer; null with the reason when it cannot give a UTF-8 console. */
    public static ConsoleHost Start(out string error)
    {
        string self = Native.ModulePath();
        if (self == null)
        {
            error = "could not find the helper's own path to start the console host: " + Native.Describe(Marshal.GetLastWin32Error());
            return null;
        }
        Native.SECURITY_ATTRIBUTES inheritable = new Native.SECURITY_ATTRIBUTES();
        inheritable.nLength = Marshal.SizeOf(typeof(Native.SECURITY_ATTRIBUTES));
        inheritable.bInheritHandle = true;
        IntPtr inRead, inWrite, outRead, outWrite;
        if (!Native.CreatePipe(out inRead, out inWrite, ref inheritable, 0))
        {
            error = "could not create the console host's pipes: " + Native.Describe(Marshal.GetLastWin32Error());
            return null;
        }
        if (!Native.CreatePipe(out outRead, out outWrite, ref inheritable, 0))
        {
            error = "could not create the console host's pipes: " + Native.Describe(Marshal.GetLastWin32Error());
            Native.CloseHandle(inRead);
            Native.CloseHandle(inWrite);
            return null;
        }
        Native.PROCESS_INFORMATION info;
        try
        {
            // The helper's ends stay with the helper: the host must see its stdin end when `run` closes it.
            if (!Native.SetHandleInformation(inWrite, Native.HANDLE_FLAG_INHERIT, 0) || !Native.SetHandleInformation(outRead, Native.HANDLE_FLAG_INHERIT, 0))
                throw HelperException.LastError("could not keep the console host's pipes to the helper");
            info = RunCommand.Spawn(self, "\"" + self + "\" console", Native.CREATE_NEW_CONSOLE | Native.CREATE_NEW_PROCESS_GROUP, inRead, outWrite, outWrite);
        }
        catch (HelperException failure)
        {
            error = "could not start the console host: " + failure.Message;
            Native.CloseHandle(inWrite);
            Native.CloseHandle(outRead);
            return null;
        }
        finally
        {
            // The host's ends: once it exits, reading its answer ends too.
            Native.CloseHandle(inRead);
            Native.CloseHandle(outWrite);
        }
        Native.CloseHandle(info.hThread);
        ConsoleHost host = new ConsoleHost(info.hProcess, inWrite, info.dwProcessId);

        string answer = ReadAnswer(outRead, host);
        if (answer == "ok")
        {
            error = null;
            return host;
        }
        error = answer == null ? "the console host did not answer within " + AnswerTimeoutMs + " ms" : "the console host could not set the console to UTF-8: " + answer;
        host.Release();
        return null;
    }

    /** The host's one answer line, or null if it gave none in time (it is then ended). Closes `output`. */
    static string ReadAnswer(IntPtr output, ConsoleHost host)
    {
        string answer = null;
        Thread reader = new Thread(delegate()
        {
            try
            {
                using (FileStream stream = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(output, true), FileAccess.Read, 1))
                {
                    MemoryStream line = new MemoryStream();
                    while (line.Length < MaxAnswerBytes)
                    {
                        int next = stream.ReadByte();
                        if (next == -1 || next == '\n') break;
                        line.WriteByte((byte)next);
                    }
                    string text = Encoding.ASCII.GetString(line.ToArray());
                    answer = text.EndsWith("\r", StringComparison.Ordinal) ? text.Substring(0, text.Length - 1) : text;
                }
            }
            catch (IOException)
            {
                // The host ended without answering.
            }
        });
        reader.IsBackground = true;
        reader.Start();
        if (!reader.Join(AnswerTimeoutMs))
        {
            // Ending the host closes its end of the pipe, which ends the read.
            Native.TerminateProcess(host.process, 1);
            reader.Join(AnswerTimeoutMs);
            return null;
        }
        return answer == "" ? null : answer;
    }

    /** Lets the host go: it exits once the command is on its console, or after AttachWaitMs. */
    public void Release()
    {
        if (input != IntPtr.Zero)
        {
            Native.CloseHandle(input);
            input = IntPtr.Zero;
        }
        Native.CloseHandle(process);
    }

    /**
     * `veydr-helper console`, the host itself. It refuses a console that other processes share,
     * such as a terminal it was started from by hand, so it never changes anyone else's console.
     */
    public static int Run()
    {
        // A console event must not end the host while the helper is setting up.
        CtrlEvents.Ignore();
        string answer;
        uint[] processes = CtrlEvents.ConsoleProcesses();
        if (processes == null) answer = "it has no console of its own";
        else if (processes.Length != 1) answer = "its console is shared with " + (processes.Length - 1) + " other processes";
        else if (!Native.SetConsoleOutputCP(Utf8CodePage)) answer = "could not set the output code page: " + Native.Describe(Marshal.GetLastWin32Error());
        else answer = "ok";
        try
        {
            byte[] bytes = Encoding.ASCII.GetBytes(RunCommand.Truncate(answer, MaxAnswerBytes - 2) + "\n");
            Stream stdout = Console.OpenStandardOutput();
            stdout.Write(bytes, 0, bytes.Length);
            stdout.Flush();
        }
        catch (IOException)
        {
            return VeydrHelper.ExitFailure;
        }
        if (answer != "ok") return VeydrHelper.ExitFailure;

        // `run` closes stdin once the command is created on this console (or if it fails).
        try
        {
            Stream stdin = Console.OpenStandardInput();
            byte[] buffer = new byte[64];
            while (stdin.Read(buffer, 0, buffer.Length) > 0) { }
        }
        catch (IOException)
        {
            // A broken pipe: `run` is gone.
        }
        Stopwatch waited = Stopwatch.StartNew();
        while (waited.ElapsedMilliseconds < AttachWaitMs)
        {
            uint[] now = CtrlEvents.ConsoleProcesses();
            if (now == null || now.Length > 1) break;
            Thread.Sleep(5);
        }
        return VeydrHelper.ExitOk;
    }
}

/**
 * Console control events for the graceful steps (design D3, D4). The helper attaches to another
 * process's console, sends Ctrl+Break to every process on it, and must not be ended by its own copy.
 */
static class CtrlEvents
{
    /**
     * Most consoles one stop or `terminate` tries to attach to, so that many processes without a
     * reachable console cannot delay the forced step noticeably.
     */
    public const int MaxConsoleAttempts = 64;
    /** Most processes a console may list before it is not trusted to hold only the expected ones. */
    public const int MaxConsoleProcesses = 1 << 16;
    /**
     * How long the helper stays attached after sending Ctrl+Break, waiting for its own copy of the
     * event: once detached, the default handler would take it and end the helper (W0's probe
     * likewise stays attached for 1 s).
     */
    public const int BreakDeliveryMs = 1000;
    /** Set when IgnoreBreak has handled a Ctrl+Break, which the event sends the helper too. */
    static readonly ManualResetEvent BreakDelivered = new ManualResetEvent(false);
    /**
     * Keeps Ctrl+C and Ctrl+Break from ending the helper while it is attached to another console.
     * Held in a field so the delegate outlives the native registration. Windows calls it on a
     * thread of its own; it must not throw, as a failing handler counts as not handling the event,
     * and the default handler then ends the process.
     */
    static readonly Native.ConsoleCtrlHandler IgnoreBreak = delegate(uint ctrlType)
    {
        if (ctrlType == Native.CTRL_BREAK_EVENT) BreakDelivered.Set();
        return ctrlType == Native.CTRL_C_EVENT || ctrlType == Native.CTRL_BREAK_EVENT;
    };

    /**
     * Registers IgnoreBreak and ignores Ctrl+C (a NULL handler does not cover Ctrl+Break); `false`
     * if either fails. Attaching to or freeing a console can reset the process's control handling,
     * so this runs again after each.
     *
     * It only ever adds: removing an older registration first would leave a moment without one, and
     * removing it afterwards would remove the only one whenever the handling had been reset. A
     * second registration is harmless, since the first handler that returns TRUE ends the chain,
     * and a run adds at most a few hundred (MaxConsoleAttempts).
     */
    public static bool Ignore()
    {
        return Native.SetConsoleCtrlHandler(null, true) && Native.SetConsoleCtrlHandler(IgnoreBreak, true);
    }

    /**
     * Sends Ctrl+Break to every process on the console the helper is attached to; `false` if it
     * could not be sent. The event reaches the helper too, each process on a thread of its own, so
     * this waits (at most BreakDeliveryMs) until the helper has handled its copy before it returns
     * and the caller detaches.
     */
    public static bool SendBreak()
    {
        BreakDelivered.Reset();
        if (!Native.GenerateConsoleCtrlEvent(Native.CTRL_BREAK_EVENT, 0)) return false;
        BreakDelivered.WaitOne(BreakDeliveryMs);
        return true;
    }

    /** The PIDs on the console the helper is attached to; `null` if unreadable or more than MaxConsoleProcesses. */
    public static uint[] ConsoleProcesses()
    {
        uint[] list = new uint[64];
        while (true)
        {
            uint count = Native.GetConsoleProcessList(list, (uint)list.Length);
            if (count == 0 || count > MaxConsoleProcesses) return null;
            if (count > list.Length)
            {
                // More processes than room; ask again with enough, as the list may still grow.
                list = new uint[count + 16];
                continue;
            }
            uint[] result = new uint[count];
            Array.Copy(list, result, (int)count);
            return result;
        }
    }
}

/** A process as Veydr recorded it: its PID and creation time (design D4). */
sealed class ProcessRef
{
    public readonly uint Pid;
    public readonly long Created;

    public ProcessRef(uint pid, long created)
    {
        Pid = pid;
        Created = created;
    }
}

/**
 * `veydr-helper inspect` and `veydr-helper terminate <graceMs>`: crash recovery for processes no
 * job of Veydr holds any more (design D4). Both read the identities from stdin and report only
 * processes whose PID and creation time both still match, so a reused PID is never reported or
 * ended. A process the helper cannot open cannot be verified, and is left alone.
 */
static class SurvivorCommands
{
    /** Longest accepted stdin, and most identities in it (protocol.ts: MAX_TOOL_IDENTITIES). */
    const int MaxInputBytes = 4 * 1024 * 1024;
    const int MaxIdentities = 65536;
    static readonly Regex ItemPattern = new Regex("\\G\\{\"pid\":([1-9][0-9]{0,9}),\"created\":\"([1-9][0-9]{0,18})\"\\}", RegexOptions.CultureInvariant);
    static readonly Regex GracePattern = new Regex("^(0|[1-9][0-9]{0,9})$", RegexOptions.CultureInvariant);
    const uint ProcessTerminate = 0x1;

    /** A survivor being ended: the handle, held throughout, keeps its PID from being reused. */
    sealed class Target
    {
        public readonly ProcessRef Process;
        public readonly IntPtr Handle;
        public readonly bool CanTerminate;
        public readonly string Image;
        /** It was on a console that received Ctrl+Break. */
        public bool Signalled;

        public Target(ProcessRef process, IntPtr handle, bool canTerminate, string image)
        {
            Process = process;
            Handle = handle;
            CanTerminate = canTerminate;
            Image = image;
        }
    }

    /** `graceMs` as `terminate` takes it: a decimal from 0 to int.MaxValue, without sign or leading zeros. */
    public static bool TryParseGrace(string text, out int graceMs)
    {
        graceMs = 0;
        if (!GracePattern.IsMatch(text)) return false;
        long value = long.Parse(text, NumberStyles.None, CultureInfo.InvariantCulture);
        if (value > int.MaxValue) return false;
        graceMs = (int)value;
        return true;
    }

    /** Prints `{"type":"inspected","processes":[member...]}`: the identities that are live. */
    public static int Inspect()
    {
        try
        {
            List<ProcessRef> identities = ReadIdentities();
            uint self = Native.GetCurrentProcessId();
            List<Member> live = new List<Member>();
            foreach (ProcessRef identity in identities)
            {
                if (identity.Pid == self) continue;
                // Read-only access: inspecting never changes a process.
                IntPtr process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION | Native.SYNCHRONIZE, false, identity.Pid);
                if (process == IntPtr.Zero) continue;
                try
                {
                    if (Matches(process, identity)) live.Add(new Member(identity.Pid, (ulong)identity.Created, Native.ImagePath(process)));
                }
                finally
                {
                    Native.CloseHandle(process);
                }
            }
            WriteOut("{\"type\":\"inspected\",\"processes\":" + RunCommand.MembersJson(live) + "}");
            return VeydrHelper.ExitOk;
        }
        catch (Exception error)
        {
            return Fail(error);
        }
    }

    /**
     * Ends the identities that are live (design D4) and prints
     * `{"type":"terminated","graceful":"yes"|"no","forced":B,"survivors":[member...]}`:
     *   1. each is verified and opened, and its handle is held until the end;
     *   2. Ctrl+Break goes to each survivor's console, but only to a console on which every process
     *      apart from the helper is a verified survivor, since the event reaches all of them;
     *   3. the helper waits, until `graceMs` after the start, for the survivors that received it;
     *   4. every survivor still alive is re-verified and ended with TerminateProcess, and the
     *      helper waits up to 1 s for them to end.
     * When no event could be sent, step 3 is skipped. `graceful` is "yes" when nothing outlived step
     * 3; `forced` is true when step 4 called TerminateProcess; `survivors` are the processes still
     * alive at the end. No event is sent once `graceMs` has passed, so the helper takes at most
     * `graceMs`, one more event's delivery (BreakDeliveryMs), and the kill wait (KillWaitMs).
     */
    public static int Terminate(int graceMs)
    {
        List<Target> targets = new List<Target>();
        try
        {
            List<ProcessRef> identities = ReadIdentities();
            Stopwatch sinceStart = Stopwatch.StartNew();
            uint self = Native.GetCurrentProcessId();
            foreach (ProcessRef identity in identities)
            {
                if (identity.Pid == self) continue;
                Target target = Open(identity);
                if (target != null) targets.Add(target);
            }

            // Not graceful once anything outlived the graceful step; forced only if TerminateProcess
            // was actually called (a survivor the helper may not end is reported, not forced).
            bool graceful = true, forced = false;
            if (targets.Count > 0)
            {
                if (SendBreaks(targets, graceMs, sinceStart)) WaitForExit(targets, true, graceMs - sinceStart.ElapsedMilliseconds);
                if (AnyAlive(targets))
                {
                    graceful = false;
                    foreach (Target t in targets)
                    {
                        if (!t.CanTerminate || !Matches(t.Handle, t.Process)) continue;
                        forced = true;
                        Native.TerminateProcess(t.Handle, RunCommand.KilledExitCode);
                    }
                    if (forced) WaitForExit(targets, false, RunCommand.KillWaitMs);
                }
            }

            List<Member> survivors = new List<Member>();
            foreach (Target t in targets)
            {
                if (Matches(t.Handle, t.Process)) survivors.Add(new Member(t.Process.Pid, (ulong)t.Process.Created, t.Image));
            }
            WriteOut("{\"type\":\"terminated\",\"graceful\":\"" + (graceful ? "yes" : "no") + "\",\"forced\":" + (forced ? "true" : "false") +
                ",\"survivors\":" + RunCommand.MembersJson(survivors) + "}");
            return VeydrHelper.ExitOk;
        }
        catch (Exception error)
        {
            return Fail(error);
        }
        finally
        {
            foreach (Target t in targets) Native.CloseHandle(t.Handle);
        }
    }

    /** Opens `identity` if it is live and matches; `null` otherwise. */
    static Target Open(ProcessRef identity)
    {
        bool canTerminate = true;
        IntPtr process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION | Native.SYNCHRONIZE | ProcessTerminate, false, identity.Pid);
        if (process == IntPtr.Zero)
        {
            // It may still be verified, and is then reported as a survivor it could not end.
            canTerminate = false;
            process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION | Native.SYNCHRONIZE, false, identity.Pid);
            if (process == IntPtr.Zero) return null;
        }
        if (!Matches(process, identity))
        {
            Native.CloseHandle(process);
            return null;
        }
        return new Target(identity, process, canTerminate, Native.ImagePath(process));
    }

    /**
     * Sends Ctrl+Break to the consoles of the live targets (step 2 of Terminate); `true` if any
     * event was sent. No event is sent once `graceMs` has passed, as it could not be waited for.
     */
    static bool SendBreaks(List<Target> targets, int graceMs, Stopwatch sinceStart)
    {
        if (!CtrlEvents.Ignore()) return false;
        // The helper's own console: AttachConsole refuses a second one, and it is never needed back.
        Native.FreeConsole();
        CtrlEvents.Ignore();

        Dictionary<uint, Target> byPid = new Dictionary<uint, Target>();
        foreach (Target t in targets) byPid[t.Process.Pid] = t;
        uint self = Native.GetCurrentProcessId();
        List<IntPtr> triedConsoles = new List<IntPtr>();
        bool sent = false;
        int attempts = 0;
        foreach (Target target in targets)
        {
            if (sinceStart.ElapsedMilliseconds >= graceMs) break;
            if (target.Signalled || !IsAlive(target.Handle)) continue;
            if (attempts++ == CtrlEvents.MaxConsoleAttempts) break;
            // The handle keeps the PID from being reused, so this is the verified process's console.
            if (!Native.AttachConsole(target.Process.Pid))
            {
                CtrlEvents.Ignore();
                continue;
            }
            try
            {
                if (!CtrlEvents.Ignore()) return sent;
                IntPtr window = Native.GetConsoleWindow();
                // A console seen before was already handled; one without a window is checked again.
                if (window != IntPtr.Zero)
                {
                    if (triedConsoles.Contains(window)) continue;
                    triedConsoles.Add(window);
                }
                List<Target> onConsole = TargetsOnConsole(byPid, self);
                if (onConsole == null) continue;
                if (CtrlEvents.SendBreak())
                {
                    sent = true;
                    foreach (Target t in onConsole) t.Signalled = true;
                }
            }
            finally
            {
                Native.FreeConsole();
                CtrlEvents.Ignore();
            }
        }
        return sent;
    }

    /**
     * The targets on the attached console, if every process on it apart from the helper is a live
     * target and there is at least one; `null` otherwise. A target's handle keeps its PID from being
     * reused, so a PID on the console that names a live target is that target.
     */
    static List<Target> TargetsOnConsole(Dictionary<uint, Target> byPid, uint self)
    {
        uint[] list = CtrlEvents.ConsoleProcesses();
        if (list == null) return null;
        List<Target> found = new List<Target>();
        foreach (uint pid in list)
        {
            if (pid == self) continue;
            Target target;
            if (!byPid.TryGetValue(pid, out target) || !IsAlive(target.Handle)) return null;
            found.Add(target);
        }
        return found.Count > 0 ? found : null;
    }

    /** Waits up to `timeoutMs` until no target (only the signalled ones with `signalledOnly`) is alive. */
    static void WaitForExit(List<Target> targets, bool signalledOnly, long timeoutMs)
    {
        Stopwatch elapsed = Stopwatch.StartNew();
        while (true)
        {
            bool waiting = false;
            foreach (Target t in targets)
            {
                if ((!signalledOnly || t.Signalled) && IsAlive(t.Handle))
                {
                    waiting = true;
                    break;
                }
            }
            long left = timeoutMs - elapsed.ElapsedMilliseconds;
            if (!waiting || left <= 0) return;
            Thread.Sleep((int)Math.Min(left, 50));
        }
    }

    static bool AnyAlive(List<Target> targets)
    {
        foreach (Target t in targets)
        {
            if (IsAlive(t.Handle)) return true;
        }
        return false;
    }

    static bool IsAlive(IntPtr process)
    {
        return Native.WaitForSingleObject(process, 0) == Native.WaitTimeout;
    }

    /** Whether `process` is alive and was created at `identity`'s creation time. */
    static bool Matches(IntPtr process, ProcessRef identity)
    {
        if (!IsAlive(process)) return false;
        long creation, exit, kernel, user;
        return Native.GetProcessTimes(process, out creation, out exit, out kernel, out user) && creation == identity.Created;
    }

    /**
     * The identities on stdin: one line holding a JSON array of `{"pid":P,"created":"C"}`, in
     * exactly the form protocol.ts encodes, at most MaxIdentities of them. Duplicates count once.
     * The line is ASCII; anything else, a UTF-8 byte order mark included, is refused.
     */
    static List<ProcessRef> ReadIdentities()
    {
        Stream stdin = Console.OpenStandardInput();
        MemoryStream input = new MemoryStream();
        byte[] buffer = new byte[65536];
        while (true)
        {
            int read = stdin.Read(buffer, 0, buffer.Length);
            if (read == 0) break;
            if (input.Length + read > MaxInputBytes) throw new HelperException("the identities on stdin exceed " + MaxInputBytes + " bytes");
            input.Write(buffer, 0, read);
        }
        // Anything outside ASCII becomes '?', which no identity contains.
        string text = Encoding.ASCII.GetString(input.GetBuffer(), 0, (int)input.Length);
        if (text.EndsWith("\n", StringComparison.Ordinal)) text = text.Substring(0, text.Length - 1);
        if (text.EndsWith("\r", StringComparison.Ordinal)) text = text.Substring(0, text.Length - 1);
        if (text.Length < 2 || text[0] != '[' || text[text.Length - 1] != ']') throw new HelperException("stdin does not hold one line with a list of identities");

        List<ProcessRef> identities = new List<ProcessRef>();
        Dictionary<string, bool> seen = new Dictionary<string, bool>(StringComparer.Ordinal);
        int at = 1, end = text.Length - 1;
        while (at < end)
        {
            Match item = ItemPattern.Match(text, at);
            if (!item.Success || item.Index != at) throw new HelperException("stdin holds a malformed identity at offset " + at);
            at += item.Length;
            if (at < end)
            {
                if (text[at] != ',' || at + 1 == end) throw new HelperException("stdin holds a malformed identity list at offset " + at);
                at++;
            }
            ulong pid;
            long created;
            if (!ulong.TryParse(item.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out pid) || pid > uint.MaxValue ||
                !long.TryParse(item.Groups[2].Value, NumberStyles.None, CultureInfo.InvariantCulture, out created))
                throw new HelperException("stdin holds an identity out of range: " + RunCommand.Truncate(item.Value, 200));
            if (seen.ContainsKey(item.Value)) continue;
            if (identities.Count == MaxIdentities) throw new HelperException("stdin holds more than " + MaxIdentities + " identities");
            seen.Add(item.Value, true);
            identities.Add(new ProcessRef((uint)pid, created));
        }
        return identities;
    }

    /** Writes the one output line as ASCII bytes, independent of any console code page. */
    static void WriteOut(string line)
    {
        byte[] bytes = Encoding.ASCII.GetBytes(line + "\n");
        Stream stdout = Console.OpenStandardOutput();
        stdout.Write(bytes, 0, bytes.Length);
        stdout.Flush();
    }

    static int Fail(Exception error)
    {
        string message = error is HelperException ? error.Message : "unexpected failure: " + error.Message;
        try
        {
            byte[] bytes = Encoding.UTF8.GetBytes("veydr-helper: " + RunCommand.Truncate(message, 4000) + "\n");
            Stream stderr = Console.OpenStandardError();
            stderr.Write(bytes, 0, bytes.Length);
            stderr.Flush();
        }
        catch (IOException)
        {
            // Nobody reads stderr any more; the exit code still reports the failure.
        }
        return VeydrHelper.ExitFailure;
    }
}

/** Just enough JSON for the protocol's lines, as ASCII: everything else is escaped. */
static class Json
{
    public static string Number(ulong value)
    {
        return value.ToString(CultureInfo.InvariantCulture);
    }

    public static string Quote(string text)
    {
        StringBuilder json = new StringBuilder(text.Length + 2);
        json.Append('"');
        foreach (char c in text)
        {
            if (c == '"') json.Append("\\\"");
            else if (c == '\\') json.Append("\\\\");
            else if (c >= 0x20 && c < 0x7f) json.Append(c);
            // Control characters, non-ASCII, and unpaired surrogates alike.
            else json.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
        }
        return json.Append('"').ToString();
    }
}

static class Native
{
    public const uint Infinite = 0xFFFFFFFF;
    public const uint WaitObject0 = 0, WaitTimeout = 0x102;
    public static readonly IntPtr InvalidHandle = new IntPtr(-1);
    public const int ERROR_MORE_DATA = 234;

    public const uint CREATE_SUSPENDED = 0x4, CREATE_NEW_CONSOLE = 0x10, CREATE_NEW_PROCESS_GROUP = 0x200;
    public const uint CREATE_UNICODE_ENVIRONMENT = 0x400, EXTENDED_STARTUPINFO_PRESENT = 0x80000;
    public const int STARTF_USESHOWWINDOW = 0x1, STARTF_USESTDHANDLES = 0x100;
    public const short SW_HIDE = 0;
    public const int PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002;
    public const int STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12;
    public const uint HANDLE_FLAG_INHERIT = 0x1;
    public const uint GENERIC_READ = 0x80000000, FILE_SHARE_READ = 0x1, FILE_SHARE_WRITE = 0x2, OPEN_EXISTING = 3;
    public const uint FILE_TYPE_CHAR = 0x2;
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, SYNCHRONIZE = 0x100000;

    public const int JobObjectBasicAccountingInformation = 1, JobObjectBasicProcessIdList = 3;
    public const int JobObjectAssociateCompletionPortInformation = 7, JobObjectExtendedLimitInformation = 9;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    public const uint JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO = 4, JOB_OBJECT_MSG_NEW_PROCESS = 6;
    public const uint JOB_OBJECT_MSG_EXIT_PROCESS = 7, JOB_OBJECT_MSG_ABNORMAL_EXIT_PROCESS = 8;
    public const uint CTRL_C_EVENT = 0, CTRL_BREAK_EVENT = 1;

    /** A console control handler: `true` if it handled `ctrlType`. */
    public delegate bool ConsoleCtrlHandler(uint ctrlType);

    // Interop structures: their fields are written by Windows, not by this code.
#pragma warning disable 0649, 0169
    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_ASSOCIATE_COMPLETION_PORT
    {
        public IntPtr CompletionKey, CompletionPort;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr ExitStatus, PebBaseAddress;
        public UIntPtr AffinityMask;
        public IntPtr BasePriority;
        public UIntPtr UniqueProcessId, InheritedFromUniqueProcessId;
    }
#pragma warning restore 0649, 0169

    [DllImport("kernel32.dll")] public static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] public static extern IntPtr GetCommandLineW();
    [DllImport("shell32.dll", SetLastError = true)] public static extern IntPtr CommandLineToArgvW(IntPtr commandLine, out int count);
    [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("ntdll.dll")]
    public static extern int NtQueryInformationProcess(IntPtr process, int infoClass, out PROCESS_BASIC_INFORMATION info, int length, out int returnLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetNamedPipeServerProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint serverProcessId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_ASSOCIATE_COMPLETION_PORT info, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, int length, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existingPort, UIntPtr key, uint threads);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetQueuedCompletionStatus(IntPtr port, out uint bytes, out UIntPtr key, out IntPtr overlapped, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint GetFileType(IntPtr file);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);
    [DllImport("kernel32.dll")] public static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
        uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint processId);
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint GetConsoleProcessList([Out] uint[] processList, uint processCount);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleOutputCP(uint codePage);
    [DllImport("kernel32.dll")] public static extern uint GetACP();
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, ref SECURITY_ATTRIBUTES attributes, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetModuleFileName(IntPtr module, StringBuilder name, int size);

    /** A Win32 error as "<system message> (error <code>)". */
    public static string Describe(int code)
    {
        return new Win32Exception(code).Message + " (error " + code.ToString(CultureInfo.InvariantCulture) + ")";
    }

    /** The helper's arguments, split by CommandLineToArgvW: the rules libuv quotes them by. */
    public static string[] CommandLineArguments()
    {
        int count;
        IntPtr argv = CommandLineToArgvW(GetCommandLineW(), out count);
        if (argv == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            // argv[0] is the helper itself.
            string[] args = new string[Math.Max(count - 1, 0)];
            for (int i = 1; i < count; i++) args[i - 1] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size));
            return args;
        }
        finally
        {
            LocalFree(argv);
        }
    }

    /** The full path of the helper's own executable, or null if it cannot be read. */
    public static string ModulePath()
    {
        StringBuilder name = new StringBuilder(32768);
        uint length = GetModuleFileName(IntPtr.Zero, name, name.Capacity);
        return length == 0 || length >= name.Capacity ? null : name.ToString(0, (int)length);
    }

    /** The PID of the process that created this one. */
    public static uint ParentProcessId()
    {
        PROCESS_BASIC_INFORMATION info;
        int length;
        int status = NtQueryInformationProcess(GetCurrentProcess(), 0, out info, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out length);
        if (status != 0) throw new HelperException("could not identify the helper's parent process (status 0x" + status.ToString("x8", CultureInfo.InvariantCulture) + ")");
        return (uint)info.InheritedFromUniqueProcessId.ToUInt64();
    }

    /** The full image path of `process`, or "" if it cannot be read. */
    public static string ImagePath(IntPtr process)
    {
        StringBuilder name = new StringBuilder(32768);
        int size = name.Capacity;
        return QueryFullProcessImageName(process, 0, name, ref size) ? name.ToString(0, size) : "";
    }
}
